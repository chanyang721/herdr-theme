#!/usr/bin/python3
"""Claude Code UserPromptSubmit hook: refuse dictation that was not the user's.

The listener can only race Claude Code: a tap recording submits itself when
its silence timeout ends it or when F8 stops it, and a quiet voice never
registers as dictation at all. Every submission passes through here, typed or
not, so this is where the voice gate is enforced.

A real key press just before the prompt means the user sent it by hand, and
that always passes. Prompts from `hc send` pass, and so does anything in a pane
that has not been recording lately. A dictation passes only when the gate heard
the user say it: a gate that is down, heard nothing, has no voiceprint for this
microphone, or listens to a microphone that is not a headset refuses it:
each of those would let other people's talk through. The user can still send
a refused dictation by hand.

Exit 2 makes Claude Code refuse the prompt and put it back in the input box,
so the blocked file tells the listener to clear it. Refused text is kept only
in voice-blocked.jsonl on this machine, to recover a wrong refusal.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_policy

STATE_DIR = os.environ.get("HERDR_PLUGIN_STATE_DIR") or os.path.expanduser(
    "~/.local/state/herdr/plugins/local.focus-queue")
KEY_SECONDS = 1.0  # a hand Enter reaches the hook well within this
ARMED_SECONDS = 130  # a tap recording ends at 120 s; its transcript follows
SETTLE_SECONDS = 0.6  # the gate reports a segment 0.3 s after speech ends


def gate_running():
    try:
        with open(os.path.join(STATE_DIR, "voicegate.pid")) as handle:
            os.kill(int(handle.read()), 0)
        return True
    except (OSError, ValueError):
        return False


def decide(prompt, pane_id, now, key_seconds, segments, armed, learned, running, headset):
    """The reason to refuse this prompt, or None."""
    if not pane_id or armed is None or now - armed > ARMED_SECONDS:
        return None
    if key_seconds < KEY_SECONDS or "<hc from=" in prompt or prompt.lstrip().startswith("/"):
        return None
    if not running:
        return f"목소리 판정기가 꺼져 있어 받아쓰기를 전송하지 않았습니다 ({len(prompt)}자)"
    if not headset:
        return f"헤드셋이 아닌 마이크라 받아쓰기를 자동 전송하지 않았습니다 ({len(prompt)}자)"
    if not learned:
        return f"이 마이크의 목소리 학습이 없어 받아쓰기를 전송하지 않았습니다 ({len(prompt)}자)"
    if voice_policy.own_dictation(segments, armed - 1, now + 1, len(prompt)):
        return None
    mine, others = voice_policy.heard(segments, armed - 1, now + 1)
    return f"본인 목소리로 확인되지 않아 전송하지 않았습니다 ({len(prompt)}자, 본인 {mine:.1f}초, 다른 목소리 {others:.1f}초)"


def main():
    prompt = json.load(sys.stdin).get("prompt", "")
    pane_id = os.environ.get("HERDR_PANE_ID", "")
    try:
        armed = os.path.getmtime(voice_policy.armed_path(STATE_DIR, pane_id))
    except OSError:
        armed = None
    learned, running = os.path.exists(os.path.join(STATE_DIR, "voiceprint.json")), gate_running()
    # Only a recording pane needs it, and asking takes about 0.2 s.
    headset = armed is not None and voice_policy.headset_input(voice_policy.default_input())
    segments_file = os.path.join(STATE_DIR, "voice-segments.jsonl")
    keys = voice_policy.seconds_since_key()
    reason = decide(prompt, pane_id, time.time(), keys, voice_policy.read_segments(segments_file),
                    armed, learned, running, headset)
    if reason:  # speech that just ended may not be reported yet
        time.sleep(SETTLE_SECONDS)
        reason = decide(prompt, pane_id, time.time(), keys, voice_policy.read_segments(segments_file),
                        armed, learned, running, headset)
    if not reason:
        return 0
    with open(os.path.join(STATE_DIR, "voice-blocked.jsonl"), "a") as handle:
        handle.write(json.dumps({"time": round(time.time(), 3), "pane": pane_id, "text": prompt},
                                ensure_ascii=False) + "\n")
    open(voice_policy.blocked_path(STATE_DIR, pane_id), "w").close()
    print(reason, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
