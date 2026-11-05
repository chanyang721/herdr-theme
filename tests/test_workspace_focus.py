"""Creating a workspace leaves the window showing what the person was looking at."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import workspace

BEFORE={'space':'sp-main','tab':'tb-main','focused_pane':'p-main'}


class KeepFocusTests(unittest.TestCase):
    def create(self,after,fail_listing=False):
        calls=[]
        state={'created':False,'status_reads':0}

        def app(command,args):
            calls.append((command,args))
            if command=='space.new':
                state['created']=True
                return {'terminal':'t1','pane':'p1','space':'sp-new','tab':'tb-new'}
            return {}

        def output(argv,*a,**k):
            if argv[1]=='status':
                state['status_reads']+=1
                return json.dumps(after if state['created'] else BEFORE)
            if not state['created'] or fail_listing:
                return json.dumps({'spaces':[]}).encode()
            return json.dumps({'spaces':[{'id':'sp-new','name':'Example','tabs':[{'id':'tb-new','terminals':[{'terminal':'t1','pane':'p1'}]}]}]}).encode()
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ,{'HERDR_APP_HOME':home}), \
                patch.object(sys,'argv',['workspace.py','Example','/project']), patch.object(workspace,'app',side_effect=app), \
                patch.object(workspace.subprocess,'check_output',side_effect=output), patch.object(workspace.subprocess,'run'), \
                patch.object(workspace.time,'sleep'), patch.object(workspace.site_config,'load',return_value={}), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                workspace.main()
            except SystemExit:
                if not fail_listing:raise
        return calls

    def test_a_moved_selection_is_put_back(self):
        calls=self.create({'space':'sp-new','tab':'tb-new','focused_pane':'p1'})
        restores=[c for c in calls if c[0] in ('space.select','tab.select','pane.focus')]
        self.assertEqual(restores,[('space.select',{'id':'sp-main'}),('tab.select',{'id':'tb-main'}),('pane.focus',{'pane':'p-main'})])
        self.assertGreater([c[0] for c in calls].index('space.select'),[c[0] for c in calls].index('space.new'))

    def test_only_what_moved_is_restored(self):
        calls=self.create({**BEFORE,'focused_pane':'p1'})
        self.assertEqual([c for c in calls if c[0].endswith(('select','focus'))],[('pane.focus',{'pane':'p-main'})])

    def test_an_unmoved_selection_issues_no_select(self):
        calls=self.create(dict(BEFORE))
        self.assertEqual([c for c in calls if c[0].endswith(('select','focus'))],[])

    def test_the_selection_is_restored_even_when_the_new_terminal_never_shows(self):
        calls=self.create({'space':'sp-new','tab':'tb-new','focused_pane':'p1'},fail_listing=True)
        self.assertIn(('space.select',{'id':'sp-main'}),calls)


if __name__=='__main__':unittest.main()
