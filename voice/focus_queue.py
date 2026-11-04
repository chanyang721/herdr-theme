"""Herdr focus queue.

When a pane's agent finishes or needs approval, focus it - unless the focused
pane is itself waiting for the user's input (they may be typing or dictating).
Such panes queue up; once the user sends an instruction (the focused pane turns
`working`), the next queued pane takes focus.

Claude Code voice follows focus. A Claude Code pane is
toggled with F8 (bound to voice:pushToTalk, voice mode "tap"), so typing,
spaces included, keeps the recording going. Codex conversations stay connected:
only the focused pane receives microphone input, and voice use keeps focus.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import app_backend
import codex_focus
import voice_policy
# Screen reads and key presses go to herdr-core itself: the hc launcher starts
# a Python process for every call (about 30 ms) only to record sends, and the
# focus and Codex checks call it many times before F8 goes out.
CORE = app_backend.CORE
HC = app_backend.HC  # sends go through hc so Sixfold logs the message flow

HERDR = os.environ.get("HERDR_BIN_PATH") or "/opt/homebrew/bin/herdr"
STATE_DIR = os.environ.get("HERDR_PLUGIN_STATE_DIR") or os.path.expanduser(
    "~/.local/state/herdr/plugins/local.focus-queue")
STATE = os.path.join(STATE_DIR, "state.json")
LOG = os.path.join(STATE_DIR, "focus-queue.log")
ATTENTION = {"done", "blocked", "idle"}
PASS_THROUGH_SECONDS = 0.15
APP_SETTLE_SECONDS = 0.6  # longer than one sidebar heartbeat
LISTEN = {"done", "idle", "working"}  # statuses whose input box takes dictation
EVENT_TYPES = {"pane_agent_status_changed", "pane_focused"}


def log(message):
    with open(LOG, "a") as handle:
        handle.write(time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d} " + message + "\n")


def find_event(value):
    if isinstance(value, dict):
        if value.get("type") in EVENT_TYPES and "pane_id" in value:
            return value
        for child in value.values():
            found = find_event(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_event(child)
            if found:
                return found
    return None


def panes():
    output = subprocess.run([HERDR, "pane", "list"], capture_output=True, text=True, timeout=5).stdout
    return app_backend.project({pane["pane_id"]: pane for pane in json.loads(output)["result"]["panes"]})


def send_keys(pane_id, *keys):
    command = [CORE,'keys',pane_id[4:],*keys] if pane_id.startswith('app:') else [HERDR,'pane','send-keys',pane_id,*keys]
    return subprocess.run(command,capture_output=True,timeout=10)


def screen(pane_id):
    """The visible screen with its styling, so dim ghost text can be told
    apart from what the user typed."""
    if pane_id.startswith('app:'):
        return subprocess.run([CORE,'read',pane_id[4:]],capture_output=True,text=True,timeout=5).stdout
    output = subprocess.run([HERDR, "pane", "read", pane_id, "--source", "visible", "--lines", "14", "--ansi"],
                            capture_output=True, text=True, timeout=5).stdout
    return output


ESCAPES = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\r")
DIM = re.compile(r"\x1b\[2m[^\n]*?(?:\x1b\[(?:0|22)m|$)", re.M)


def plain(text):
    return ESCAPES.sub("", text)


def footer(text, prompt):
    """The few lines right above the input box. Status markers live there;
    the same words elsewhere on screen (conversation text) must not count."""
    lines = plain(text).splitlines()
    rows = [index for index, line in enumerate(lines) if line.lstrip().startswith(prompt)]
    if not rows:
        return ""
    return "\n".join(lines[max(0, rows[-1] - 4):rows[-1]])


METER = "▁▂▃▄▅▆▇█"
PLACEHOLDERS = ("Try \"", "Ask Codex to do anything", "Ask a follow-up question")


def composer(text, prompt):
    """What the user has typed or dictated in the input box. Dim text there
    is a prompt suggestion or placeholder (Claude Code offers one in some
    sessions, not others), except while recording, when it is the interim
    transcript. The level meter is dropped."""
    if "REC · " not in footer(text, prompt):
        text = DIM.sub("", text)
    lines = [line.strip() for line in plain(text).splitlines() if line.lstrip().startswith(prompt)]
    if not lines:
        return ""
    typed = lines[-1][len(prompt):].strip(" " + METER).strip()
    return "" if typed.startswith(PLACEHOLDERS) else typed


def user_engaged(pane):
    """Whether the user is typing or talking in this pane right now: a draft
    or a dictation in its input box."""
    agent = pane.get("agent")
    if agent not in ("claude", "codex"):
        return True  # a shell or unknown program: they may be typing a command
    text = screen(pane["pane_id"])
    prompt = "❯" if agent == "claude" else "›"
    if agent == "codex":
        # A voice conversation remains in use between spoken turns.
        status = plain(text)
        if "voice ● listening" in status or "voice ◌ muted" in status or "/voice stop" in status:
            return True
    # Recording alone is not engagement: voice is on by default in the
    # focused pane. Words in the input box, a voice on the meter, or one
    # heard a moment ago (a pause between words) are.
    return bool(composer(text, prompt)) or meter(text, prompt) > 1 or recently_active(pane["pane_id"])


ACTIVE_SECONDS = 5


def activity_file(pane_id):
    return os.path.join(STATE_DIR, f"active-{pane_id.replace(':', '_')}")


def mark_active(pane_id):
    with open(activity_file(pane_id), "w"):
        pass


def recently_active(pane_id):
    try:
        return time.time() - os.path.getmtime(activity_file(pane_id)) < ACTIVE_SECONDS
    except OSError:
        return False


def meter(text, prompt):
    """The dictation level shown after the prompt: 0 silent or not
    recording, up to 7 loud."""
    lines = [line.rstrip() for line in plain(text).splitlines() if line.lstrip().startswith(prompt)]
    last = lines[-1][-1:] if lines else ""
    return METER.index(last) if last and last in METER else 0


def input_ready(text, prompt, draft=False):
    """The plain input box is showing and empty (or, with `draft`, holding
    text): its prompt line sits right under a border. A dialog (permission,
    picker, autocompact) also draws the prompt mark but swallows keys, so a
    press there would be wasted."""
    lines = plain(text).splitlines()
    for index in range(len(lines) - 1, 0, -1):
        if lines[index].lstrip().startswith(prompt):
            return lines[index - 1].lstrip().startswith("─") and (draft or not composer(text, prompt))
    return False


def claude_recording(pane_id):
    return "REC · " in footer(screen(pane_id), "❯")


def codex_voice(pane_id):
    """(listening, muted) from the Codex footer."""
    strip = footer(screen(pane_id), "›")
    return "voice ● listening" in strip, "voice ◌ muted" in strip


def press(pane_id, key, changed, wait=1.5):
    """Send a toggle key and wait until the screen shows the change, so the
    next event never reads a stale screen and toggles back."""
    send_keys(pane_id,key)
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.05)
        if changed():
            return True
    return False


def session_of(pane):
    """The running agent process, not its conversation: a resumed conversation
    is a new process that has loaded the current key bindings."""
    if pane['pane_id'].startswith('app:'):
        record=json.loads(subprocess.check_output([CORE,'get',pane['pane_id'][4:]]))
        return f"{pane['pane_id']}:{(record.get('foreground') or {}).get('pid')}"
    output = subprocess.run([HERDR, "pane", "process-info", "--pane", pane["pane_id"]],
                            capture_output=True, text=True, timeout=5).stdout
    try:
        group = json.loads(output)["result"]["process_info"]["foreground_process_group_id"]
    except (ValueError, KeyError, TypeError):
        group = (pane.get("agent_session") or {}).get("value")
    return f"{pane['pane_id']}:{group}"


# A dictation is sent once its last sentence is finished (ends with a
# sentence mark) and the user has stopped talking: END_PAUSE_SECONDS after the
# last speech the voice gate heard and the last change on screen. Pauses to
# think mid-instruction ran up to ~4 s, so a transcript without a sentence
# mark is never sent automatically.
END_PAUSE_SECONDS = 2.0
# Claude Code submits a tap dictation of 3+ words itself when its silence
# timeout ends the recording (about 15 s), past the voice gate. Dictation not
# judged as the user's must be gone before that.
DISCARD_SECONDS = 3
SETTLE_SECONDS = 1  # a stopped recording's final transcript lands within this
FINISH_SECONDS = 5  # how long a pane the user left is watched for its finished dictation
SENTENCE_END = (".", "?", "!", "。")
RECYCLE_SECONDS = 100  # Claude Code ends a tap recording itself at 120 s
VOICE_KEY_RETRY_SECONDS = 60
VOICE_ENABLED_NOTICE = "Voice mode enabled"  # /voice just turned on: the key can work again
BLOCKED_SECONDS = 5  # how long a refused dictation may take to reappear in the input box


VOICE_PYTHON = os.path.expanduser("~/.local/share/herdr-focus-queue/venv/bin/python")
VOICEPRINT = os.path.join(STATE_DIR, "voiceprint.json")
VOICE_SEGMENTS = os.path.join(STATE_DIR, "voice-segments.jsonl")
VOICE_CONFIRMED = os.path.join(STATE_DIR, "voice-confirmed.jsonl")
HERDR_APPS = ("dev.herdr.app", "com.googlecode.iterm2")
GATE_CHECK_SECONDS = 5
INPUT_CHECK_SECONDS = 2
HAND_SECONDS = 1.5  # a key press this recent means the user is typing in the box
# Speech still being heard when focus moved is judged only once its segment
# ends; until then the gate says unknown, and own dictations would be
# discarded as unjudged when the user speaks and moves on at once.
LEAVE_JUDGE_SECONDS = 3
STOP_SPEECH_SECONDS = 60  # how far back a recording of unknown start is judged
VOICE_SPEAKING = os.path.join(STATE_DIR, "voice-speaking")


def last_heard():
    """When the voice gate last heard speech in progress (0 if never)."""
    try:
        return os.path.getmtime(VOICE_SPEAKING)
    except OSError:
        return 0


def start_voice_gate():
    """Run voicegate.py next to Claude Code's own recording. It keeps an
    enrolled voiceprint up to date from confirm_voice() spans. It inherits
    this process's microphone permission, which is why the listener starts
    it rather than launchd."""
    if os.path.exists(VOICE_PYTHON):
        subprocess.Popen([VOICE_PYTHON, os.path.join(os.path.dirname(os.path.abspath(__file__)), "voicegate.py"),
                          "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=open(os.path.join(STATE_DIR, "voicegate.err"), "a"), start_new_session=True)


def read_voice_segments():
    return voice_policy.read_segments(VOICE_SEGMENTS, 50)


def voice_state(since, until=None):
    """(speaker, last_end) for speech since `since` (and starting before
    `until`, when given), per the voice gate.
    speaker is "other" when another voice did most of the talking, "me" when
    the enrolled voice did, else "unknown" (no voiceprint yet, gate not
    running, or only short segments). last_end is when the last speech
    segment ended, or None."""
    segments = [item for item in read_voice_segments()
                if item["end"] >= since and (until is None or item["start"] < until)]
    last_end = segments[-1]["end"] if segments else None
    if not os.path.exists(VOICEPRINT):
        return "unknown", last_end
    mine = sum(item["seconds"] for item in segments if item["me"] is True)
    others = sum(item["seconds"] for item in segments if item["me"] is False)
    return ("other" if others > mine else "me" if mine else "unknown"), last_end


def may_send(speaker):
    """Only speech the gate heard as the enrolled voice is sent, and only from
    a headset. Unknown is not enough: with no voiceprint, or a gate that heard
    nothing, other people's talk would go out as the user's."""
    return speaker == "me" and headset_input()


_input = [0.0, ""]  # (checked, name) of the default input


def headset_input():
    """Whether macOS records from a headset (auto_send_devices in voice.local.json).
    Claude dictation is kept off otherwise: the built-in microphone hears
    everyone in the room. Asked at most every INPUT_CHECK_SECONDS."""
    if time.time() - _input[0] >= INPUT_CHECK_SECONDS:
        _input[:] = [time.time(), voice_policy.default_input()]
    return voice_policy.headset_input(_input[1])


def recording_since(pane_id):
    """When this pane's recording started. Speech before that went elsewhere
    and says nothing about what this recording holds."""
    try:
        return os.path.getmtime(voice_policy.armed_path(STATE_DIR, pane_id))
    except OSError:
        return time.time() - STOP_SPEECH_SECONDS


def stop_key(text, status, pane_id="", speaker=None):
    """The key that ends a recording. Esc discards what the recording has
    dictated, so it takes other voices away; F8 finishes it and, in tap mode,
    submits it. With nothing dictated only an idle pane can take Esc safely."""
    if composer(text, "❯"):
        if speaker is None:
            speaker = voice_state(recording_since(pane_id))[0]
        return "f8" if may_send(speaker) else "esc"
    return "esc" if status in ("idle", "done") else "f8"


def leaving_speaker(pane_id, left):
    """Who spoke the dictation of a pane focus left at `left`. Speech that was
    still being heard then is judged a moment later, so wait for it; speech
    after leaving went to the next pane and does not count."""
    deadline = left + LEAVE_JUDGE_SECONDS
    while True:
        speaker = voice_state(recording_since(pane_id), until=left)[0]
        if speaker != "unknown" or time.time() >= deadline:
            return speaker
        time.sleep(0.3)


def kept_path(pane_id):
    return os.path.join(STATE_DIR, f"kept-{pane_id.replace(':', '_')}.json")


def read_kept(pane_id):
    """(text, spoken): what the user kept in a pane's input box. Typed or
    corrected by hand, or own speech put back after its recording was
    stopped; it is never erased and not sent on its own."""
    try:
        data = json.load(open(kept_path(pane_id)))
        return data.get("text", ""), bool(data.get("spoken"))
    except (OSError, ValueError):
        return "", False


def write_kept(pane_id, text, spoken):
    if not text:
        try:
            os.remove(kept_path(pane_id))
        except OSError:
            pass
        return
    json.dump({"text": text, "spoken": spoken}, open(kept_path(pane_id), "w"), ensure_ascii=False)


def type_text(pane_id, text):
    """Type literal text into the input box. Only herdr panes take it; the
    core has no paste without Enter, so app panes return False."""
    if pane_id.startswith("app:"):
        return False
    return subprocess.run([HERDR, "pane", "send-text", pane_id, text], capture_output=True, timeout=10).returncode == 0


def restore_box(pane_id, before, speaker):
    """Esc took a recording's dictation away. Put back what was not another
    voice's: the whole box for unjudged speech, the kept part for others'."""
    keep = read_kept(pane_id)[0] if speaker == "other" else before
    if not keep:
        return
    time.sleep(SETTLE_SECONDS)  # Esc's own redraw lands first
    now = composer(screen(pane_id), "❯")
    if now == keep:
        return
    if pane_id.startswith("app:"):
        log(f"claude dictation lost {pane_id}: cannot type into app panes ({len(keep)} chars)")
        return
    erase(pane_id, len(now))
    type_text(pane_id, keep)
    write_kept(pane_id, keep, True)
    log(f"claude dictation kept {pane_id} after its recording stopped ({len(keep)} chars, {speaker} voice)")


def user_in_herdr():
    """Whether the frontmost app is the one showing the panes. Speech aimed at
    another app must not reach a session. Unknown counts as yes."""
    front = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=5).stdout.strip()
    bundle = subprocess.run(["lsappinfo", "info", "-only", "bundleid", front],
                            capture_output=True, text=True, timeout=5).stdout
    return not front or "=" not in bundle or any(app in bundle for app in HERDR_APPS)


def gate_running():
    try:
        os.kill(int(open(os.path.join(STATE_DIR, "voicegate.pid")).read()), 0)
        return True
    except (OSError, ValueError):
        return False


def confirm_voice(since):
    """The dictation spoken since `since` was sent, so it was the user's own
    voice: the voice gate learns from it."""
    if since and os.path.exists(VOICE_PYTHON):
        with open(VOICE_CONFIRMED, "a") as handle:
            handle.write(json.dumps({"start": round(since, 3), "end": round(time.time(), 3)}) + "\n")


def listen_pidfile(pane_id):
    return os.path.join(STATE_DIR, f"listen-{pane_id.replace(':', '_')}.pid")


def listening(pane_id):
    try:
        os.kill(int(open(listen_pidfile(pane_id)).read()), 0)
        return True
    except (OSError, ValueError):
        return False


def erase(pane_id, count):
    """Delete the last `count` characters of the input box."""
    if count > 0:
        send_keys(pane_id, *["backspace"] * count)


def clear_blocked(pane_id):
    """The submit hook refused a dictation and Claude Code put it back in the
    input box; left there, the next dictation would join it."""
    path = voice_policy.blocked_path(STATE_DIR, pane_id)
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        return False
    text = composer(screen(pane_id), "❯")
    if text and age < BLOCKED_SECONDS:
        erase(pane_id, len(text))
        log(f"claude dictation refused {pane_id} ({len(text)} chars)")
    if text or age >= BLOCKED_SECONDS:
        os.remove(path)
    return True


def finish_dictation(pane_id, spoken_since, since):
    """Focus left a pane with a dictation in its input box. Its listener would
    stop here, so wait for the final transcript and send a finished sentence by
    the usual rule; an unfinished one stays in the box. Speech after leaving
    went to the next pane, so only what was heard until now counts."""
    speaker, speech_end = voice_state(spoken_since)
    heard = max(speech_end or 0, last_heard())
    typed, deadline = None, time.time() + FINISH_SECONDS
    while time.time() < deadline:
        time.sleep(0.3)
        text = composer(screen(pane_id), "❯")
        if not text:
            continue  # the recording just stopped; the final text may follow
        if text != typed:
            typed, since = text, time.time()
        if (may_send(speaker) and typed.endswith(SENTENCE_END)
                and time.time() - max(since, heard) >= END_PAUSE_SECONDS):
            send_keys(pane_id,"enter")
            log(f"claude dictation sent {pane_id} after focus left ({len(typed)} chars, {speaker} voice)")
            confirm_voice(spoken_since)
            return


def listen(pane_id):
    """Keep a focused Claude pane listening and send what is dictated.

    Claude Code ends a recording on submit and after two minutes, and words
    spoken before the next recording starts are lost, so re-arm F8 as soon as
    the input box is free. A silent recording is cancelled with Esc before the
    two-minute cap, since letting it run out shows "No audio detected". A
    dictation is sent as soon as the user has finished a sentence and stopped
    talking (see END_PAUSE_SECONDS); one that another voice did most of the
    talking in is not sent and is erased after DISCARD_SECONDS, or the full
    input box would block the next recording. Typed drafts are left alone."""
    if listening(pane_id):
        return
    pidfile = listen_pidfile(pane_id)
    open(pidfile, "w").write(str(os.getpid()))
    start_voice_gate()
    try:
        last, since, started, misses, engaged = None, time.time(), None, 0, False
        spoken_since = None  # when the current dictation started
        dictated = False  # the microphone, not the keyboard, filled the box
        # A real key press while the box holds text makes all of it the
        # user's own, dictated or not, until the box is empty: it is never
        # erased and not sent on its own. The level meter rises for key clicks
        # too, so typed chat would be erased as unjudged dictation.
        # Speech after it is judged like any dictation, so a
        # dictation corrected by hand can be finished by voice.
        kept, spoken = read_kept(pane_id)
        if kept and not composer(screen(pane_id), "❯").startswith(kept):
            # The box changed while no listener watched it: the note is stale.
            write_kept(pane_id, "", False)
            kept, spoken = "", False
        hand = False  # a key was pressed just now
        gate_checked = 0
        while misses < 6:
            time.sleep(0.3)
            pane = panes().get(pane_id) or {}
            if not pane.get("focused") or pane.get("agent") != "claude":
                if pane.get("agent") == "claude" and last and dictated:
                    finish_dictation(pane_id, spoken_since, since)
                    last, started, spoken_since, dictated = None, None, None, False
                    if (panes().get(pane_id) or {}).get("focused"):
                        continue  # the user came back while it finished
                return
            if clear_blocked(pane_id):
                last, started, spoken_since, dictated = None, None, None, False
                continue
            if time.time() - gate_checked >= GATE_CHECK_SECONDS:
                gate_checked = time.time()
                if not gate_running():
                    start_voice_gate()
            text = screen(pane_id)
            in_box = composer(text, "❯")
            hand = bool(in_box) and voice_policy.seconds_since_key() < HAND_SECONDS
            if not in_box:
                if kept:
                    write_kept(pane_id, "", False)
                kept, spoken = "", False
            elif hand or not in_box.startswith(kept):
                if in_box != kept:
                    spoken = spoken or dictated
                    kept = in_box
                    write_kept(pane_id, kept, spoken)
            fresh = in_box[len(kept):]
            if not fresh:
                dictated = False
            headset = headset_input()
            if not headset or not user_in_herdr():
                if "REC · " in footer(text, "❯") and not kept:
                    press(pane_id, stop_key(text, pane.get("agent_status"), pane_id), lambda: not claude_recording(pane_id))
                    log(f"claude voice paused {pane_id}: "
                        + ("another app is in front" if headset else f"input is not a headset ({_input[1] or 'unknown'})"))
                if not composer(screen(pane_id), "❯"):
                    last, started, spoken_since, dictated = None, None, None, False
                continue
            if "REC · " not in footer(text, "❯"):
                typed = composer(text, "❯")
                if dictated and typed:
                    # A working pane keeps a stopped recording's text in the
                    # box, where it blocks the next recording; settle it.
                    if typed != last:
                        last, since = typed, time.time()
                    if time.time() - since < SETTLE_SECONDS:
                        continue
                    speaker = voice_state(spoken_since)[0] if spoken_since else "unknown"
                    if may_send(speaker):
                        send_keys(pane_id, "enter")
                        confirm_voice(spoken_since)
                        log(f"claude dictation sent {pane_id} after recording ended ({len(typed)} chars, {speaker} voice)")
                    else:
                        erase(pane_id, len(typed) - len(kept))
                        log(f"claude dictation discarded {pane_id} after recording ended ({len(typed) - len(kept)} chars, {speaker} voice)")
                    last, started, spoken_since, dictated = None, None, None, False
                    continue
                if last and dictated and not typed:
                    # Claude Code ends the recording when the user submits.
                    confirm_voice(spoken_since)
                    log(f"claude dictation submitted by user {pane_id}")
                last, started, spoken_since, dictated = None, None, None, False
                # A box the user corrected by hand after speaking takes the next
                # recording too, once they stop typing: its words join the end.
                draft = (spoken and bool(kept) and voice_policy.seconds_since_key() >= HAND_SECONDS
                         and input_ready(text, "❯", draft=True))
                if pane.get("agent_status") in LISTEN and (input_ready(text, "❯") or draft):
                    # Claude Code shows REC within ~0.1 s; a miss here is usually
                    # the previous recording still finishing, so retry soon.
                    on = press(pane_id, "f8", lambda: claude_recording(pane_id), wait=1)
                    misses = 0 if on else misses + 1
                    log(f"claude voice re-armed {pane_id}{'' if on else ' (no change)'}")
                continue
            if started is None:
                started = time.time()
                open(voice_policy.armed_path(STATE_DIR, pane_id), "w").close()
            typed = composer(text, "❯")
            if last and dictated and not typed:
                # Emptied without us erasing it: the user pressed Enter.
                confirm_voice(spoken_since)
                log(f"claude dictation submitted by user {pane_id}")
            dictated = bool(fresh) and not hand and (dictated or meter(text, "❯") > 1)
            if not fresh:
                spoken_since = None  # judge only speech after what the user kept
            elif spoken_since is None:
                spoken_since = time.time() - 2  # the words were spoken just before they showed
            speaker, speech_end = voice_state(spoken_since) if spoken_since else ("unknown", None)
            # Panes that finished while the user talked or typed here waited
            # in the queue; once the user is done, let the next one in.
            now_engaged = (bool(typed) or meter(text, "❯") > 1 or recently_active(pane_id)) and speaker != "other"
            if engaged and not now_engaged:
                main(advance=True)
            engaged = now_engaged
            # The level meter also rises for keys and room noise, so only the
            # transcript and the voice gate's speech signal hold back sending.
            if (typed != last or meter(text, "❯") > 1) and (typed or meter(text, "❯") > 1) and speaker != "other":
                mark_active(pane_id)
            if typed != last:
                last, since = typed, time.time()
            elif (dictated and may_send(speaker) and typed.endswith(SENTENCE_END)
                  and time.time() - max(since, speech_end or 0, last_heard()) >= END_PAUSE_SECONDS):
                send_keys(pane_id,"enter")
                heard = max(speech_end or 0, last_heard()) or since
                log(f"claude dictation sent {pane_id} ({len(typed)} chars, {speaker} voice, "
                    f"{time.time() - heard:.1f}s after speech)")
                confirm_voice(spoken_since)
                last = None
            elif (dictated and not may_send(speaker)
                  and time.time() - max(since, speech_end or 0, last_heard()) >= DISCARD_SECONDS):
                if not kept:  # Esc would take a corrected dictation with it
                    press(pane_id, "esc", lambda: not claude_recording(pane_id))
                erase(pane_id, len(composer(screen(pane_id), "❯")) - len(kept))  # text a final transcript left behind
                log(f"claude dictation discarded {pane_id} ({len(typed) - len(kept)} chars, {speaker} voice)")
                last = None
            elif (not typed and time.time() - started >= RECYCLE_SECONDS
                  and pane.get("agent_status") in ("idle", "done")):
                # Esc discards a recording without the error; a working pane
                # would take it as an interrupt, so it is only used when idle.
                press(pane_id, "esc", lambda: not claude_recording(pane_id))
                log(f"claude voice recycled {pane_id}")
        log(f"claude voice stopped re-arming {pane_id}: F8 ignored")
    finally:
        os.remove(pidfile)


def start_listening(pane_id):
    subprocess.Popen(["/usr/bin/python3", os.path.abspath(__file__), "--listen", pane_id],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


def voice_key_misses(failures, session):
    """(misses, when the last one was) for this session; older state holds a
    bare count."""
    entry = failures.get(session, 0)
    return (entry, 0) if isinstance(entry, int) else tuple(entry)


def voice_key_locked(failures, session):
    """Misses can be a busy moment rather than a missing binding, and nothing
    else tells the two apart, so stopping must not outlast VOICE_KEY_RETRY_SECONDS."""
    misses, at = voice_key_misses(failures, session)
    return misses >= 2 and time.time() - at < VOICE_KEY_RETRY_SECONDS


def set_voice(pane, on, state):
    """Turn a pane's microphone on or off, reading its footer first so a key
    press never flips the wrong way."""
    pane_id, agent = pane["pane_id"], pane.get("agent")
    if agent == "claude":
        if on and listening(pane_id):
            return  # its listener keeps it recording; a second F8 would race it
        text = screen(pane_id)
        recording = "REC · " in footer(text, "❯")
        if recording == on:
            if on:
                if state.get("voice_key_failures"):  # recording proves the key works
                    state["voice_key_failures"].pop(session_of(pane), None)
                start_listening(pane_id)
            return
        failures = state.setdefault("voice_key_failures", {})
        if on:
            if voice_key_locked(failures, session_of(pane)) and VOICE_ENABLED_NOTICE not in text:
                return
            # A working pane takes F8, so the user can dictate a follow-up that
            # Claude Code queues. A starting session, a trust or permission
            # dialog or a draft ignores it, and no later event may come (the
            # status turns idle just before the input box is drawn), so the
            # listener waits for the input box and presses F8 then.
            if (pane.get("agent_status") not in LISTEN or not input_ready(screen(pane_id), "❯")
                    or not user_in_herdr() or not headset_input()):
                start_listening(pane_id)
                return
        before = "" if on else composer(text, "❯")
        speaker = leaving_speaker(pane_id, time.time()) if before else None
        key = "f8" if on else stop_key(text, pane.get("agent_status"), pane_id, speaker)
        if (key == "f8" and before and not pane_id.startswith("app:")
                and composer(screen(pane_id), "❯") != before):
            # Words spoken to the next pane while this one was judged joined
            # its box; F8 would send them here. Keep what was there instead.
            key = "esc"
        flipped = press(pane_id, key, lambda: claude_recording(pane_id) == on, wait=3 if on else 1.5)
        log(f"claude voice {'on' if on else 'off'} {pane_id}{'' if flipped else ' (no change)'}")
        if key == "esc" and before:
            restore_box(pane_id, before, speaker)
        if on and not flipped and pane.get("agent_status") in ("idle", "done"):
            # A session started before F8 was bound ignores the key; after two
            # misses press it only every VOICE_KEY_RETRY_SECONDS.
            misses = voice_key_misses(failures, session_of(pane))[0] + 1
            failures[session_of(pane)] = [misses, time.time()]
            if misses >= 2:
                log(f"claude voice key ignored in {pane_id} ({misses} times); "
                    f"trying again in {VOICE_KEY_RETRY_SECONDS} s")
        elif on:
            failures.pop(session_of(pane), None)
            start_listening(pane_id)
    elif agent == "codex":
        # Route all Codex microphones together, under one controller lock.
        codex_focus.sync(sys.modules[__name__])


def prepare_app_codex():
    value = app_backend.focus() or {}
    if not value.get('active') or value.get('source') or value.get('asked'):
        return  # only the sidebar's own heartbeat may start a voice connection
    pane_id = 'app:'+str(value.get('terminal'))
    pane = next((p for p in value.get('panes',[]) if p['pane_id']==pane_id),None)
    if not pane or pane.get('agent')!='codex' or pane.get('agent_status') not in ('idle','done'):
        return
    text=screen(pane_id)
    # Existing connections are never toggled. Only an observed empty CLI can start one.
    if ('/voice stop' in text or 'voice ' in text or composer(text,'›')
            or 'for shortcuts' not in text or not any(line.lstrip().startswith('›') for line in text.splitlines())):
        return
    try:
        subprocess.run([HC,'send',value['terminal'],'/voice'],capture_output=True,timeout=2)
    except subprocess.TimeoutExpired:
        pass  # Startup may outlast the CLI request; observe the actual footer below.
    deadline=time.time()+6
    while time.time()<deadline:
        if not app_backend.active() or (app_backend.focus() or {}).get('terminal')!=value['terminal']:
            return
        if '/voice stop' in screen(pane_id) or 'voice ' in screen(pane_id):
            log(f"app codex voice connected {pane_id}")
            return
        time.sleep(.2)
    log(f"app codex voice startup unconfirmed {pane_id}")


def start_recovery_monitor():
    """One observer; restarting a dead observer never closes an existing voice call."""
    pidfile=os.path.join(STATE_DIR,'voice-recovery.pid')
    if not os.path.isfile(os.path.expanduser('~/.codex/logs_2.sqlite')):
        return
    try:
        with open(pidfile) as handle:
            pid=int(handle.read())
        os.kill(pid,0)
        return
    except (OSError,ValueError):
        pass
    subprocess.Popen(['/usr/bin/python3',os.path.join(os.path.dirname(os.path.abspath(__file__)),'voice_recovery.py')],
                     stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)


def main(advance=False):
    """Handle one Herdr event, or with advance=True just move to the next
    queued pane if the user is no longer busy."""
    os.makedirs(STATE_DIR, exist_ok=True)
    start_recovery_monitor()
    event = {} if advance else find_event(json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON") or "{}"))
    if not event and not advance:
        return
    with open(STATE + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.load(open(STATE))
        except (OSError, ValueError):
            state = {}
        queue = state.setdefault("queue", [])
        last = state.setdefault("status", {})
        current = panes()
        focused = next((pid for pid, pane in current.items() if pane.get("focused")), None)
        pane_id = event.get("pane_id")

        if event.get("type") == "pane_agent_status_changed":
            status = event.get("agent_status")
            previous = last.get(pane_id)
            last[pane_id] = status
            # Only a pane that was working and stopped is news; idle panes at
            # startup are not.
            if status in ATTENTION and (previous in ("working", "blocked") or status in ("done", "blocked")):
                if pane_id != focused and pane_id not in queue:
                    queue.append(pane_id)
                    log(f"queued {pane_id} ({status})")
            elif status == "working" and pane_id in queue:
                queue.remove(pane_id)
        elif pane_id in queue:
            queue.remove(pane_id)

        # Forget closed panes and ones no longer waiting for the user.
        queue[:] = [pid for pid in queue if pid in current and current[pid].get("agent_status") in ATTENTION]

        focused_pane = current.get(focused) or {}
        # The user is busy while the focused pane waits for them, and also
        # while they type or talk into a pane that is still working.
        user_busy = (not focused_pane or focused_pane.get("agent_status") in ATTENTION
                     or user_engaged(focused_pane))
        if queue and not user_busy and not app_backend.active():
            target = queue.pop(0)
            subprocess.run([HERDR, "agent", "focus", target], capture_output=True, timeout=5)
            log(f"focused {target} (was {focused}: {focused_pane.get('agent_status')})")
            focused = target

        # Voice follows focus: the focused pane listens, also while it works
        # so follow-ups queue, and every other pane stops listening. The
        # focused pane goes first, since waiting for the others to stop
        # (up to a second each) is what made REC show up late.
        # Skip panes the user is only passing through; Esc cancels a quick
        # silent recording without an error, so a short wait does. The app's
        # focus also blinks to another pane for a moment, which the sidebar's 500 ms heartbeat can hold for one sample, so
        # wait past it and route to wherever focus has settled.
        time.sleep(APP_SETTLE_SECONDS if app_backend.active() else PASS_THROUGH_SECONDS)
        settled = panes()
        now = next((pid for pid, pane in settled.items() if pane.get("focused")), None)
        if now != focused:
            log(f"focus moved to {now} while settling (was {focused})")
            focused, current = now, settled
        if any(p.get("agent") == "codex" for p in current.values()):
            codex_focus.sync(sys.modules[__name__])
        if (focused in current and current[focused].get("agent") != "codex"
                and current[focused].get("agent_status") in LISTEN | ATTENTION):
            if (panes().get(focused) or {}).get("focused"):
                set_voice(current[focused], True, state)
        for pid, pane in current.items():
            if pid != focused and pane.get("agent") == "claude":
                set_voice(pane, False, state)
        json.dump(state, open(STATE, "w"))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 2 and sys.argv[1] == '--app-focus':
            # Sidebar focus routes existing calls; it never starts a new one.
            main(advance=True)
        elif len(sys.argv) == 3 and sys.argv[1] == "--listen":
            listen(sys.argv[2])
        else:
            main()
    except Exception as error:  # never break Herdr's event loop
        os.makedirs(STATE_DIR, exist_ok=True)
        log(f"error: {error!r}")
