"""Find how quiet speech can get before the gate's VAD stops hearing it, and
whether a lower threshold or a gain stage brings it back without waking on
noise. Uses public Korean speech, no microphone.

  eval_voice_vad.py DATA_DIR SILERO_MODEL OUT.json
"""
import json
import sys

import numpy as np
import sherpa_onnx

from eval_voice_models import RATE, load, level, noise


def detector(model, threshold):
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = model
    config.silero_vad.threshold = threshold
    config.silero_vad.min_silence_duration = 0.3
    config.silero_vad.min_speech_duration = 0.25
    config.sample_rate = RATE
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)


def heard(model, threshold, samples, boost_db):
    """Seconds of speech found in samples."""
    vad, total = detector(model, threshold), 0
    gained = samples * 10 ** (boost_db / 20)  # not clipped: the gate undoes this gain before embedding
    for at in range(0, len(gained) - 512, 512):
        vad.accept_waveform(gained[at:at + 512])
        while not vad.empty():
            total += len(vad.front.samples)
            vad.pop()
    vad.flush()
    while not vad.empty():
        total += len(vad.front.samples)
        vad.pop()
    return total / RATE


def main():
    data_dir, model, out = sys.argv[1:4]
    rng = np.random.default_rng(3)
    clips = [clip for speaker in load(data_dir).values() for clip in speaker[:4]]
    clips = [clips[i] for i in rng.permutation(len(clips))[:60]]
    results = []
    for floor_db in (-65, -51):
        bed = level(noise(60 * RATE, rng), floor_db)
        for threshold, boost in ((0.5, 0), (0.35, 0), (0.2, 0), (0.5, 20), (0.35, 20)):
            row = {"noise_floor_db": floor_db, "threshold": threshold, "boost_db": boost,
                   "false_seconds_per_minute": round(heard(model, threshold, bed, boost), 1), "recall": {}}
            for speech_db in (-26, -36, -46, -52, -58, -64):
                found, whole, missed = 0, 0, 0
                for clip in clips:
                    tail = np.zeros(RATE, dtype="float32")
                    mixed = np.concatenate([level(clip, speech_db), tail])
                    mixed = mixed + bed[:len(mixed)]
                    seconds = heard(model, threshold, mixed, boost)
                    found += min(seconds, len(clip) / RATE)
                    whole += len(clip) / RATE
                    missed += seconds == 0
                row["recall"][speech_db] = [round(found / whole, 3), missed]
            print(row, flush=True)
            results.append(row)
    json.dump({"clips": len(clips), "rows": results}, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
