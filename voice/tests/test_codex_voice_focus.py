import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import os,sys,tempfile,unittest
os.environ['HERDR_PLUGIN_STATE_DIR']=tempfile.mkdtemp()  # never the live state
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import focus_queue as queue

class CodexFocusTests(unittest.TestCase):
    def test_legacy_event_delegates_to_the_serialized_controller(self):
        with patch.object(queue.codex_focus,'sync') as sync:
            queue.set_voice({'pane_id':'p','agent':'codex'},True,{})
            queue.set_voice({'pane_id':'p','agent':'codex'},False,{})
            self.assertEqual(sync.call_count,2)

class SettleTests(unittest.TestCase):
    def test_a_focus_blink_never_moves_the_microphone(self):
        def view(focus):
            return {pid:{'pane_id':pid,'agent':'claude','agent_status':'idle','focused':pid==focus} for pid in ('blink','real')}
        snapshots=[view('blink'),view('real'),view('real')]
        calls=[]
        with patch.dict(queue.os.environ,{'HERDR_PLUGIN_EVENT_JSON':''}),\
             patch.object(queue,'panes',side_effect=lambda:snapshots.pop(0) if len(snapshots)>1 else snapshots[0]),\
             patch.object(queue.app_backend,'active',return_value=True),patch.object(queue.time,'sleep'),\
             patch.object(queue,'user_engaged',return_value=False),patch.object(queue,'start_recovery_monitor'),patch.object(queue,'log'),\
             patch.object(queue,'set_voice',side_effect=lambda pane,on,state:calls.append((pane['pane_id'],on))):
            queue.main(advance=True)
        self.assertEqual(calls,[('real',True),('blink',False)])

if __name__=='__main__': unittest.main()
