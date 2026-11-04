import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import workspace


class WorkspaceCreationTests(unittest.TestCase):
    def exercise(self, extra=(), existing=False, fail=False):
        launches=[]
        cells=[]
        tab={'id':'tab','name':'Development','root':{'id':'root','type':'row','children':cells}}
        target={'id':'space','name':'Example','tabs':[tab]}
        neighbor={'id':'other','name':'Other','tabs':[]}
        document={'spaces':[target,neighbor]}
        def app(command,args):
            if command=='space.rename':return {}
            launches.append((command,args))
            if fail and command=='pane.split':raise RuntimeError('spawn failed')
            n=len(launches)
            cells.append({'id':f'p{n}','type':'block','content':{'terminal':f't{n}'}})
            return {'terminal':f't{n}','pane':f'p{n}','space':'space','tab':'tab'}
        def listing(*args,**kwargs):
            if not launches:return json.dumps({'spaces':[{'name':'Example'}] if existing else []}).encode()
            return json.dumps({'spaces':[{'id':'space','name':'Example','tabs':[{'id':'tab','terminals':[{'terminal':'t1','pane':'p1'}]}]}]}).encode()
        def rpc(method,args):
            return {'value':document,'version':1} if method=='doc.get' else {'version':2}
        with patch.object(sys,'argv',['workspace.py','Example','/project',*extra]), patch.object(workspace,'app',side_effect=app), patch.object(workspace.subprocess,'check_output',side_effect=listing), patch.object(workspace.subprocess,'run') as run, patch.object(workspace,'call',side_effect=rpc) as call, contextlib.redirect_stdout(io.StringIO()):
            if existing:
                with self.assertRaises(SystemExit):workspace.main()
                self.assertEqual(launches,[])
            elif fail:
                with self.assertRaisesRegex(RuntimeError,'spawn failed'):workspace.main()
                self.assertEqual(len(launches),2)
                call.assert_not_called()
            else:
                workspace.main()
                self.assertEqual(len(launches),6)
                self.assertEqual(len(target['tabs']),1)
                self.assertEqual([len(row['children']) for row in tab['root']['children']],[3,3])
                self.assertEqual(neighbor,{'id':'other','name':'Other','tabs':[]})
                self.assertTrue(all('send' not in c.args[0] for c in run.call_args_list))
        return [args.get('argv') for _,args in launches]

    def test_default_launches_four_claude_and_two_codex_in_one_grid(self):
        argv=self.exercise()
        from agent_env import launch_argv
        self.assertEqual(argv.count(launch_argv(['claude'])),4)
        self.assertEqual(argv.count(launch_argv(['codex','--no-daemon'])),2)
        self.assertIn('CLAUDE_CODE_CHILD_SESSION',argv[0],'a pane opened from an agent must not inherit its child-session marker')

    def test_shells_are_explicit_opt_out(self):
        self.assertEqual(self.exercise(['--shells']),[None]*6)

    def test_duplicate_name_does_not_create_more_terminals(self):
        self.exercise(existing=True)

    def test_failed_split_is_not_retried_or_written_as_complete(self):
        self.exercise(fail=True)

if __name__=='__main__':unittest.main()
