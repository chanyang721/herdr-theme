"""voicegate.Learner rules. Needs the voice environment's Python (numpy,
sherpa-onnx): ~/.local/share/herdr-focus-queue/venv/bin/python -m unittest."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()  # never the live state
try:
    import numpy as np
    import voicegate as gate
except ImportError:
    gate = None


def unit(*values):
    vector = np.array(values + (0,) * (512 - len(values)), dtype=float)
    return vector / np.linalg.norm(vector)


@unittest.skipIf(gate is None, "needs the voice environment")
class LearnerTests(unittest.TestCase):
    def setUp(self):
        gate.STATE_DIR = tempfile.mkdtemp()
        gate.CONFIRMED = os.path.join(gate.STATE_DIR, "voice-confirmed.jsonl")
        gate.POOL = os.path.join(gate.STATE_DIR, "voice-pool-test.jsonl")
        gate.VOICEPRINT = os.path.join(gate.STATE_DIR, "voiceprint-test.json")
        self.learner = gate.Learner()

    def confirm(self, voiceprint, vector, seconds=8):
        self.learner.heard(100, 100 + seconds, seconds, vector)
        with open(gate.CONFIRMED, "a") as handle:
            handle.write(json.dumps({"start": 99, "end": 101 + seconds}) + "\n")
        return self.learner.confirm(voiceprint)

    def pooled(self):
        try:
            return sum(1 for _ in open(gate.POOL))
        except OSError:
            return 0

    def test_without_a_voiceprint_nothing_is_learned(self):
        for _ in range(6):
            self.assertFalse(self.confirm(None, unit(1)))
        self.assertEqual(self.pooled(), 0)
        self.assertFalse(os.path.exists(gate.VOICEPRINT))

    def test_only_speech_that_already_sounds_like_the_user_is_pooled(self):
        me = unit(1)
        self.confirm(me, unit(1, 1.3))  # scores 0.61
        self.confirm(me, unit(1, 2.2))  # scores 0.41: above the judging threshold, below POOL_SCORE
        self.assertEqual(self.pooled(), 1)

    def test_a_new_learner_has_nothing_pending_from_the_old_microphone(self):
        # A carried-over count made the gate open the new microphone's pool
        # before it existed and stop (FileNotFoundError).
        self.confirm(unit(1), unit(1))
        self.assertEqual(self.learner.added, 1)
        gate.POOL = os.path.join(gate.STATE_DIR, "voice-pool-other.jsonl")
        fresh = gate.Learner()
        fresh.offset = os.path.getsize(gate.CONFIRMED)
        fresh.heard(200, 208, 8, unit(1))
        self.assertFalse(fresh.confirm(None))


if __name__ == "__main__":
    unittest.main()

