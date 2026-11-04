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


@unittest.skipIf(gate is None, "needs the voice environment")
class CalibrationTests(unittest.TestCase):
    """Enrollment writes the person's microphone into voice.local.json."""

    def setUp(self):
        self.saved = os.environ["HERDR_VOICE_SETTINGS"]
        self.path = os.path.join(tempfile.mkdtemp(), "voice.local.json")
        os.environ["HERDR_VOICE_SETTINGS"] = self.path

    def tearDown(self):
        os.environ["HERDR_VOICE_SETTINGS"] = self.saved
        gate.DEVICE = ""

    def calibrate(self, levels, builtin):
        original = gate.builtin_input
        gate.builtin_input = lambda: builtin
        try:
            return gate.calibrate("Example Headset", levels)
        finally:
            gate.builtin_input = original

    def test_a_headset_is_allowed_to_send_and_gets_a_gain_for_its_level(self):
        speech_db, gain, headset = self.calibrate([-40, -39, -38], builtin=False)
        self.assertTrue(headset)
        self.assertAlmostEqual(gain, round(10 ** ((gate.TARGET_SPEECH_DB + 39) / 20), 2))
        data = json.load(open(self.path))
        self.assertEqual(data["auto_send_devices"], ["Example Headset"])
        self.assertEqual(data["devices"]["example-headset"]["speech_db"], -39.0)
        self.calibrate([-39], builtin=False)  # enrolling again adds it once
        self.assertEqual(json.load(open(self.path))["auto_send_devices"], ["Example Headset"])

    def test_a_builtin_microphone_is_calibrated_but_not_allowed_to_send(self):
        _, gain, headset = self.calibrate([-80], builtin=True)
        self.assertFalse(headset)
        self.assertEqual(gain, gate.MAX_GAIN)
        self.assertNotIn("Example Headset", json.load(open(self.path)).get("auto_send_devices", []))

    def test_a_threshold_set_for_the_microphone_wins_over_the_voiceprint(self):
        gate.VOICEPRINT = os.path.join(tempfile.mkdtemp(), "voiceprint-example-headset.json")
        with open(gate.VOICEPRINT, "w") as handle:
            json.dump({"vector": [1.0, 0.0], "threshold": 0.4}, handle)
        gate.DEVICE = "example-headset"
        self.assertEqual(gate.load_voiceprint()[1], 0.4)
        with open(self.path, "w") as handle:
            json.dump({"devices": {"example-headset": {"threshold": 0.45}}}, handle)
        self.assertEqual(gate.load_voiceprint()[1], 0.45)
