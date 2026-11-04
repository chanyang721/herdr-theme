"""voice_settings: general defaults, the person's own overrides, bad values ignored."""
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
import voice_settings
import voice_policy


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ["HERDR_VOICE_SETTINGS"]
        self.path = os.path.join(tempfile.mkdtemp(), "voice.local.json")
        os.environ["HERDR_VOICE_SETTINGS"] = self.path

    def tearDown(self):
        os.environ["HERDR_VOICE_SETTINGS"] = self.saved

    def write(self, data):
        with open(self.path, "w") as handle:
            json.dump(data, handle)

    def test_no_file_means_general_defaults_and_no_auto_send_microphone(self):
        settings = voice_settings.load()
        self.assertEqual(settings["auto_send_devices"], [])
        self.assertEqual(settings["vad_gain"], voice_settings.DEFAULTS["vad_gain"])
        self.assertFalse(voice_policy.headset_input("Any Headset"))

    def test_the_persons_file_overrides_defaults(self):
        self.write({"auto_send_devices": ["My Headset"], "vad_gain": 4, "devices": {"my-headset": {"threshold": 0.45}}})
        self.assertTrue(voice_policy.headset_input("my headset (bluetooth)"))
        self.assertFalse(voice_policy.headset_input("Built-in Microphone"))
        self.assertEqual(voice_settings.load()["vad_gain"], 4.0)
        self.assertEqual(voice_settings.device_threshold("my-headset"), 0.45)
        self.assertIsNone(voice_settings.device_threshold("other"))

    def test_wrong_types_and_unknown_keys_are_ignored(self):
        self.write({"vad_gain": "loud", "dictation_score": True, "devices": {"x": 3}, "unknown": 1})
        settings = voice_settings.load()
        self.assertEqual(settings["vad_gain"], voice_settings.DEFAULTS["vad_gain"])
        self.assertEqual(settings["dictation_score"], voice_settings.DEFAULTS["dictation_score"])
        self.assertEqual(settings["devices"], {})
        self.assertNotIn("unknown", settings)

    def test_a_broken_file_falls_back_to_defaults(self):
        with open(self.path, "w") as handle:
            handle.write("{not json")
        self.assertEqual(voice_settings.load()["auto_send_devices"], [])

    def test_update_keeps_other_keys_and_writes_atomically(self):
        self.write({"auto_send_devices": ["A"]})
        voice_settings.update(lambda data: data.setdefault("devices", {}).update({"a": {"vad_gain": 2.0}}))
        data = json.load(open(self.path))
        self.assertEqual(data, {"auto_send_devices": ["A"], "devices": {"a": {"vad_gain": 2.0}}})
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ["voice.local.json"])

    def test_device_key_matches_voiceprint_file_names(self):
        self.assertEqual(voice_settings.device_key("Example Headset (2)"), "example-headset-2")

    def test_default_path_is_beside_the_app_data(self):
        del os.environ["HERDR_VOICE_SETTINGS"]
        try:
            os.environ["HERDR_APP_HOME"] = "/tmp/app-home"
            self.assertEqual(voice_settings.path(), "/tmp/app-home/data/sixfold/voice.local.json")
        finally:
            os.environ.pop("HERDR_APP_HOME")
            os.environ["HERDR_VOICE_SETTINGS"] = self.path


if __name__ == "__main__":
    unittest.main()
