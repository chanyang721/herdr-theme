import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import unittest
from test_dictation import Listener
import os, tempfile
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()  # never the live state
import focus_queue as queue


class NativeDictationTests(unittest.TestCase):
    def assert_core_target(self, listener):
        enter=[command for command in listener.commands if command[-1]=='enter']
        self.assertEqual(enter, [[queue.CORE,'keys','t10','enter']])

    def test_finished_native_dictation_targets_its_core_terminal(self):
        listener=Listener('Continue.',level=5,pane_id='app:t10')
        self.assertEqual(listener.run(),1)
        self.assert_core_target(listener)

    def test_finishing_after_focus_left_keeps_the_original_core_target(self):
        listener=Listener('Continue.',level=5,leave_after=.7,pane_id='app:t10')
        self.assertEqual(listener.run(),1)
        self.assert_core_target(listener)


if __name__=='__main__':unittest.main()
