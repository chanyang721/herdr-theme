"""Would your voice pass on someone else's Mac?

Builds a fresh, empty device for each of several real speakers from public
speaker-recognition clips (csukuangfj/sr-data), learns that speaker's voice
the same way `voicegate.py enroll` does, then judges your own voice (the
speech already learned on this Mac, voice-pool.jsonl) on that device.
Every row should show 0 of your segments passing.

Run through `./focusq voice-crosscheck`. Clips are cached in
~/.local/share/herdr-focus-queue/crosscheck; nothing is written to your
own voice state.
"""
import importlib.util
import json
import os
import sys
import tempfile
import urllib.request
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CACHE = os.path.expanduser("~/.local/share/herdr-focus-queue/crosscheck")
SOURCE = "https://raw.githubusercontent.com/csukuangfj/sr-data/main/"
# speaker: (clips to learn from, clips to check the speaker still passes)
SPEAKERS = {
    "fangjun": (["enroll/fangjun-sr-1", "enroll/fangjun-sr-2", "enroll/fangjun-sr-3"],
                ["test/fangjun-test-sr-1", "test/fangjun-test-sr-2"]),
    "leijun": (["enroll/leijun-sr-1", "enroll/leijun-sr-2"],
               ["test/leijun-test-sr-1", "test/leijun-test-sr-2", "test/leijun-test-sr-3"]),
    "liudehua": (["enroll/liudehua-sr-1", "enroll/liudehua-sr-2"],
                 ["test/liudehua-test-sr-1", "test/liudehua-test-sr-2"]),
    "speaker1": (["test/3d-speaker/speaker1_a_cn_16k", "test/3d-speaker/speaker1_a_en_16k"],
                 ["test/3d-speaker/speaker1_b_cn_16k", "test/3d-speaker/speaker1_b_en_16k"]),
    "speaker2": (["test/3d-speaker/speaker2_a_cn_16k"], ["test/3d-speaker/speaker2_a_en_16k"]),
}


def voicegate(state_dir):
    """A copy of voicegate.py whose state lives in state_dir (an empty device)."""
    os.environ["HERDR_PLUGIN_STATE_DIR"] = state_dir
    spec = importlib.util.spec_from_file_location("voicegate", os.path.join(ROOT, "voicegate.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clip(name):
    path = os.path.join(CACHE, name.replace("/", "_") + ".wav")
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        urllib.request.urlretrieve(SOURCE + name + ".wav", path + ".part")
        os.replace(path + ".part", path)
    with wave.open(path) as handle:
        if handle.getframerate() != 16000 or handle.getnchannels() != 1:
            sys.exit(f"unexpected format: {path}")
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype("float32") / 32768


def segments(gate, model, samples):
    """(seconds, voiceprint) for each judgeable speech segment, as serve() cuts them."""
    detector, found = gate.vad(), []
    for i in range(0, len(samples), 512):
        detector.accept_waveform(samples[i:i + 512])
        while not detector.empty():
            found.append(np.array(detector.front.samples, dtype="float32"))
            detector.pop()
    detector.flush()
    while not detector.empty():
        found.append(np.array(detector.front.samples, dtype="float32"))
        detector.pop()
    return [(len(s) / gate.RATE, gate.embed(model, s)) for s in found if len(s) / gate.RATE >= gate.MIN_JUDGE_SECONDS]


def main():
    # Read before voicegate() points HERDR_PLUGIN_STATE_DIR at the empty devices.
    own_pool = os.path.join(os.environ.get("HERDR_PLUGIN_STATE_DIR") or
                            os.path.expanduser("~/.local/state/herdr/plugins/local.focus-queue"), "voice-pool.jsonl")
    if not os.path.exists(own_pool):
        sys.exit("no voice learned on this Mac yet: send some dictations first (or ./focusq voice-enroll)")
    mine = [np.array(json.loads(line)["vector"]) for line in open(own_pool)]
    mine = [v / np.linalg.norm(v) for v in mine]
    probe = voicegate(tempfile.mkdtemp())
    model = probe.extractor()
    print(f"내 목소리 구간 {len(mine)}개를 다른 사람 기기 {len(SPEAKERS)}대에서 판정합니다.\n")
    print(f"{'다른 사람 기기':14} {'학습':>5} {'기준':>5} {'그 사람 통과':>9} {'내 목소리 통과':>11} {'내 최고점':>8}")
    leaked = 0
    for name, (learn, check) in SPEAKERS.items():
        learned = [s for c in learn for s in segments(probe, model, clip(c))]
        held = [s for c in check for s in segments(probe, model, clip(c))]
        device = voicegate(tempfile.mkdtemp())  # empty device: same steps as enroll
        vectors = [v for _, v in learned]
        device.save_voiceprint(device.build(vectors, [d for d, _ in learned]), vectors, sum(d for d, _ in learned))
        voiceprint, threshold = device.load_voiceprint()
        theirs = sum(float(v @ voiceprint) >= threshold for _, v in held)
        scores = [float(v @ voiceprint) for v in mine]
        passed = sum(score >= threshold for score in scores)
        leaked += passed
        print(f"{name:14} {sum(d for d, _ in learned):4.0f}s {threshold:5.2f} {theirs:>5}/{len(held):<3} "
              f"{passed:>7}/{len(mine):<3} {max(scores):8.2f}")
    print(f"\n내 목소리가 다른 사람 기기에서 본인으로 통과한 구간: {leaked}개")
    sys.exit(1 if leaked else 0)


if __name__ == "__main__":
    main()
