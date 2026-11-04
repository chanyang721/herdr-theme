"""Per-person voice settings.

The repository ships general defaults only. Whoever installs the theme gets
their own file, voice.local.json, beside the Herdr app's data (never in the
repository): which microphones may send dictation on their own, a judging
threshold per microphone, and how sensitive speech detection is. `voicegate.py
enroll` fills it in from that person's voice and microphone.

  {
    "auto_send_devices": ["<part of a macOS input name>"],
    "devices": {"<microphone key>": {"threshold": 0.45}},
    "vad_gain": 10.0
  }

Missing keys use DEFAULTS. A file that cannot be read counts as empty, so a
broken file falls back to the defaults rather than stopping the voice gate.
Runs under /usr/bin/python3 too, so standard library only.
"""
import json
import os
import re
import tempfile

DEFAULTS = {
    # Parts of the macOS input name (any case) whose dictation may be sent
    # without a key press. Empty until enrollment adds a headset: a laptop
    # microphone hears the whole room.
    "auto_send_devices": [],
    # Judging threshold per microphone key (see device_key). Missing: the
    # voiceprint's own threshold.
    "devices": {},
    # How many characters a second of the user's heard speech may account for.
    "max_chars_per_second": 25,
    # A segment under a second counts as the user's only at this score or more.
    "short_score": 0.5,
    # Mean score a whole dictation needs to pass as the user's.
    "dictation_score": 0.5,
    # Voiceprint scores: the starting threshold, the most adaptation may raise
    # it to, and the score confirmed speech needs before it is learned.
    "default_threshold": 0.4,
    "max_threshold": 0.5,
    "pool_score": 0.5,
    # Speech detection. The gain is applied only to what the detector hears.
    "vad_threshold": 0.35,
    "vad_gain": 10.0,
}


def path():
    if os.environ.get("HERDR_VOICE_SETTINGS"):
        return os.environ["HERDR_VOICE_SETTINGS"]
    home = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
    return os.path.join(home, "data", "sixfold", "voice.local.json")


def read():
    """The person's own file as written, or {}."""
    try:
        with open(path()) as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load():
    """DEFAULTS overlaid with the person's file. A value of the wrong type is
    ignored, so a typo cannot turn a number into a string."""
    merged = {key: (list(value) if isinstance(value, list) else dict(value) if isinstance(value, dict) else value)
              for key, value in DEFAULTS.items()}
    for key, value in read().items():
        default = DEFAULTS.get(key)
        if default is None:
            continue
        if isinstance(default, list) and isinstance(value, list):
            merged[key] = [str(item) for item in value if str(item).strip()]
        elif isinstance(default, dict) and isinstance(value, dict):
            merged[key] = {str(k): v for k, v in value.items() if isinstance(v, dict)}
        elif isinstance(default, (int, float)) and isinstance(value, (int, float)) and not isinstance(value, bool):
            merged[key] = float(value)
    return merged


def update(change):
    """Apply change(data) to the person's file and write it atomically."""
    data = read()
    change(data)
    target = path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".voice.local-", dir=os.path.dirname(target))
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return data


def device_key(name):
    """The key a microphone's files and settings go under."""
    return re.sub(r"\W+", "-", name).strip("-").lower()


def device_threshold(key):
    value = load()["devices"].get(key, {}).get("threshold")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
