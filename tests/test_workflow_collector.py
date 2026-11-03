import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
import sqlite3
import time
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('workflow_collector',Path(__file__).parents[1]/'scripts/collect_workflow.py')
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class WorkflowCollectorTests(unittest.TestCase):
    def test_same_pty_and_agent_pid_can_switch_session(self):
        terminal = {'address': 't4', 'agent': 'codex'}
        cache = {}
        with patch.object(collector, 'hc', return_value={'pid': 10}), \
             patch.object(collector, 'process_tree', return_value=[10, 99]), \
             patch.object(collector, 'codex_thread', side_effect=['old', 'new', None]), \
             patch.object(collector, 'bridged_session', return_value=None):
            self.assertEqual(collector.identify(terminal, cache)['session'], 'old')
            self.assertEqual(collector.identify(terminal, cache)['session'], 'new')
            self.assertIsNone(collector.identify(terminal, cache)['session'])

    def test_bridged_claude_session_is_rechecked_without_pid_change(self):
        terminal = {'address': 't2', 'agent': 'claude-code'}
        with patch.object(collector, 'hc', return_value={'pid': 10}), \
             patch.object(collector, 'process_tree', return_value=[10]), \
             patch.object(collector, 'claude_session', return_value=None), \
             patch.object(collector, 'bridged_session', side_effect=['before-clear', 'after-clear']):
            cache = {}
            self.assertEqual(collector.identify(terminal, cache)['session'], 'before-clear')
            self.assertEqual(collector.identify(terminal, cache)['session'], 'after-clear')

    def test_history_is_baseline_and_only_a_new_child_generates_a_delegation(self):
        old={'id':'old','parent':'t5','terminal':'t5','status':'finished'}
        new={'id':'new','parent':'old','terminal':'t5','status':'recent'}
        events=[]
        with patch.object(collector,'collect',return_value=[old]),patch.object(collector,'publish'):
            seen=collector.step({},None,events)
        self.assertEqual(events,[])
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            seen=collector.step({},seen,events)
        self.assertEqual([(e['source'],e['target'],e['kind']) for e in events],[('old','new','delegate')])
        new['status']='finished'
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            collector.step({},seen,events)
        self.assertEqual(len(events),1,'status changes must not invent return messages')
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            collector.step({},None,[])


class LifecycleTests(unittest.TestCase):
    def test_fork_history_is_reset_and_completion_does_not_close_link(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'child.jsonl'
            def write(events):
                path.write_text(''.join(json.dumps({'type':'event_msg','payload':event})+'\n' for event in events))
            events=[{'type':'task_complete'}, {'type':'thread_settings_applied','thread_id':'child'},
                    {'type':'task_started'}, {'type':'user_message','message':'Inspect DB calls\nDetails'}]
            write(events)
            self.assertEqual(collector.transcript_facts(path,'codex','child'),('working','codex.task_started','Inspect DB calls'))
            events.append({'type':'task_complete'});write(events)
            db=sqlite3.connect(':memory:')
            db.execute('create table thread_spawn_edges(parent_thread_id,child_thread_id,status)')
            db.execute('create table threads(id,agent_nickname,agent_role,title,updated_at_ms,created_at_ms,rollout_path,first_user_message)')
            db.execute("insert into thread_spawn_edges values('root','child','open')")
            db.execute('insert into threads values(?,?,?,?,?,?,?,?)',('child','Nash',None,'',int(time.time()*1000),1,str(path),''))
            row=collector.codex_children(db,'root','t1','t1',time.time())[0]
            self.assertEqual((row['status'],row['label'],row['task']),('finished','Nash','Inspect DB calls'))
            events.append({'type':'task_started'});write(events)
            self.assertEqual(collector.transcript_facts(path,'codex','child')[0],'working')
            events.append({'type':'turn_aborted'});write(events)
            self.assertEqual(collector.transcript_facts(path,'codex','child')[0],'interrupted')
            db.close()

    def test_claude_stop_hook_is_completion_without_finished_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'agent.jsonl'
            path.write_text(json.dumps({'type':'attachment','attachment':{'hookEvent':'SubagentStop'}})+'\n')
            self.assertEqual(collector.transcript_facts(path,'claude')[:2],('finished','claude.SubagentStop'))
            path.write_text(json.dumps({'type':'assistant','message':{'stop_reason':'tool_use'}})+'\n')
            self.assertIsNone(collector.transcript_facts(path,'claude')[0])


class WindowsTests(unittest.TestCase):
    def test_utf8_transcript_reads_on_any_locale(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'child.jsonl'
            row={'type':'event_msg','payload':{'type':'user_message','message':'검수해줘 — ✓'}}
            path.write_text(json.dumps(row,ensure_ascii=False)+'\n',encoding='utf-8')
            self.assertEqual(collector.transcript_facts(path,'codex')[2],'검수해줘 — ✓')

    def test_remote_terminal_pid_is_not_looked_up_here(self):
        with patch.object(collector,'hc',return_value={'pid':10}), \
             patch.object(collector,'process_tree') as tree, \
             patch.object(collector,'bridged_session',return_value=None):
            collector.identify({'address':'sub1/t7','agent':'codex'},{})
        tree.assert_not_called()

    def test_second_collector_does_not_take_the_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            first=(Path(folder)/'workflow.lock').open('w')
            second=(Path(folder)/'workflow.lock').open('w')
            try:
                self.assertTrue(collector.lock_once(first))
                self.assertFalse(collector.lock_once(second))
            finally:
                first.close();second.close()

    def test_codex_thread_comes_from_the_root_rollout_a_process_holds(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'state.sqlite'
            db=sqlite3.connect(path)
            db.execute('create table threads(id,rollout_path,archived,updated_at)')
            db.execute('create table thread_spawn_edges(parent_thread_id,child_thread_id,status)')
            db.executemany('insert into threads values(?,?,0,?)',[('root','r.jsonl',1),('child','c.jsonl',3),('other','o.jsonl',2)])
            db.execute("insert into thread_spawn_edges values('root','child','open')")
            db.commit();db.close()
            holders={'r.jsonl':{40},'c.jsonl':{40},'o.jsonl':{50}}
            calls=[]
            def held(rollout):
                calls.append(rollout);return holders[rollout]
            with patch.object(collector,'CODEX_DB',path),patch.object(collector,'file_holders',side_effect=held), \
                 patch.dict(collector._codex_holders,clear=True),patch.dict(collector._codex_scanned,clear=True):
                self.assertEqual(collector.windows_codex_thread([30,40]),'root')
                self.assertNotIn('c.jsonl',calls,'a sub-agent thread never names the session')
                calls.clear()
                self.assertEqual(collector.windows_codex_thread([30,40]),'root')
                self.assertEqual(calls,['r.jsonl'],'a known holder is only rechecked')
                holders['r.jsonl']=set()  # /new closed the old rollout
                self.assertIsNone(collector.windows_codex_thread([30,40]))
                calls.clear()
                self.assertIsNone(collector.windows_codex_thread([30,40]))
                self.assertEqual(calls,[],'a fruitless scan waits before scanning again')
