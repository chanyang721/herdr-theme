"""Imported first by every test module: tests never read or write the person's
own voice state or voice.local.json."""
import json
import os
import tempfile

HEADSET = "Example Headset"  # a made-up microphone allowed to auto-send in tests

if not os.environ.get("HERDR_VOICE_TEST_ISOLATED"):
    folder = tempfile.mkdtemp(prefix="voice-test-")
    os.environ["HERDR_VOICE_TEST_ISOLATED"] = "1"
    os.environ["HERDR_PLUGIN_STATE_DIR"] = os.path.join(folder, "state")
    os.environ["HERDR_VOICE_SETTINGS"] = os.path.join(folder, "voice.local.json")
    os.makedirs(os.environ["HERDR_PLUGIN_STATE_DIR"])
    with open(os.environ["HERDR_VOICE_SETTINGS"], "w") as handle:
        json.dump({"auto_send_devices": [HEADSET.lower()]}, handle)
