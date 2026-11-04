import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import sys
from pathlib import Path
import time
import unittest
from unittest.mock import DEFAULT, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import os, tempfile, threading
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()  # never the live state
import focus_queue as queue
# The default input is a headset unless a test says otherwise.
queue._input[:] = [float("inf"), _isolate.HEADSET]


class DiscardTests(unittest.TestCase):
    def test_dictation_the_gate_did_not_pass_is_gone_before_claude_submits_it(self):
        self.assertLess(queue.DISCARD_SECONDS, 15)
        listener = Listener("옆 사람 말입니다.", level=2)
        listener.speaker = "other"
        with patch.object(queue, "DISCARD_SECONDS", 0.5):
            listener.run(seconds=3)
        self.assertEqual(listener.enter, 0)
        self.assertEqual(listener.typed, "")
        self.assertTrue(any(command[-1] == "esc" for command in listener.commands))


class StoppedRecordingTests(unittest.TestCase):
    def left_in_box(self, typed, speaker):
        listener = Listener(typed, level=2)
        listener.stop_after, listener.speaker = 0.5, speaker
        with patch.object(queue, "SETTLE_SECONDS", 0.3), patch.object(queue, "END_PAUSE_SECONDS", 9), \
                patch.object(queue, "DISCARD_SECONDS", 9):
            sent = listener.run(2.5)
        return sent, listener.typed

    def test_own_text_is_sent_so_the_next_recording_can_start(self):
        self.assertEqual(self.left_in_box("작업 중에 말한 내용", "me"), (1, ""))

    def test_other_voice_is_erased_not_sent(self):
        self.assertEqual(self.left_in_box("옆 사람 말", "other"), (0, ""))


class StopKeyTests(unittest.TestCase):
    def key(self, typed, speaker, status="idle", learned=True):
        with patch.object(queue, "composer", return_value=typed), \
                patch.object(queue, "voice_state", return_value=(speaker, None)), \
                patch.object(queue.os.path, "exists", return_value=learned):
            return queue.stop_key("", status)

    def test_own_dictation_is_finished_not_discarded(self):
        self.assertEqual(self.key("말한 내용", "me"), "f8")

    def test_dictation_on_an_unlearned_microphone_is_discarded(self):
        self.assertEqual(self.key("말한 내용", "unknown", learned=False), "esc")

    def test_own_voice_on_a_laptop_microphone_is_not_sent(self):
        with patch.object(queue, "headset_input", return_value=False):
            self.assertEqual(self.key("말한 내용", "me"), "esc")

    def test_other_voice_is_discarded(self):
        self.assertEqual(self.key("옆 사람 말", "other"), "esc")
        self.assertEqual(self.key("판정 없음", "unknown"), "esc")

    def test_speech_from_before_this_recording_does_not_finish_it(self):
        with patch.object(queue, "recording_since", return_value=1000.0), \
                patch.object(queue, "composer", return_value="옆 사람 말"), \
                patch.object(queue.os.path, "exists", return_value=True), \
                patch.object(queue, "read_voice_segments", return_value=[
                    {"start": 950, "end": 990, "seconds": 40, "score": 0.7, "me": True}]):
            self.assertEqual(queue.stop_key("", "working", "p"), "esc")

    def test_empty_recording_only_takes_esc_when_idle(self):
        self.assertEqual(self.key("", "unknown"), "esc")
        self.assertEqual(self.key("", "unknown", status="working"), "f8")


class VoiceKeyTests(unittest.TestCase):
    def turn_on(self, failures, recording=False, text=""):
        self.pressed = []
        state = {"voice_key_failures": failures}
        pane = {"pane_id": "w8:p12", "agent": "claude", "agent_status": "idle"}
        with patch.object(queue, "listening", return_value=False), \
                patch.object(queue, "screen", return_value=text), \
                patch.object(queue, "footer", return_value="REC · " if recording else ""), \
                patch.object(queue, "input_ready", return_value=True), \
                patch.object(queue, "user_in_herdr", return_value=True), \
                patch.object(queue, "session_of", return_value="s"), \
                patch.object(queue, "start_listening"), patch.object(queue, "log"), \
                patch.object(queue, "press", side_effect=lambda *args, **_: self.pressed.append(args[1])):
            queue.set_voice(pane, True, state)
        return state["voice_key_failures"]

    def test_two_misses_hold_the_key_back_for_a_while(self):
        self.turn_on({"s": [2, time.time()]})
        self.assertEqual(self.pressed, [])

    def test_misses_do_not_lock_a_session_out_for_good(self):
        self.turn_on({"s": [2, time.time() - queue.VOICE_KEY_RETRY_SECONDS - 1]})
        self.assertEqual(self.pressed, ["f8"])

    def test_a_count_saved_before_the_retry_is_tried_again(self):
        self.turn_on({"s": 2})
        self.assertEqual(self.pressed, ["f8"])

    def test_turning_voice_back_on_lifts_the_hold_at_once(self):
        self.turn_on({"s": [2, time.time()]}, text="Voice mode enabled (tap). Tap f8")
        self.assertEqual(self.pressed, ["f8"])

    def test_a_recording_clears_the_misses(self):
        self.assertEqual(self.turn_on({"s": [2, time.time()]}, recording=True), {})
class RefusedDictationTests(unittest.TestCase):
    def clear(self, typed, age=0):
        path = queue.voice_policy.blocked_path(queue.STATE_DIR, "p")
        open(path, "w").close()
        os.utime(path, (time.time() - age,) * 2)
        with patch.object(queue, "screen", return_value=""), patch.object(queue, "composer", return_value=typed), \
                patch.object(queue, "erase") as erase, patch.object(queue, "log"):
            result = queue.clear_blocked("p")
        return result, erase, os.path.exists(path)

    def test_refused_text_is_erased_when_it_comes_back(self):
        result, erase, left = self.clear("옆 사람 말")
        self.assertTrue(result)
        erase.assert_called_once_with("p", 6)
        self.assertFalse(left)

    def test_waits_for_the_text_to_come_back(self):
        self.assertEqual(self.clear("")[2], True)

    def test_a_late_draft_is_left_alone(self):
        result, erase, left = self.clear("새로 친 글", age=queue.BLOCKED_SECONDS + 1)
        erase.assert_not_called()
        self.assertFalse(left)


class Listener:
    """Run listen() on a fake pane; `enter` records the Enter key."""

    def __init__(self, typed, level=0, leave_after=None, pane_id="p"):
        self.typed, self.level, self.leave_after = typed, level, leave_after
        self.pane_id, self.commands, self.speaker = pane_id, [], "me"
        self.stop_after = None
        self.started, self.enter = time.time(), 0
        self.key_seconds, self.headset = 60, True  # since the last real key press

    def focused(self):
        return self.leave_after is None or time.time() - self.started < self.leave_after

    def recording(self):
        running = self.stop_after is None or time.time() - self.started < self.stop_after
        return self.focused() and running

    def panes(self):
        return {self.pane_id: {"pane_id": self.pane_id, "focused": self.focused(), "agent": "claude", "agent_status": "idle"}}

    def run_keys(self, command, **_):
        self.commands.append(command)
        if command[-1] == "enter":
            self.enter += 1
            self.typed = ""
        elif command[-1] == "backspace":
            self.typed = ""

    def run(self, seconds=3):
        limit = time.time() + seconds
        def panes():
            if time.time() > limit:
                raise TimeoutError
            return self.panes()
        with patch.object(queue, "panes", panes), \
                patch.object(queue, "screen", return_value=""), \
                patch.object(queue, "footer", side_effect=lambda *_: "REC · " if self.recording() else ""), \
                patch.object(queue, "composer", side_effect=lambda *_: self.typed), \
                patch.object(queue, "meter", side_effect=lambda *_: self.level), \
                patch.object(queue, "voice_state", side_effect=lambda *_: (self.speaker, None)), \
                patch.object(queue, "last_heard", return_value=0), \
                patch.object(queue.voice_policy, "seconds_since_key", side_effect=lambda: self.key_seconds), \
                patch.object(queue, "headset_input", side_effect=lambda: self.headset), \
                patch.object(queue, "listening", return_value=False), \
                patch.object(queue, "listen_pidfile", return_value="/tmp/focusq-test.pid"), \
                patch.multiple(queue, start_voice_gate=DEFAULT, confirm_voice=DEFAULT,
                               user_in_herdr=lambda: True, gate_running=lambda: True), \
                patch.object(queue, "mark_active"), patch.object(queue, "recently_active", return_value=False), \
                patch.object(queue, "main"), patch.object(queue, "log"), \
                patch.object(queue, "END_PAUSE_SECONDS", 0.5), patch.object(queue, "FINISH_SECONDS", 1.5), \
                patch.object(queue.subprocess, "run", self.run_keys):
            try:
                queue.listen(self.pane_id)
            except TimeoutError:
                pass
        return self.enter


class HandTypedTests(unittest.TestCase):
    def setUp(self):
        queue.write_kept("p", "", False)

    def test_typing_while_recording_is_neither_erased_nor_sent(self):
        listener = Listener("직접 친 메시지.", level=3)  # key clicks move the meter
        listener.speaker, listener.key_seconds = "unknown", 0.2
        with patch.object(queue, "DISCARD_SECONDS", 0.5):
            self.assertEqual(listener.run(2), 0)
        self.assertEqual(listener.typed, "직접 친 메시지.")
        self.assertFalse(any(command[-1] in ("esc", "backspace") for command in listener.commands))

    def test_typed_text_left_after_the_recording_ends_stays(self):
        listener = Listener("직접 친 메시지", level=3)
        listener.stop_after, listener.speaker, listener.key_seconds = 0.5, "unknown", 0.2
        with patch.object(queue, "SETTLE_SECONDS", 0.3), patch.object(queue, "DISCARD_SECONDS", 9):
            self.assertEqual(listener.run(2.5), 0)
        self.assertEqual(listener.typed, "직접 친 메시지")

    def test_a_dictation_corrected_by_hand_is_not_sent(self):
        listener = Listener("받아쓴 뒤 고친 문장.", level=3)
        listener.run(0.5)  # dictated, then a key press
        listener.key_seconds, listener.started = 0.2, time.time()
        self.assertEqual(listener.run(2), 0)
        self.assertEqual(listener.typed, "받아쓴 뒤 고친 문장.")

    def later(self, seconds, change):
        timer = threading.Timer(seconds, change)
        timer.start()
        self.addCleanup(timer.cancel)

    def corrected_then_spoken(self, speaker):
        # One listener: dictated, corrected by hand at 0.5 s, spoken to at 1.1 s.
        listener = Listener("받아쓴 뒤 고친", level=3)
        self.later(0.5, lambda: setattr(listener, "key_seconds", 0.2))
        def speak():
            listener.key_seconds, listener.speaker = 60, speaker
            listener.typed += " 문장입니다."
        self.later(1.1, speak)
        with patch.object(queue, "DISCARD_SECONDS", 0.5), patch.object(queue, "END_PAUSE_SECONDS", 9):
            sent = listener.run(2.5)
        return sent, listener

    def test_own_speech_after_a_correction_is_sent(self):
        listener = Listener("받아쓴 뒤 고친", level=3)
        self.later(0.5, lambda: setattr(listener, "key_seconds", 0.2))
        def speak():
            listener.key_seconds = 60
            listener.typed += " 문장입니다."
        self.later(1.1, speak)
        self.assertEqual(listener.run(3), 1)

    def test_other_voice_after_a_correction_takes_only_its_own_words(self):
        sent, listener = self.corrected_then_spoken("other")
        self.assertEqual(sent, 0)
        keys = [key for command in listener.commands for key in command[4:]]
        self.assertNotIn("esc", keys)
        self.assertEqual(keys.count("backspace"), len(" 문장입니다."))

    def test_a_corrected_dictation_gets_the_next_recording(self):
        listener = Listener("받아쓴 뒤 고친", level=3)
        listener.stop_after = 0.4  # the recording ends, then a correction
        self.later(0.5, lambda: setattr(listener, "key_seconds", 0.2))
        self.later(1.0, lambda: setattr(listener, "key_seconds", 60))
        pressed = []
        with patch.object(queue, "SETTLE_SECONDS", 9), \
                patch.object(queue, "input_ready", side_effect=lambda text, prompt, draft=False: draft), \
                patch.object(queue, "press", side_effect=lambda pane_id, key, *_, **__: pressed.append(key) or True):
            listener.run(1.8)
        self.assertIn("f8", pressed)
        self.assertEqual(listener.typed, "받아쓴 뒤 고친")

    def test_a_typed_draft_does_not_start_a_recording(self):
        listener = Listener("손으로 친 초안", level=3)
        listener.key_seconds, listener.stop_after = 0.2, 0
        self.later(0.5, lambda: setattr(listener, "key_seconds", 60))
        pressed = []
        with patch.object(queue, "input_ready", side_effect=lambda text, prompt, draft=False: draft), \
                patch.object(queue, "press", side_effect=lambda pane_id, key, *_, **__: pressed.append(key) or True):
            listener.run(1.3)
        self.assertNotIn("f8", pressed)


class LeavingPaneTests(unittest.TestCase):
    """Focus moved off a pane holding a dictation."""

    def leave(self, judged, typed="내가 한 말입니다.", grows=False, pane_id="w8:p1"):
        self.pressed, self.restored, box = [], [], [typed]
        verdicts = iter(judged)
        def composer(*_):
            return box[0] + (" 다음 pane 말" if grows and self.pressed else "")
        pane = {"pane_id": pane_id, "agent": "claude", "agent_status": "idle"}
        with patch.object(queue, "screen", return_value=""), \
                patch.object(queue, "footer", return_value="REC · "), \
                patch.object(queue, "composer", side_effect=composer), \
                patch.object(queue, "voice_state", side_effect=lambda *_ , **__: (next(verdicts, judged[-1]), None)), \
                patch.object(queue, "LEAVE_JUDGE_SECONDS", 1), \
                patch.object(queue, "restore_box", side_effect=lambda *args: self.restored.append(args)), \
                patch.object(queue, "log"), \
                patch.object(queue, "press", side_effect=lambda *args, **_: self.pressed.append(args[1]) or True):
            if grows:
                box[0] = typed
            queue.set_voice(pane, False, {})
        return self.pressed

    def test_speech_judged_a_moment_later_is_finished_not_discarded(self):
        self.assertEqual(self.leave(["unknown", "unknown", "me"]), ["f8"])
        self.assertEqual(self.restored, [])

    def test_unjudged_speech_is_put_back_after_esc(self):
        self.assertEqual(self.leave(["unknown"]), ["esc"])
        self.assertEqual(self.restored[0][1:], ("내가 한 말입니다.", "unknown"))

    def test_other_voice_is_still_discarded(self):
        self.assertEqual(self.leave(["other"]), ["esc"])
        self.assertEqual(self.restored[0][2], "other")


class RestoreBoxTests(unittest.TestCase):
    def restore(self, pane_id, speaker, kept=""):
        queue.write_kept(pane_id, kept, bool(kept))
        typed = []
        with patch.object(queue, "screen", return_value=""), patch.object(queue, "composer", return_value=""), \
                patch.object(queue, "SETTLE_SECONDS", 0), patch.object(queue, "erase"), patch.object(queue, "log"), \
                patch.object(queue.subprocess, "run", side_effect=lambda command, **_: typed.append(command[-1]) or
                             type("R", (), {"returncode": 0})()):
            queue.restore_box(pane_id, "내가 한 말입니다.", speaker)
        left = queue.read_kept(pane_id)
        queue.write_kept(pane_id, "", False)
        return typed, left

    def test_unjudged_speech_is_typed_back_and_kept(self):
        self.assertEqual(self.restore("w8:p1", "unknown"), (["내가 한 말입니다."], ("내가 한 말입니다.", True)))

    def test_other_voice_leaves_only_what_the_user_kept(self):
        self.assertEqual(self.restore("w8:p1", "other", kept="내가 고친")[0], ["내가 고친"])
        self.assertEqual(self.restore("w8:p1", "other")[0], [])

    def test_app_panes_cannot_be_typed_into(self):
        self.assertEqual(self.restore("app:t1", "unknown")[0], [])


class LaptopMicrophoneTests(unittest.TestCase):
    def test_recording_is_stopped_and_not_restarted(self):
        listener = Listener("", level=0)
        listener.headset = False
        listener.run(1.5)
        keys = [command[-1] for command in listener.commands]
        self.assertIn("esc", keys)
        self.assertNotIn("f8", keys)

    def test_nothing_dictated_is_sent(self):
        listener = Listener("옆 사람 말입니다.", level=5)
        listener.headset = False
        self.assertEqual(listener.run(2), 0)


class DictationTests(unittest.TestCase):
    def test_room_noise_does_not_hold_back_a_finished_sentence(self):
        self.assertEqual(Listener("확인해봐.", level=5).run(), 1)

    def test_unfinished_sentence_is_not_sent(self):
        self.assertEqual(Listener("사이즈를", level=5).run(1.5), 0)

    def test_finished_sentence_is_sent_after_focus_left(self):
        self.assertEqual(Listener("확인해봐.", level=5, leave_after=0.7).run(), 1)

    def test_unfinished_sentence_stays_after_focus_left(self):
        self.assertEqual(Listener("사이즈를", level=5, leave_after=0.7).run(), 0)


if __name__ == "__main__":
    unittest.main()
