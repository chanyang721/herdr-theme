"""Run the gate's real VAD and embedding chain on synthetic dictations, with
the settings before and after the change, then apply the submit rule.

  eval_gate_chain.py DATA_DIR MODEL_DIR

One speaker is the user at the headset; the others talk from across the room
at a stated level over the same noise floor. Nothing touches a microphone.
"""
import os
import sys
import tempfile

os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

import voice_policy
import voicegate as gate
from eval_voice_models import ENROLL_SECONDS, load, level, near, noise

CHARS_PER_SECOND = 7  # a typical dictation pace


def blocks(samples):
    for at in range(0, len(samples) - 512, 512):
        yield samples[at:at + 512]


def speech_segments(samples):
    detector = gate.vad()
    found = [piece for _, piece in gate.segments(detector, blocks(np.concatenate([samples, np.zeros(16000, "float32")])))]
    return found


def run(data, model, name, threshold, gain):
    gate.VAD_THRESHOLD, gate.VAD_GAIN = threshold, gain
    rng = np.random.default_rng(11)
    names = sorted(data)
    rows = {}
    for trial in range(8):
        user = names[trial]
        clips = data[user]
        enroll_clips, total = [], 0
        for clip in clips:
            if total >= ENROLL_SECONDS * 16000:
                break
            enroll_clips.append(clip)
            total += len(clip)
        prints = [gate.embed(model, near(clip, rng)) for clip in enroll_clips]
        voiceprint = np.mean(prints, axis=0)
        voiceprint /= np.linalg.norm(voiceprint)
        scenes = [("본인 -26", clips[len(enroll_clips) + i], -26) for i in range(6)]
        others = [n for n in names if n != user]
        for db in (-36, -46, -52):
            scenes += [(f"타인 {db}", data[others[i]][i], db) for i in range(6)]
        for label, clip, db in scenes:
            mixed = (near(clip, rng) if db == -26 else level(clip, db) + level(noise(len(clip), rng), -51))
            segments, clock = [], 100.0
            for piece in speech_segments(mixed):
                seconds = len(piece) / 16000
                _, score, me = gate.judge(model, voiceprint, gate.DEFAULT_THRESHOLD, piece)
                segments.append({"start": clock, "end": clock + seconds, "seconds": seconds,
                                 "score": score, "me": me})
                clock += seconds
            chars = int(len(clip) / 16000 * CHARS_PER_SECOND)
            row = rows.setdefault(label, dict(total=0, unheard=0, judged_me=0, passed=0, heard=0.0, whole=0.0, scores=[]))
            row["scores"].append(round(voice_policy.mean_score(segments, 0, 1e9), 2))
            row["total"] += 1
            row["unheard"] += not segments
            row["judged_me"] += any(item["me"] for item in segments)
            row["passed"] += voice_policy.own_dictation(segments, 0, 1e9, chars)
            row["heard"] += sum(item["seconds"] for item in segments)
            row["whole"] += len(clip) / 16000
    print(name)
    for label, row in rows.items():
        print(f"  {label}: {row['total']}건 / 구간 없음 {row['unheard']} / 본인 판정 구간 있음 {row['judged_me']}"
              f" / 전송 규칙 통과 {row['passed']} / 들린 비율 {row['heard'] / row['whole']:.2f}"
              f" / 평균 점수 범위 {min([s for s in row['scores'] if s] or [0]):.2f}~{max(row['scores']):.2f}")


def main():
    data = load(sys.argv[1])
    gate.VAD_MODEL = os.path.join(sys.argv[2], "silero_vad.onnx")
    gate.EMBEDDING_MODEL = os.path.join(sys.argv[2], os.path.basename(gate.EMBEDDING_MODEL))
    model = gate.extractor()
    changed = gate.VAD_THRESHOLD, gate.VAD_GAIN
    run(data, model, "기존 (VAD 0.5, 이득 없음)", 0.5, 1.0)
    run(data, model, f"변경 (VAD {changed[0]}, 이득 {changed[1]:g}배)", *changed)


if __name__ == "__main__":
    main()
