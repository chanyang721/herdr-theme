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
import os, tempfile
os.environ["HERDR_PLUGIN_STATE_DIR"] = tempfile.mkdtemp()  # never the live state
import focus_queue as queue
from test_voice_recovery import ERROR, RECORD

DEVICES={'SPAudioDataType':[{'_items':[
    {'_name':'Mic','coreaudio_default_audio_input_device':'spaudio_yes','coreaudio_device_input':1,'coreaudio_device_srate':48000},
    {'_name':'Speakers','coreaudio_default_audio_output_device':'spaudio_yes','coreaudio_device_output':2,'coreaudio_device_srate':48000}]}]}


class DeviceRecoveryTests(unittest.TestCase):
    def test_audio_table_comments_preserve_the_configured_device(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'.codex').mkdir()
            config=root/'.codex/config.toml'
            config.write_text("[audio] # selected devices\nmicrophone = \"Absent headset\"\nspeaker = 'Speakers'\n")
            with patch.object(recovery.Path,'home',return_value=root):
                selection=recovery.audio_selection()
            self.assertEqual(selection,{'microphone':'Absent headset','speaker':'Speakers'})
            self.assertIsNone(recovery.device_signature(DEVICES,selection))
            config.write_text('audio = { microphone = "Absent headset" }\n')
            with patch.object(recovery.Path,'home',return_value=root):
                self.assertIsNone(recovery.audio_selection())

    def test_device_failure_requires_a_ready_stable_device_gate(self):
        record=copy.deepcopy(RECORD);record['failure']['kind']='device'
        self.assertFalse(recovery.eligible(record,ERROR,True,110))
        self.assertTrue(recovery.eligible(record,ERROR,True,110,device_ready=True))
        self.assertFalse(recovery.eligible(record,ERROR,False,110,device_ready=True))

    def test_default_devices_need_nonzero_channels_and_supported_rates(self):
        expected=[['Mic',1,48000.0],['Speakers',2,48000.0]]
        self.assertEqual(recovery.device_signature(DEVICES,{}),expected)
        for field,value in [('coreaudio_device_input',0),('coreaudio_device_srate',0)]:
            invalid=copy.deepcopy(DEVICES);invalid['SPAudioDataType'][0]['_items'][0][field]=value
            self.assertIsNone(recovery.device_signature(invalid,{}))
        self.assertIsNone(recovery.device_signature({'SPAudioDataType':[]},{}))

    def test_a_missing_configured_microphone_never_falls_back_silently(self):
        self.assertIsNone(recovery.device_signature(DEVICES,{'microphone':'Absent headset'}))
        self.assertIsNone(recovery.device_signature(DEVICES,None))

    def test_device_change_or_removal_resets_the_stability_window(self):
        state={};signature=[['Mic',1,48000],['Speakers',2,48000]]
        self.assertFalse(recovery.stable_devices(state,signature,100))
        self.assertFalse(recovery.stable_devices(state,signature,102))
        self.assertTrue(recovery.stable_devices(state,signature,103))
        self.assertFalse(recovery.stable_devices(state,None,104))
        self.assertFalse(recovery.stable_devices(state,signature,105))
        changed=[['Mic',1,16000],['Speakers',2,48000]]
        self.assertFalse(recovery.stable_devices(state,changed,109))

    def test_device_log_class_is_kept_distinct_from_transport_expiry(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        connection.execute("insert into logs values(1,100,'pid:123:aaaa','codex_realtime_webrtc::client','voice helper output closed phase=Some(Device) exit_code=Some(37)')")
        self.assertEqual(recovery.failures(connection,0),(1,[{'id':1,'ts':100,'pid':'123','kind':'device'}]))

    def test_upgrade_catches_only_recent_device_errors_once(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,target text,feedback_log_body text)')
        body='voice helper output closed phase=Some(Device) exit_code=Some(37)'
        connection.executemany('insert into logs values(?,?,?,?)',[(1,1,'codex_realtime_webrtc::client',body),(2,950,'codex_realtime_webrtc::client',body)])
        state={'cursor':9}
        recovery.upgrade_state(state,connection,1000)
        self.assertEqual(state['cursor'],1)
        state['cursor']=9
        recovery.upgrade_state(state,connection,1001)
        self.assertEqual(state['cursor'],9)

    def test_focus_startup_does_not_bypass_device_failure_recovery(self):
        value={'active':True,'terminal':'t8','panes':[{'pane_id':'app:t8','agent':'codex','agent_status':'idle'}]}
        with patch.object(queue.app_backend,'focus',return_value=value), patch.object(queue,'screen',return_value=ERROR), patch.object(queue.subprocess,'run') as run:
            queue.prepare_app_codex()
            run.assert_not_called()


    def test_hidden_error_caption_needs_independent_closed_actor_evidence(self):
        record=copy.deepcopy(RECORD);record['failure'].update(kind='device',confirmed=True)
        plain=ERROR.replace('Voice conversation failed: voice audio session stopped unexpectedly','')
        self.assertTrue(recovery.eligible(record,plain,True,110,device_ready=True))
        record['failure'].pop('confirmed')
        self.assertFalse(recovery.eligible(record,plain,True,110,device_ready=True))

    def test_corresponding_session_actor_must_confirm_same_pid_and_time(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        body='voice session operation failed stage=AudioSession kind="closed"'
        connection.execute('insert into logs values(2,100,?,?,?)',('pid:999:aaaa','codex_realtime_webrtc::session',body))
        event={'id':1,'ts':100,'pid':'123'}
        self.assertFalse(recovery.confirmed_closure(connection,event))
        connection.execute('insert into logs values(3,100,?,?,?)',('pid:123:aaaa','codex_realtime_webrtc::session',body))
        self.assertTrue(recovery.confirmed_closure(connection,event))

    def test_confirmed_device_closure_recovers_only_after_preflight(self):
        connection=sqlite3.connect(':memory:')
        connection.execute('create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)')
        connection.execute("insert into logs values(1,100,'pid:123:aaaa','codex_realtime_webrtc::client','voice helper output closed phase=Some(Device) exit_code=Some(37)')")
        connection.execute('insert into logs values(2,100,?,?,?)',('pid:123:aaaa','codex_realtime_webrtc::session','voice session operation failed stage=AudioSession kind="closed"'))
        pane={'pane_id':'app:t10','agent':'codex','agent_status':'working','focused':True}
        record={**copy.deepcopy(RECORD),'session':'app:t10:123'}
        signature=recovery.device_signature(DEVICES,{})
        state={'cursor':0,'panes':{'app:t10':record},'audio':{'signature':signature,'since':100}}
        plain=ERROR.replace('Voice conversation failed: voice audio session stopped unexpectedly','')
        connected=ERROR.replace('\n\n›','\nvoice ● listening /voice stop\n\n›')
        with patch.object(recovery.time,'time',return_value=110), \
             patch.object(recovery.queue,'panes',return_value={'app:t10':pane}), \
             patch.object(recovery.queue,'session_of',return_value='app:t10:123'), \
             patch.object(recovery.queue,'screen',side_effect=[plain,plain,connected]), \
             patch.object(recovery.queue,'main') as route, patch.object(recovery.queue,'log'), \
             patch.object(recovery,'recent_failure',return_value=None), \
             patch.object(recovery,'inspect_devices',return_value=signature) as inspect, \
             patch.object(recovery,'save'), patch.object(recovery,'send_start',return_value=True) as send:
            recovery.tick(state,connection)
            self.assertEqual(inspect.call_count,2)
            send.assert_called_once_with('app:t10')
            route.assert_called_once_with(advance=True)


if __name__=='__main__':unittest.main()
