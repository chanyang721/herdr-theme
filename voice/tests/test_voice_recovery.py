import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import copy
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import voice_recovery as recovery

ERROR = 'Voice conversation failed: voice audio session stopped unexpectedly\n\n› Ask Codex to do anything\n\nGPT-6.1-Sol medium\n? for shortcuts'
RECORD = {'seen':True,'failure':{'id':30,'ts':100,'pid':'123'},'absent_since':100}


class RecoveryPolicyTests(unittest.TestCase):
    def test_confirmed_failure_in_a_ready_focused_pane_can_recover(self):
        self.assertTrue(recovery.eligible(RECORD,ERROR,True,110))

    def test_healthy_muted_and_listening_calls_are_never_toggled(self):
        for state in ['voice ● listening','voice ◌ muted']:
            text=ERROR.replace('\n\n›',f'\n{state}  f9 mute  /voice stop\n\n›')
            self.assertFalse(recovery.eligible(RECORD,text,True,110))

    def test_missing_footer_without_failure_evidence_is_not_a_disconnect(self):
        record=copy.deepcopy(RECORD);record.pop('failure')
        self.assertFalse(recovery.eligible(record,ERROR,True,110))
        self.assertFalse(recovery.eligible(RECORD,ERROR.replace('Voice conversation failed: voice audio session stopped unexpectedly',''),True,110))

    def test_user_stop_background_focus_and_a_draft_are_preserved(self):
        self.assertFalse(recovery.eligible(RECORD,ERROR,False,110))
        self.assertFalse(recovery.eligible(RECORD,ERROR.replace('Ask Codex to do anything','keep this draft'),True,110))
        text=ERROR.replace('\n\n›','\nVoice conversation ended: requested\n\n›')
        self.assertFalse(recovery.eligible(RECORD,text,True,110))

    def test_restart_and_rate_limits_prevent_repeated_voice_toggles(self):
        for field,value in [('seen',False),('attempted',30),('absent_since',109),('attempts',[90])]:
            record=copy.deepcopy(RECORD);record[field]=value
            self.assertFalse(recovery.eligible(record,ERROR,True,110))
        record=copy.deepcopy(RECORD);record['attempts']=[20,30,40]
        self.assertFalse(recovery.eligible(record,ERROR,True,110))

    def test_already_restarted_history_is_not_replayed_as_a_new_failure(self):
        text=ERROR.replace('\n\n›','\nVoice conversation started.\n\n›')
        self.assertFalse(recovery.eligible(RECORD,text,True,110))

    def test_log_reader_uses_exact_metadata_and_does_not_replay_old_events(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        rows=[(1,100,'pid:123:aaaa','codex_realtime_webrtc::client','voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)'),
              (2,100,'pid:123:aaaa','codex_realtime_webrtc::client','voice helper output closed phase=Some(Shutdown) exit_code=Some(31)'),
              (3,100,'pid:123:aaaa','other','private audio body must not be read')]
        connection.executemany('insert into logs values(?,?,?,?,?)',rows)
        cursor,events=recovery.failures(connection,0)
        self.assertEqual(events,[{'id':1,'ts':100,'pid':'123'}])
        self.assertEqual(recovery.failures(connection,cursor),(3,[]))

    def test_normal_live_tick_sends_no_voice_command(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        pane={'pane_id':'app:t10','agent':'codex','agent_status':'idle','focused':True}
        text=ERROR.replace('\n\n›','\nvoice ◌ muted  /voice stop\n\n›')
        with patch.object(recovery.queue,'panes',return_value={'app:t10':pane}), \
             patch.object(recovery.queue,'session_of',return_value='app:t10:123'), \
             patch.object(recovery.queue,'screen',return_value=text), \
             patch.object(recovery,'save'), patch.object(recovery,'send_start') as send:
            recovery.tick({'cursor':0},connection)
            send.assert_not_called()


    def test_recovery_requires_fresh_focus_and_confirms_the_new_footer(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        connection.execute("insert into logs values(1,100,'pid:123:aaaa','codex_realtime_webrtc::client','voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)')")
        pane={'pane_id':'app:t10','agent':'codex','agent_status':'working','focused':True}
        record={**copy.deepcopy(RECORD),'session':'app:t10:123'}
        state={'cursor':0,'panes':{'app:t10':record}}
        connected=ERROR.replace('\n\n›','\nvoice ● listening /voice stop\n\n›')
        with patch.object(recovery.time,'time',return_value=110), \
             patch.object(recovery.queue,'panes',return_value={'app:t10':pane}), \
             patch.object(recovery.queue,'session_of',return_value='app:t10:123'), \
             patch.object(recovery.queue,'screen',side_effect=[ERROR,ERROR,connected]), \
             patch.object(recovery.queue,'main') as route, patch.object(recovery.queue,'log'), \
             patch.object(recovery,'save'), patch.object(recovery,'send_start',return_value=True) as send:
            recovery.tick(state,connection)
            send.assert_called_once_with('app:t10')
            route.assert_called_once_with(advance=True)
            self.assertNotIn('failure',record)

    def test_focus_change_before_action_cancels_recovery(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        pane={'pane_id':'app:t10','agent':'codex','agent_status':'idle','focused':True}
        record={**copy.deepcopy(RECORD),'session':'app:t10:123'}
        state={'cursor':0,'panes':{'app:t10':record}}
        with patch.object(recovery.time,'time',return_value=110), \
             patch.object(recovery.queue,'panes',side_effect=[{'app:t10':pane},{'app:t10':{**pane,'focused':False}}]), \
             patch.object(recovery.queue,'session_of',return_value='app:t10:123'), \
             patch.object(recovery.queue,'screen',return_value=ERROR), \
             patch.object(recovery,'save'), patch.object(recovery,'send_start') as send:
            recovery.tick(state,connection)
            send.assert_not_called()


if __name__=='__main__':unittest.main()
