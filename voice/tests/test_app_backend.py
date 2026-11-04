import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import os, tempfile
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()  # never the live state
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import focus_queue as queue
from app_backend import project

class AppFocusTests(unittest.TestCase):
    def test_bridged_focus_overrides_stale_tui_focus(self):
        panes={'a':{'focused':True},'b':{'focused':False}}
        result=project(panes,{'active':True,'source':'b','terminal':'t2'})
        self.assertFalse(result['a']['focused'])
        self.assertTrue(result['b']['focused'])
    def test_native_focus_never_leaves_a_tui_microphone_selected(self):
        result=project({'a':{'focused':True}}, {'active':True,'terminal':'t10','panes':[{'pane_id':'app:t10','agent':'claude'}]})
        self.assertFalse(result['a']['focused'])
        self.assertTrue(result['app:t10']['focused'])
    def test_background_app_does_not_override_tui_focus(self):
        result=project({'a':{'focused':True}}, {'active':False,'terminal':'t10','panes':[{'pane_id':'app:t10','agent':'claude'}]})
        self.assertTrue(result['a']['focused'])
        self.assertFalse(result['app:t10']['focused'])
class NativeVoiceSafetyTests(unittest.TestCase):
    def test_existing_codex_connection_is_never_toggled(self):
        value={'active':True,'terminal':'t8','panes':[{'pane_id':'app:t8','agent':'codex','agent_status':'idle'}]}
        with patch.object(queue.app_backend,'focus',return_value=value), patch.object(queue,'screen',return_value='voice listening /voice stop'), patch.object(queue.subprocess,'run') as run:
            queue.prepare_app_codex()
            run.assert_not_called()

    def test_native_microphone_key_goes_only_to_its_target(self):
        with patch.object(queue.subprocess,'run') as run:
            queue.send_keys('app:t8','f9')
            self.assertEqual(run.call_args.args[0],[queue.CORE,'keys','t8','f9'])

class StaleHeartbeatTests(unittest.TestCase):
    def ask(self,front=True,status=None):
        import app_backend
        app_backend._asked=(0,None)
        def run(command,**_):
            out={'status':{'focused_pane':'p4','agent':'t4'} if status is None else status,
                 'app-ls':{'spaces':[{'tabs':[{'terminals':[{'terminal':'t4','pane':'p4'},{'terminal':'t9','pane':'p9'}]},
                                              {'terminals':[]}]}]},
                 'ls':{'terminals':[{'address':'t4','agent':'codex','status':'idle'},{'address':'t9','agent':'claude-code','status':'idle'}]},
                 'label':{'terminals':[{'address':'t4'}]},
                 'get':{'labels':{'sixfold.source-pane':'w8:p11'} if command[-1]=='t4' else {}}}
            key='label' if '--label' in command else 'app-ls' if list(command[:2])==[app_backend.APP,'ls'] else command[1]
            return type('R',(),{'stdout':__import__('json').dumps(out[key])})()
        with patch.object(app_backend,'front_is_app',return_value=front),patch.object(app_backend.subprocess,'run',side_effect=run),\
             patch.object(app_backend.Path,'read_text',side_effect=OSError):
            return app_backend.focus()
    def test_stale_heartbeat_asks_the_window_instead_of_trusting_tui_focus(self):
        value=self.ask(status={'focused_pane':'p9','agent':'t4'})
        result=project({'w8:p11':{'agent':'codex','focused':True}},value)
        self.assertFalse(result['w8:p11']['focused'])
        self.assertTrue(result['app:t9']['focused'])
        self.assertNotIn('app:t4',result)  # a bridged TUI pane is not a second microphone
    def test_stale_heartbeat_follows_a_bridged_focus_to_its_tui_pane(self):
        result=project({'w8:p11':{'agent':'codex','focused':False}},self.ask())
        self.assertTrue(result['w8:p11']['focused'])
    def test_unknown_window_focus_leaves_no_tui_microphone_live(self):
        result=project({'w8:p11':{'agent':'codex','focused':True}},self.ask(status={'focused_pane':None,'agent':None}))
        self.assertFalse(any(p['focused'] for p in result.values()))
    def test_docs_tab_focus_does_not_fall_back_to_the_last_agent(self):
        # The window reports its last agent even while a docs pane is focused.
        result=project({'w8:p11':{'agent':'codex','focused':False}},
                       self.ask(status={'focused_pane':'sf-docs-pane-1','agent':'t4'}))
        self.assertFalse(any(p['focused'] for p in result.values()))
    def test_app_in_background_keeps_tui_focus(self):
        self.assertIsNone(self.ask(front=False))
    def test_asked_focus_never_starts_a_voice_connection(self):
        value={'active':True,'terminal':'t8','asked':True,'panes':[{'pane_id':'app:t8','agent':'codex','agent_status':'idle'}]}
        with patch.object(queue.app_backend,'focus',return_value=value), patch.object(queue,'screen',return_value='› \n? for shortcuts'), patch.object(queue.subprocess,'run') as run:
            queue.prepare_app_codex()
            run.assert_not_called()

if __name__=='__main__': unittest.main()
