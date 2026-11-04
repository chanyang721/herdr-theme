import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import sys
from pathlib import Path
import os
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice_policy
import voice_submit_hook as hook


def segment(start, end, me=True, score=0.7):
    return {"start": start, "end": end, "seconds": end - start, "score": score, "me": me}


class OwnDictationTests(unittest.TestCase):
    def test_own_speech_that_explains_the_text_passes(self):
        self.assertTrue(voice_policy.own_dictation([segment(100, 106)], 99, 110, 40))

    def test_text_the_gate_never_heard_is_not_the_users(self):
        self.assertFalse(voice_policy.own_dictation([], 99, 110, 16))

    def test_speech_from_before_the_recording_does_not_count(self):
        earlier = [segment(60, 70), segment(70, 80), segment(90, 92)]
        self.assertFalse(voice_policy.own_dictation(earlier, 95, 100, 16))

    def test_a_word_of_the_users_cannot_carry_a_long_text(self):
        self.assertFalse(voice_policy.own_dictation([segment(100, 101.5)], 99, 125, 120))

    def test_another_voice_doing_most_of_the_talking_fails(self):
        self.assertFalse(voice_policy.own_dictation([segment(100, 102), segment(102, 108, me=False, score=0)],
                                                    99, 110, 20))

    def test_a_short_reply_counts_only_if_it_sounds_like_the_user(self):
        self.assertTrue(voice_policy.own_dictation([segment(100, 100.6, None, 0.6)], 99, 102, 3))
        self.assertFalse(voice_policy.own_dictation([segment(100, 100.6, None, 0.1)], 99, 102, 3))


class DeviceTests(unittest.TestCase):
    def test_only_a_headset_records_and_sends(self):
        self.assertTrue(voice_policy.headset_input("Example Headset Pro"))
        self.assertFalse(voice_policy.headset_input("Built-in Microphone"))
        self.assertFalse(voice_policy.headset_input(""))  # unknown counts as no

    def test_the_default_input_is_read_without_opening_it(self):
        self.assertIsInstance(voice_policy.default_input(), str)


class SubmitHookTests(unittest.TestCase):
    def decide(self, prompt="옆 사람 말입니다", pane="w8:p1", now=1000, keys=30, segments=(), armed=990,
               learned=True, running=True, headset=True):
        return hook.decide(prompt, pane, now, keys, list(segments), armed, learned, running, headset)

    def test_unheard_dictation_is_refused(self):
        self.assertIn("전송하지 않았습니다", self.decide())

    def test_own_dictation_passes(self):
        self.assertIsNone(self.decide(segments=[segment(992, 998)]))

    def test_a_hand_on_the_keyboard_always_passes(self):
        self.assertIsNone(self.decide(keys=0.2))

    def test_messages_from_other_agents_pass(self):
        self.assertIsNone(self.decide(prompt='<hc from="t5">작업 지시</hc>'))
        self.assertIsNone(self.decide(prompt="/compact"))

    def test_a_pane_that_has_not_been_recording_is_left_alone(self):
        self.assertIsNone(self.decide(armed=None))
        self.assertIsNone(self.decide(armed=800))
        self.assertIsNone(self.decide(pane=""))

    def test_dictation_the_gate_cannot_vouch_for_is_refused(self):
        own = [segment(992, 998)]
        self.assertIn("꺼져", self.decide(segments=own, running=False))
        self.assertIn("학습이 없어", self.decide(segments=own, learned=False))
        self.assertIn("헤드셋", self.decide(segments=own, headset=False))

    def test_a_hand_still_sends_what_the_gate_refuses(self):
        self.assertIsNone(self.decide(keys=0.2, running=False, learned=False, headset=False))


if __name__ == "__main__":
    unittest.main()
