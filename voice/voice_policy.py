"""Whether a dictation can be the enrolled user's own speech.

The gate only ever reports speech it heard. A transcript that no heard speech
of the user's explains (someone across the room, too quiet for the gate's VAD
but not for Claude Code's transcription) must not pass as unknown, and speech
from before the recording started says nothing about it.

Runs under /usr/bin/python3 from the focus-queue listener and the submit hook,
so standard library only.
"""
import ctypes
import json
import os
import subprocess

import voice_settings

# The person's own values (voice.local.json) over general defaults.
_SETTINGS = voice_settings.load()
# Dictation usually runs well under ten characters per second of heard speech;
# this allows for the gate missing most of one.
MAX_CHARS_PER_SECOND = _SETTINGS["max_chars_per_second"]
SHORT_SCORE = _SETTINGS["short_score"]  # a segment under a second counts as the user's only above this
# Taken over a whole dictation, as single 1-2 s segments of other voices can
# reach the judging threshold.
DICTATION_SCORE = _SETTINGS["dictation_score"]

EVENT_KEY_DOWN, HID_STATE = 10, 1


def seconds_since_key():
    """Since the last physical key press; keys sent to a pane are not counted.
    Needs no permission."""
    try:
        graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        since = graphics.CGEventSourceSecondsSinceLastEventType
        since.restype, since.argtypes = ctypes.c_double, [ctypes.c_int, ctypes.c_uint32]
        return since(HID_STATE, EVENT_KEY_DOWN)
    except OSError:
        return 0  # cannot tell: treat as a hand


def read_segments(path, lines=200):
    try:
        with open(path) as handle:
            return [json.loads(line) for line in handle.readlines()[-lines:]]
    except (OSError, ValueError):
        return []


def overlap(item, start, end):
    return max(0, min(item["end"], end) - max(item["start"], start))


def heard(segments, start, end):
    """(mine, others) seconds of speech within start..end."""
    mine = others = 0
    for item in segments:
        seconds = overlap(item, start, end)
        if item.get("me") is True or (item.get("me") is None and (item.get("score") or 0) >= SHORT_SCORE):
            mine += seconds
        elif item.get("me") is False:
            others += seconds
    return mine, others


def mean_score(segments, start, end):
    """Score of the speech counted as the user's, weighted by its length."""
    weighted = total = 0
    for item in segments:
        seconds = overlap(item, start, end)
        if item.get("me") is not False and item.get("score") is not None and seconds > 0:
            if item.get("me") is True or item["score"] >= SHORT_SCORE:
                weighted += seconds * item["score"]
                total += seconds
    return weighted / total if total else 0


def own_dictation(segments, start, end, chars):
    """True if the user's speech within start..end can account for `chars`
    characters, outweighs any other voice and sounds like the user throughout."""
    mine, others = heard(segments, start, end)
    return (mine > 0 and mine >= others and mine * MAX_CHARS_PER_SECOND >= chars
            and mean_score(segments, start, end) >= DICTATION_SCORE)


def default_input():
    """Name of macOS's default input, which Claude Code records from, or ""
    if it cannot be read. Asked of the system each time (about 0.2 s): the
    gate only notices a new device in a quiet moment. Enumerating opens no
    stream and changes nothing."""
    try:
        result = subprocess.run(["/usr/sbin/system_profiler", "-json", "SPAudioDataType"],
                                capture_output=True, text=True, timeout=5)
        devices = [item for section in json.loads(result.stdout).get("SPAudioDataType", [])
                   for item in section.get("_items", [])]
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""
    return next((item.get("_name", "") for item in devices
                 if item.get("coreaudio_default_audio_input_device") == "spaudio_yes"), "")


def auto_send_devices():
    """Microphones whose dictation may be sent on its own (parts of the macOS
    input name, any case), read fresh so a new enrollment counts at once. A
    laptop microphone hears the whole room, so none is listed by default."""
    return voice_settings.load()["auto_send_devices"]


def headset_input(name, devices=None):
    """Whether dictation from this input may be used. Unknown counts as no."""
    devices = auto_send_devices() if devices is None else devices
    return bool(name) and any(device.lower() in name.lower() for device in devices)


def armed_path(state_dir, pane_id):
    return os.path.join(state_dir, f"armed-{pane_id.replace(':', '_')}")


def blocked_path(state_dir, pane_id):
    return os.path.join(state_dir, f"blocked-{pane_id.replace(':', '_')}")
