"""Voice gate: tell the enrolled user's voice apart from other voices.

Claude Code reads the microphone itself, so this does not filter what it
hears. It listens to the same microphone alongside it, cuts speech into
segments, and records for each one whether it was the enrolled voice. The
focus-queue listener reads those verdicts before it sends a dictation, so
speech from other people is erased instead of being sent as an instruction.
Nothing here delays recording or transcription.

  voicegate.py enroll [seconds]   record the user's voice and save a voiceprint
  voicegate.py serve              write a verdict for every speech segment
  voicegate.py tail               print verdicts live (for calibration)

Each microphone is enrolled once with `enroll`, alone in a quiet room.
`serve` never starts a voiceprint by itself: learning from whatever was sent
would let a laptop mic learn a conversation nearby as the user. After
enrollment it keeps the voiceprint up to date. The listener marks the time
span of every dictation that was actually sent in voice-confirmed.jsonl;
speech in those spans that already scores POOL_SCORE goes into a pool, and
the voiceprint is rebuilt from it. Speech that does not sound like the user
is dropped from the pool on every rebuild. The judging
threshold may rise a little (up to MAX_THRESHOLD) once ADAPT_SCORES confirmed
segments, scored by the voiceprint before it learned them, all sit well above
it; pooling itself always uses POOL_SCORE, so the two cannot ratchet.

Runs in its own environment (numpy, sounddevice, sherpa-onnx), set up by
`focusq voice-setup`. The voiceprint stays on this machine; no audio is kept.
Enrollment also writes this person's microphone into voice.local.json
(voice_settings.py): its speech level and detector gain, and, for a headset,
permission to send dictation on its own.
"""
import json
import os
import queue
import subprocess
import sys
import time

import numpy as np
import sherpa_onnx
import sounddevice

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_settings  # noqa: E402

SETTINGS = voice_settings.load()

HOME = os.path.expanduser("~/.local/share/herdr-focus-queue")
MODELS = os.path.join(HOME, "models")
EMBEDDING_MODEL = os.path.join(MODELS, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx")
VAD_MODEL = os.path.join(MODELS, "silero_vad.onnx")
STATE_DIR = os.environ.get("HERDR_PLUGIN_STATE_DIR") or os.path.expanduser(
    "~/.local/state/herdr/plugins/local.focus-queue")
VOICEPRINT = os.path.join(STATE_DIR, "voiceprint.json")
SEGMENTS = os.path.join(STATE_DIR, "voice-segments.jsonl")
PIDFILE = os.path.join(STATE_DIR, "voicegate.pid")
SPEAKING = os.path.join(STATE_DIR, "voice-speaking")  # touched while someone is talking
CONFIRMED = os.path.join(STATE_DIR, "voice-confirmed.jsonl")
POOL = os.path.join(STATE_DIR, "voice-pool.jsonl")
LEARN_SECONDS = 30  # confirmed speech needed before the voiceprint is used
POOL_SECONDS = 600  # the most recent confirmed speech; 1800 made each rebuild ~0.1 s, delaying the next verdict
ADAPT_SCORES = 30  # held-out scores of confirmed speech needed before the threshold moves
MAX_THRESHOLD = SETTINGS["max_threshold"]  # going higher mostly loses the user's own speech
RATE = 16000
# Below this length a segment's embedding is too unreliable to judge
# (tested: 0.8 s clips of the enrolled speaker overlapped other speakers).
MIN_JUDGE_SECONDS = 1.0
REOPEN_SECONDS = 60
STREAM_TIMEOUT = 5  # seconds without real audio before the stream counts as dead
DEFAULT_THRESHOLD = SETTINGS["default_threshold"]
# Confirmed speech is learned only above this: other voices can score close to
# the judging threshold, and a sent dictation can hold them.
POOL_SCORE = SETTINGS["pool_score"]
# Claude Code transcribes speech too quiet for Silero's defaults, and what the
# gate never hears it cannot judge, so the detector is more sensitive than
# Silero's default and hears the input amplified.
VAD_THRESHOLD = SETTINGS["vad_threshold"]
VAD_GAIN = SETTINGS["vad_gain"]  # only the VAD sees this; segments are scaled back before embedding
DEVICE = ""  # key of the microphone in use (voice_settings.device_key)
# Enrollment sets the gain so the user's speech reaches the detector at about
# this level (dBFS); 1..MAX_GAIN keeps a very quiet or loud mic in range.
TARGET_SPEECH_DB = -19.0
MAX_GAIN = 30.0

SENTENCES = [
    "로그인 화면에서 오류가 나는 원인을 찾아 줘.",
    "회신 문서에서 결제 부분을 다시 확인하고 정리해 줘.",
    "지금 포커스된 패널에서 녹음이 늦게 뜨는지 확인해 봐.",
    "테스트를 돌려 보고 실패한 항목만 알려 줘.",
    "견적서 질의사항을 항목별로 검토해서 정리해 줘.",
    "변경 사항을 커밋하고 결과를 알려 줘.",
    "팀에 보낼 메시지는 짧게 핵심만 정리해 줘.",
    "배포 전에 로컬 CI가 통과하는지 먼저 확인해.",
]


def extractor():
    return sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMBEDDING_MODEL, num_threads=2))


def vad():
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = VAD_MODEL
    config.silero_vad.threshold = VAD_THRESHOLD
    config.silero_vad.min_silence_duration = 0.3
    config.silero_vad.min_speech_duration = 0.25
    config.sample_rate = RATE
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)


def embed(model, samples):
    stream = model.create_stream()
    stream.accept_waveform(RATE, samples)
    stream.input_finished()
    vector = np.array(model.compute(stream))
    return vector / np.linalg.norm(vector)


def use_device_files():
    """Each microphone keeps its own voiceprint: the same voice scored 0.7 on a
    headset and 0.1 on a laptop mic, so a voiceprint says nothing about another
    device. voiceprint.json links to the current one, and dangles (reads as not
    yet learned, so dictations send and teach it) until this device has one."""
    global VOICEPRINT, POOL, DEVICE, VAD_GAIN
    name = voice_settings.device_key(sounddevice.query_devices(kind="input")["name"])
    DEVICE = name
    gain = voice_settings.load()["devices"].get(name, {}).get("vad_gain")
    VAD_GAIN = float(gain) if isinstance(gain, (int, float)) and gain > 0 else SETTINGS["vad_gain"]
    active, legacy_pool = os.path.join(STATE_DIR, "voiceprint.json"), os.path.join(STATE_DIR, "voice-pool.jsonl")
    VOICEPRINT = os.path.join(STATE_DIR, f"voiceprint-{name}.json")
    device_pool = os.path.join(STATE_DIR, f"voice-pool-{name}.jsonl")
    if os.path.exists(active) and not os.path.islink(active):  # from before per-device files
        os.replace(active, VOICEPRINT)
        if os.path.exists(legacy_pool):
            os.replace(legacy_pool, device_pool)
    POOL = device_pool
    if os.path.lexists(active):
        os.remove(active)
    os.symlink(os.path.basename(VOICEPRINT), active)


def default_input():
    """Asked in a new process: this one keeps the device list from its start."""
    return subprocess.run([sys.executable, "-c", "import sounddevice;"
                           "print(sounddevice.query_devices(kind='input')['name'])"],
                          capture_output=True, text=True).stdout.strip()


def microphone(reopen=False):
    """Yield 32 ms blocks of 16 kHz mono audio from the default input. With
    reopen, follow the default input instead of ending when it goes away: the
    macOS microphone grant belongs to this process's launch context, and a gate
    restarted from the focus-queue listener can get only zeros."""
    while True:
        blocks = queue.Queue()
        silent = 0
        device, checked = default_input() if reopen else None, time.time()
        with sounddevice.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=512,
                                     callback=lambda data, *_: blocks.put(data[:, 0].copy())):
            while True:
                try:
                    block = blocks.get(timeout=STREAM_TIMEOUT)
                except queue.Empty:
                    break
                # A stream left on a device that went away (a headset switched
                # off, sleep) stalls or reads pure zeros.
                silent = 0 if block.any() else silent + 1
                if silent * 512 / RATE >= STREAM_TIMEOUT:
                    break
                # The stream stays on the device it opened, so check the
                # default input in quiet moments.
                if reopen and time.time() - max(checked, last_speech()) >= REOPEN_SECONDS:
                    checked = time.time()
                    if default_input() != device:
                        break
                yield block
        if not reopen:
            sys.exit("microphone stopped")
        # PortAudio keeps the device list from its start, so restart it.
        sounddevice._terminate()
        sounddevice._initialize()
        use_device_files()


def segments(detector, source, speaking=None):
    """Yield (end_time, samples) for each speech segment. speaking() is
    called for every block heard mid-speech, before the segment ends."""
    for block in source:
        detector.accept_waveform(block * VAD_GAIN)
        if speaking and detector.is_speech_detected():
            speaking()
        while not detector.empty():
            yield time.time(), np.array(detector.front.samples, dtype="float32") / VAD_GAIN
            detector.pop()


def last_speech():
    try:
        return os.path.getmtime(SPEAKING)
    except OSError:
        return 0


def build(vectors, weights):
    """Voiceprint of the voice heard most: start from the segment most others
    agree with (so another voice picked up now and then cannot pull the
    average towards itself), average the segments close to it, repeat."""
    vectors, weights = np.array(vectors), np.array(weights, dtype=float)
    close = (vectors @ vectors.T) >= DEFAULT_THRESHOLD
    centre = vectors[int(np.argmax(close.sum(axis=1)))]
    for _ in range(3):
        kept = vectors @ centre >= DEFAULT_THRESHOLD
        centre = np.average(vectors[kept], axis=0, weights=weights[kept])
        centre /= np.linalg.norm(centre)
    return centre


def adapted_threshold(held_out, previous):
    """Just below the user's low scores (5th percentile) within
    DEFAULT_THRESHOLD..MAX_THRESHOLD. held_out are scores of confirmed speech
    taken before the voiceprint learned it, so they show how the user really
    scores; every confirmed segment counts, so a low one keeps it at the
    default. "threshold_pinned": true in voiceprint.json keeps a hand-set value."""
    if previous.get("threshold_pinned"):
        return previous["threshold"]
    if len(held_out) < ADAPT_SCORES:
        return DEFAULT_THRESHOLD
    return round(min(MAX_THRESHOLD, max(DEFAULT_THRESHOLD, float(np.percentile(held_out, 5)) - 0.05)), 3)


def save_voiceprint(centre, vectors, speech_seconds, held_out=()):
    scores = sorted(float(v @ centre) for v in vectors if v @ centre >= DEFAULT_THRESHOLD)
    previous = {}
    if os.path.exists(VOICEPRINT):
        with open(VOICEPRINT) as handle:
            previous = json.load(handle)
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(VOICEPRINT + ".tmp", "w") as handle:
        json.dump({"vector": centre.tolist(), "model": os.path.basename(EMBEDDING_MODEL),
                   "speech_seconds": round(speech_seconds, 1),
                   "threshold": adapted_threshold(list(held_out), previous),
                   "held_out_scores": [round(x, 3) for x in held_out],
                   "threshold_pinned": bool(previous.get("threshold_pinned")),
                   "created": time.strftime("%Y-%m-%d %H:%M:%S")}, handle)
    os.replace(VOICEPRINT + ".tmp", VOICEPRINT)
    return scores


def enroll(seconds):
    use_device_files()
    model, detector = extractor(), vad()
    print(f"{seconds}초 동안 평소처럼 말해 주세요. 아래 문장을 읽어도 되고 아무 말이나 해도 됩니다.\n")
    for sentence in SENTENCES:
        print("  " + sentence)
    print("\n녹음 시작")
    speech, deadline = [], time.time() + seconds
    for end, samples in segments(detector, microphone()):
        speech.append(samples)
        print(f"  말 {len(samples) / RATE:.1f}초 (누적 {sum(len(s) for s in speech) / RATE:.0f}초)")
        if time.time() >= deadline:
            break
    total = sum(len(s) for s in speech) / RATE
    if total < 15:
        sys.exit(f"말소리가 {total:.0f}초밖에 잡히지 않았습니다. 15초 이상 말해 주세요.")
    vectors = [embed(model, s) for s in speech if len(s) / RATE >= MIN_JUDGE_SECONDS]
    weights = [len(s) for s in speech if len(s) / RATE >= MIN_JUDGE_SECONDS]
    centre = build(vectors, weights)
    print(f"다른 목소리로 보고 뺀 구간 {sum(1 for v in vectors if v @ centre < DEFAULT_THRESHOLD)}개")
    self_scores = save_voiceprint(centre, vectors, total)
    with open(POOL, "w") as handle:  # later confirmed speech adds to this
        for vector, weight in zip(vectors, weights):
            handle.write(json.dumps({"end": time.time(), "seconds": weight / RATE,
                                     "vector": [round(x, 5) for x in vector.tolist()]}) + "\n")
    print(f"\n저장: {VOICEPRINT}")
    print(f"말소리 {total:.0f}초, 구간 {len(vectors)}개, 본인 점수 최저 {self_scores[0]:.2f} / 중간 "
          f"{self_scores[len(self_scores) // 2]:.2f} (기준 {DEFAULT_THRESHOLD})")
    name = sounddevice.query_devices(kind="input")["name"]
    levels = [20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-9) for s in speech]
    speech_db, gain, headset = calibrate(name, levels)
    print(f"마이크 보정: 말소리 {speech_db:.0f} dBFS, 감지 증폭 {gain}배 → {voice_settings.path()}")
    print("이 마이크의 받아쓰기는 자동 전송합니다." if headset else
          "내장 마이크는 주변 말까지 들어 자동 전송하지 않습니다. 쓰려면 위 파일의 auto_send_devices 에 이름을 넣으세요.")


def load_voiceprint():
    """The voiceprint and its threshold. A threshold set for this microphone in
    voice.local.json wins over the voiceprint's own."""
    with open(VOICEPRINT) as handle:
        data = json.load(handle)
    pinned = voice_settings.device_threshold(DEVICE) if DEVICE else None
    return np.array(data["vector"]), pinned if pinned is not None else float(data.get("threshold", DEFAULT_THRESHOLD))


def builtin_input():
    """Whether macOS's default input is built into the Mac (it hears the room)."""
    try:
        result = subprocess.run(["/usr/sbin/system_profiler", "-json", "SPAudioDataType"],
                                capture_output=True, text=True, timeout=10)
        devices = [item for section in json.loads(result.stdout).get("SPAudioDataType", [])
                   for item in section.get("_items", [])]
    except (OSError, ValueError, subprocess.SubprocessError):
        return True  # cannot tell: do not allow auto-send
    current = next((d for d in devices if d.get("coreaudio_default_audio_input_device") == "spaudio_yes"), {})
    return current.get("coreaudio_device_transport") in (None, "coreaudio_device_type_builtin")


def calibrate(name, levels):
    """Store this microphone's speech level and detector gain, and allow a
    headset to send dictation on its own. levels are dBFS of enrolled speech."""
    speech_db = float(np.median(levels))
    gain = round(float(np.clip(10 ** ((TARGET_SPEECH_DB - speech_db) / 20), 1.0, MAX_GAIN)), 2)
    key, headset = voice_settings.device_key(name), not builtin_input()

    def change(data):
        devices = data.setdefault("devices", {})
        devices[key] = {**devices.get(key, {}), "speech_db": round(speech_db, 1), "vad_gain": gain}
        allowed = data.setdefault("auto_send_devices", [])
        if headset and not any(item.lower() in name.lower() for item in allowed):
            allowed.append(name)
    voice_settings.update(change)
    return speech_db, gain, headset


def judge(model, voiceprint, threshold, samples):
    duration = len(samples) / RATE
    score = float(embed(model, samples) @ voiceprint)
    me = None if duration < MIN_JUDGE_SECONDS else score >= threshold
    return duration, score, me


class Learner:
    """Moves the voiceprints of confirmed speech into the pool and rebuilds
    the voiceprint from it."""

    def __init__(self):
        self.recent = []  # (start, end, seconds, vector) of judgeable segments
        self.offset = 0
        self.added = 0
        self.held_out = []  # scores of confirmed segments by the voiceprint before it learned them
        if os.path.exists(VOICEPRINT):
            with open(VOICEPRINT) as handle:
                self.held_out = json.load(handle).get("held_out_scores", [])

    def heard(self, start, end, seconds, vector):
        if seconds >= MIN_JUDGE_SECONDS:
            self.recent = [r for r in self.recent if r[1] > end - 300] + [(start, end, seconds, vector)]

    def confirm(self, voiceprint):
        try:
            with open(CONFIRMED) as handle:
                handle.seek(self.offset)
                spans = [json.loads(line) for line in handle]
                self.offset = handle.tell()
        except OSError:
            return False
        if voiceprint is None:  # only enroll starts one
            self.recent = []
            return False
        for span in spans:
            for start, end, seconds, vector in self.recent:
                if not (start >= span["start"] - 1 and end <= span["end"] + 1):
                    continue
                self.held_out = (self.held_out + [float(vector @ voiceprint)])[-200:]
                # Only segments that already sound like the user, at a fixed
                # score: pooling what clears the adapted threshold would raise
                # it a little on every rebuild.
                if vector @ voiceprint >= POOL_SCORE:
                    with open(POOL, "a") as handle:
                        handle.write(json.dumps({"end": end, "seconds": seconds,
                                                 "vector": [round(x, 5) for x in vector.tolist()]}) + "\n")
                    self.added += 1
            self.recent = [r for r in self.recent if r[1] > span["end"] + 1]
        if not self.added:
            return False
        pool = [json.loads(line) for line in open(POOL)]
        total, kept = 0, []
        for item in reversed(pool):  # newest first, up to POOL_SECONDS
            if total >= POOL_SECONDS:
                break
            kept.append(item)
            total += item["seconds"]
        if total < LEARN_SECONDS or (voiceprint is not None and self.added < 5):
            return False
        vectors = [np.array(item["vector"]) for item in kept]
        centre = build(vectors, [item["seconds"] for item in kept])
        # Drop speech that does not sound like the user (another voice that got
        # in before there was a voiceprint), so it stops counting.
        mine = [(item, v) for item, v in zip(kept, vectors) if v @ centre >= DEFAULT_THRESHOLD]
        with open(POOL, "w") as handle:
            handle.writelines(json.dumps(item) + "\n" for item, _ in reversed(mine))
        save_voiceprint(centre, [v for _, v in mine], sum(item["seconds"] for item, _ in mine), self.held_out)
        self.added = 0
        return True


def serve():
    try:
        os.kill(int(open(PIDFILE).read()), 0)
        return  # already serving
    except (OSError, ValueError):
        pass
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(PIDFILE, "w") as handle:
        handle.write(str(os.getpid()))
    use_device_files()
    model, detector, learner = extractor(), vad(), Learner()
    voiceprint, threshold = load_voiceprint() if os.path.exists(VOICEPRINT) else (None, DEFAULT_THRESHOLD)
    if os.path.exists(CONFIRMED):
        learner.offset = os.path.getsize(CONFIRMED)
    written, loaded = 0, VOICEPRINT
    try:
        # A segment is only reported once it ends, so a long utterance looks
        # like silence until then; the listener reads this file's mtime to
        # know the user is still talking.
        open(SPEAKING, "a").close()
        for end, samples in segments(detector, microphone(reopen=True), lambda: os.utime(SPEAKING)):
            if VOICEPRINT != loaded:  # the default input changed
                loaded = VOICEPRINT
                voiceprint, threshold = load_voiceprint() if os.path.exists(VOICEPRINT) else (None, DEFAULT_THRESHOLD)
                # Speech still pending belongs to the old microphone; carried
                # over it would open the new one's pool before it exists and
                # stop the gate.
                learner = Learner()
                learner.offset = os.path.getsize(CONFIRMED) if os.path.exists(CONFIRMED) else 0
            duration = len(samples) / RATE
            vector = embed(model, samples)
            learner.heard(end - duration, end, duration, vector)
            if learner.confirm(voiceprint):
                voiceprint, threshold = load_voiceprint()
            score = None if voiceprint is None else float(vector @ voiceprint)
            me = None if score is None or duration < MIN_JUDGE_SECONDS else score >= threshold
            line = {"start": round(end - duration, 3), "end": round(end, 3), "seconds": round(duration, 2),
                    "score": None if score is None else round(score, 3), "me": me,
                    "db": round(float(20 * np.log10(np.sqrt(np.mean(samples ** 2)) + 1e-9)), 1)}
            with open(SEGMENTS, "a") as handle:
                handle.write(json.dumps(line) + "\n")
            written += 1
            if written % 200 == 0:  # keep the file short
                lines = open(SEGMENTS).readlines()[-200:]
                open(SEGMENTS, "w").writelines(lines)
    finally:
        if open(PIDFILE).read() == str(os.getpid()):  # a newer gate may have taken over
            os.remove(PIDFILE)


def tail():
    use_device_files()
    model, detector = extractor(), vad()
    voiceprint, threshold = load_voiceprint()
    print(f"기준 {threshold}. 말하면 구간마다 점수를 보여 줍니다 (Ctrl+C 종료)")
    for end, samples in segments(detector, microphone()):
        started = time.perf_counter()
        duration, score, me = judge(model, voiceprint, threshold, samples)
        verdict = "판단 보류(짧음)" if me is None else ("본인" if me else "다른 사람")
        print(f"{time.strftime('%H:%M:%S')}  {duration:4.1f}초  점수 {score:5.2f}  {verdict}"
              f"  (판정 {1000 * (time.perf_counter() - started):.0f}ms)")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "enroll":
        enroll(int(sys.argv[2]) if len(sys.argv) > 2 else 45)
    elif command == "serve":
        serve()
    elif command == "tail":
        tail()
    else:
        sys.exit(__doc__)
