import contextlib
import io
import json
import os
import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import workspace


class WorkspaceCreationTests(unittest.TestCase):
    def exercise(self, extra=(), existing=False, site=None):
        launches=[]
        def app(command,args):
            if command=='space.rename':return {}
            launches.append((command,args))
            return {'terminal':'t1','pane':'p1','space':'space','tab':'tab'}
        def listing(*args,**kwargs):
            if not launches:return json.dumps({'spaces':[{'name':'Example'}] if existing else []}).encode()
            return json.dumps({'spaces':[{'id':'space','name':'Example','tabs':[{'id':'tab','terminals':[{'terminal':'t1','pane':'p1'}]}]}]}).encode()
        err=io.StringIO()
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ,{'HERDR_APP_HOME':home}), patch.object(sys,'argv',['workspace.py','Example','/project',*extra]), patch.object(workspace,'app',side_effect=app), patch.object(workspace.subprocess,'check_output',side_effect=listing), patch.object(workspace.subprocess,'run') as run, patch.object(workspace.site_config,'load',return_value=site or {}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            if existing:
                with self.assertRaises(SystemExit):workspace.main()
                self.assertEqual(launches,[])
            else:
                workspace.main()
                self.assertTrue(all('send' not in c.args[0] for c in run.call_args_list))
        self.last_stderr=err.getvalue()
        return launches

    def test_default_opens_exactly_one_claude_session_and_no_splits(self):
        launches=self.exercise()
        from agent_env import launch_argv
        self.assertEqual([c for c,_ in launches],['space.new'])
        self.assertEqual(launches[0][1]['argv'][:len(launch_argv(['claude']))],launch_argv(['claude'])[:len(launch_argv(['claude']))])
        self.assertIn('CLAUDE_CODE_CHILD_SESSION',launches[0][1]['argv'],'a pane opened from an agent must not inherit its child-session marker')

    def test_shells_open_one_plain_shell(self):
        launches=self.exercise(['--shells'])
        self.assertEqual([c for c,_ in launches],['space.new'])
        self.assertNotIn('argv',launches[0][1])

    def test_pane_count_and_multi_tier_options_are_gone(self):
        with self.assertRaises(SystemExit):self.exercise(['--panes','6'])
        with self.assertRaises(SystemExit):self.exercise(['--tiers','high,mid,high,high,low,mid'])

    def test_single_tier_is_accepted_and_invalid_one_refused(self):
        self.assertEqual(len(self.exercise(['--tiers','low'])),1)
        with self.assertRaises(SystemExit):self.exercise(['--tiers','huge'])

    def test_old_six_value_site_setting_uses_first_value_with_warning(self):
        launches=self.exercise(site={'new_space_tiers':['mid','high','high','high','low','mid']})
        self.assertEqual(len(launches),1)
        self.assertIn('new_space_tiers',self.last_stderr)

    def test_duplicate_name_does_not_create_more_terminals(self):
        self.exercise(existing=True)

if __name__=='__main__':unittest.main()
