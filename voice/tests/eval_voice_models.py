"""Compare speaker embedding models on public Korean speech, without any
microphone. Each model runs in its own process so its memory can be read.

  eval_voice_models.py DATA_DIR MODEL_DIR OUT.json

DATA_DIR holds Zeroth-Korean parquet files. The near channel stands for the
headset boom mic; the far channel for someone across the room (20 dB quieter,
reverberant, same noise floor).
"""
import glob
import io
import json
import os
import resource
import subprocess
import sys
import time

import numpy as np
import pyarrow.parquet as pq
import sherpa_onnx
import soundfile
from scipy.signal import butter, fftconvolve, sosfilt

RATE = 16000
ENROLL_SECONDS = 45
LENGTHS = (1.0, 1.5, 2.0, 3.0)
TESTS_PER_LENGTH = 8
NEAR_DB, FAR_DB, NOISE_DB = -26, -46, -51


def load(data_dir, per_speaker=40):
    speakers = {}
    for path in sorted(glob.glob(os.path.join(data_dir, "*.parquet"))):
        table = pq.read_table(path, columns=["speaker_id", "audio"])
        for speaker, audio in zip(table["speaker_id"].to_pylist(), table["audio"].to_pylist()):
            clips = speakers.setdefault(speaker, [])
            if len(clips) < per_speaker:
                samples, rate = soundfile.read(io.BytesIO(audio["bytes"]), dtype="float32")
                assert rate == RATE
                clips.append(samples)
    return {s: c for s, c in speakers.items() if sum(map(len, c)) / RATE >= ENROLL_SECONDS + 30}


def level(samples, db):
    return samples * 10 ** (db / 20) / (np.sqrt(np.mean(samples ** 2)) + 1e-9)


def noise(count, rng):
    white = rng.standard_normal(count).astype("float32")
    return sosfilt(butter(1, 1000, "low", fs=RATE, output="sos"), white).astype("float32")


def near(samples, rng):
    band = sosfilt(butter(4, [100, 7500], "band", fs=RATE, output="sos"), samples).astype("float32")
    return level(band, NEAR_DB) + level(noise(len(samples), rng), NOISE_DB)


def far(samples, rng):
    tail = int(0.5 * RATE)
    room = rng.standard_normal(tail) * np.exp(-6.9 * np.arange(tail) / tail)
    room[0] = 4
    wet = fftconvolve(samples, room)[:len(samples)].astype("float32")
    return level(wet, FAR_DB) + level(noise(len(samples), rng), NOISE_DB)


def eer(target, other):
    scores = np.sort(np.concatenate([target, other]))
    miss = np.searchsorted(np.sort(target), scores) / len(target)
    alarm = 1 - np.searchsorted(np.sort(other), scores) / len(other)
    at = int(np.argmin(np.abs(miss - alarm)))
    return float((miss[at] + alarm[at]) / 2)


def miss_at_alarm(target, other, alarm):
    threshold = np.quantile(other, 1 - alarm)
    return float(np.mean(target < threshold)), float(threshold)


def run_model(data_dir, model_path):
    rng = np.random.default_rng(7)
    data = load(data_dir)
    model = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=2))
    base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    def embed(samples):
        stream = model.create_stream()
        stream.accept_waveform(RATE, samples)
        stream.input_finished()
        vector = np.array(model.compute(stream))
        return vector / np.linalg.norm(vector)

    prints, tests = [], {length: ([], [], []) for length in LENGTHS}  # near vectors, far vectors, owners
    for owner, (speaker, clips) in enumerate(sorted(data.items())):
        joined, enrolled, used = [], 0, 0
        for used, clip in enumerate(clips):
            if enrolled >= ENROLL_SECONDS * RATE:
                break
            joined.append(embed(near(clip, rng)))
            enrolled += len(clip)
        centre = np.mean(joined, axis=0)
        prints.append(centre / np.linalg.norm(centre))
        rest = np.concatenate(clips[used:])
        for length in LENGTHS:
            size = int(length * RATE)
            for start in rng.integers(0, len(rest) - size, TESTS_PER_LENGTH):
                piece = rest[start:start + size]
                tests[length][0].append(embed(near(piece, rng)))
                tests[length][1].append(embed(far(piece, rng)))
                tests[length][2].append(owner)
    prints = np.array(prints)
    result = {"model": os.path.basename(model_path), "megabytes": os.path.getsize(model_path) / 1e6,
              "speakers": len(prints), "by_length": {}}
    for length, (near_vectors, far_vectors, owners) in tests.items():
        owners = np.array(owners)
        same = owners[:, None] == np.arange(len(prints))[None, :]
        near_scores, far_scores = np.array(near_vectors) @ prints.T, np.array(far_vectors) @ prints.T
        target, other_near, other_far = near_scores[same], near_scores[~same], far_scores[~same]
        result["by_length"][str(length)] = {
            "eer_near": eer(target, other_near), "eer_far": eer(target, other_far),
            "miss_at_far_0.1pct": miss_at_alarm(target, other_far, 0.001)[0],
            "target_p5": float(np.percentile(target, 5)), "target_median": float(np.median(target)),
            "far_other_p99": float(np.percentile(other_far, 99)), "far_other_max": float(other_far.max()),
            "trials": [len(target), len(other_far)]}
    sample = np.concatenate(list(data.values())[0])[:3 * RATE]
    embed(sample)
    started = time.perf_counter()
    for _ in range(20):
        embed(sample)
    result["ms_per_3s"] = (time.perf_counter() - started) * 50
    result["peak_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
    result["after_load_rss_mb"] = base / 1e6
    return result


if __name__ == "__main__":
    if sys.argv[1] == "--one":
        print(json.dumps(run_model(sys.argv[2], sys.argv[3])))
    else:
        results = []
        for path in sorted(glob.glob(os.path.join(sys.argv[2], "*.onnx"))):
            if "silero" in path:
                continue
            done = subprocess.run([sys.executable, __file__, "--one", sys.argv[1], path],
                                  capture_output=True, text=True)
            if done.returncode:
                print(path, done.stderr[-400:], file=sys.stderr)
                continue
            results.append(json.loads(done.stdout.strip().splitlines()[-1]))
            print(results[-1]["model"], {k: round(v["eer_far"], 4) for k, v in results[-1]["by_length"].items()},
                  round(results[-1]["ms_per_3s"]), "ms", round(results[-1]["peak_rss_mb"]), "MB", flush=True)
            json.dump(results, open(sys.argv[3], "w"), indent=1)
