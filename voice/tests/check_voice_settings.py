"""Does focus turn recording back on? Runs set_voice from a given focus_queue.py
against a fake Claude pane, for each setting, recovery and pane kind.

  check_voice_settings.py [FOCUS_QUEUE_FILE ...]

The fake follows what real sessions do for one F8: tap starts REC, hold and
disabled voice ignore it. A "busy" pane ignores it once, as a pane with voice on
can. Passing a file from `git show` compares versions.
"""
import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()
import app_backend

NOTICE = "Voice mode enabled (tap). Tap f8 (with input empty) to start, tap again to send."


class Pane:
    def __init__(self, mode="tap"):
        self.mode, self.recording, self.busy, self.text, self.session, self.presses = mode, False, 0, "", "s1", 0

    def key(self, key):
        self.presses += 1
        if self.busy:
            self.busy -= 1
        elif key == "f8" and self.mode == "tap":
            self.recording = not self.recording


def load(path):
    folder = tempfile.mkdtemp()
    target = os.path.join(folder, "focus_queue_under_test.py")
    shutil.copy(path, target)
    for name in ("voice_recovery.py", "voice_policy.py"):
        if (ROOT / name).exists():
            shutil.copy(ROOT / name, folder)
    sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location("focus_queue_under_test", target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.path.remove(folder)
    return module


def focus(module, fake, state, kind):
    """One focus event, through the same projection the app bridge uses."""
    base = {"w8:p12": {"pane_id": "w8:p12", "agent": "claude", "agent_status": "idle", "focused": kind == "일반"}}
    if kind == "일반":
        current, target = base, "w8:p12"
    elif kind == "브리지":
        value = {"active": True, "terminal": "t5", "source": "w8:p12", "panes": []}
        current, target = app_backend.project(base, value), "w8:p12"
    else:
        native = [{"pane_id": "app:t21", "agent": "claude", "agent_status": "idle"}]
        value = {"active": True, "terminal": "t21", "panes": native}
        current, target = app_backend.project(base, value), "app:t21"
    pane = current[target]
    assert pane["focused"], kind

    def press(_pane, key, changed, wait=1.5):
        fake.key(key)
        return changed()

    with patch.object(module, "listening", return_value=False), \
            patch.object(module, "screen", side_effect=lambda _: fake.text), \
            patch.object(module, "footer", side_effect=lambda *_: "REC · " if fake.recording else ""), \
            patch.object(module, "claude_recording", side_effect=lambda _: fake.recording), \
            patch.object(module, "input_ready", return_value=True), \
            patch.object(module, "user_in_herdr", return_value=True), \
            patch.object(module, "session_of", side_effect=lambda _: fake.session), \
            patch.object(module, "start_listening"), patch.object(module, "log"), \
            patch.object(module, "press", side_effect=press):
        module.set_voice(pane, True, state)
    return fake.recording


def lock(module, fake, state, kind, why):
    """Two ignored presses, for the given reason."""
    if why == "voice":
        fake.mode = "off"
    else:
        fake.busy = 2
    focus(module, fake, state, kind)
    focus(module, fake, state, kind)


def elapse(state, seconds):
    for session, entry in state.get("voice_key_failures", {}).items():
        if isinstance(entry, list):
            entry[1] -= seconds


def scene_plain(module, fake, state, kind):
    return focus(module, fake, state, kind)


def scene_voice_back_notice(module, fake, state, kind):
    lock(module, fake, state, kind, "voice")
    fake.mode, fake.text = "tap", NOTICE
    return focus(module, fake, state, kind)


def scene_voice_back_scrolled(module, fake, state, kind):
    lock(module, fake, state, kind, "voice")
    fake.mode = "tap"
    return focus(module, fake, state, kind)


def scene_voice_back_after_wait(module, fake, state, kind):
    lock(module, fake, state, kind, "voice")
    fake.mode = "tap"
    elapse(state, 61)
    return focus(module, fake, state, kind)


def scene_busy_after_wait(module, fake, state, kind):
    lock(module, fake, state, kind, "busy")
    elapse(state, 61)
    return focus(module, fake, state, kind)


def scene_manual_f8(module, fake, state, kind):
    lock(module, fake, state, kind, "busy")
    fake.recording = True  # the user pressed F8
    focus(module, fake, state, kind)
    fake.recording = False  # focus left, then came back
    return focus(module, fake, state, kind)


def scene_restart(module, fake, state, kind):
    lock(module, fake, state, kind, "busy")
    fake.session = "s2"
    return focus(module, fake, state, kind)


def scene_hold(module, fake, state, kind):
    fake.mode = "hold"
    return focus(module, fake, state, kind)


def scene_hold_after_wait(module, fake, state, kind):
    lock(module, fake, state, kind, "voice")
    fake.mode = "hold"
    elapse(state, 61)
    return focus(module, fake, state, kind)


SCENES = [("tap 정상", scene_plain),
          ("/voice 끔→켬, 안내문 보임", scene_voice_back_notice),
          ("/voice 끔→켬, 안내문 스크롤됨, 바로", scene_voice_back_scrolled),
          ("/voice 끔→켬, 60초 뒤", scene_voice_back_after_wait),
          ("켜진 채 일시 미반응 2회, 60초 뒤", scene_busy_after_wait),
          ("잠긴 뒤 수동 F8, 포커스 복귀", scene_manual_f8),
          ("잠긴 뒤 세션 재시작", scene_restart),
          ("hold 설정", scene_hold),
          ("hold 로 바꾸고 60초 뒤", scene_hold_after_wait)]


def main():
    files = sys.argv[1:] or [str(ROOT / "focus_queue.py")]
    modules = [load(path) for path in files]
    print("| 조합 | " + " | ".join(f"{os.path.basename(os.path.dirname(path)) or path} {kind}" for path in files
                                  for kind in ("일반", "브리지", "앱")) + " |")
    print("|---|" + "---|" * (3 * len(files)))
    for title, scene in SCENES:
        cells = []
        for module in modules:
            for kind in ("일반", "브리지", "앱"):
                cells.append("REC" if scene(module, Pane(), {}, kind) else "꺼짐")
        print(f"| {title} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
