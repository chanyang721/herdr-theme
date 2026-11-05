"""Creating a workspace leaves the window showing what the person was looking at.

A fake window keeps spaces and a selection; the tests check the selection it ends in."""
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


class Window:
    def __init__(self):
        self.spaces={'sp-main':{'tb-main':['p-main']},'sp-other':{'tb-other':['p-other']}}
        self.sel={'space':'sp-main','tab':'tb-main','pane':'p-main'}
        self.new_takes_selection=True
        self.person_picks=None      # a click that lands while the space is being created
        self.hide_new_terminal=False

    def select(self,space,tab,pane):
        self.sel={'space':space,'tab':tab,'pane':pane}

    def app(self,command,args):
        if command=='space.new':
            if self.person_picks:self.select(*self.person_picks)
            self.spaces['sp-new']={'tb-new':['p-new']}
            if self.new_takes_selection:self.select('sp-new','tb-new','p-new')
            return {'terminal':'term-p-new','pane':'p-new','space':'sp-new','tab':'tb-new'}
        if command=='space.select':
            tab=next(iter(self.spaces[args['id']]));self.select(args['id'],tab,self.spaces[args['id']][tab][0])
        elif command=='tab.select':
            self.select(self.sel['space'],args['id'],self.spaces[self.sel['space']][args['id']][0])
        elif command=='pane.focus':
            self.sel['pane']=args['pane']
        return {}

    def output(self,argv,*a,**k):
        if argv[1]=='status':
            return json.dumps({'space':self.sel['space'],'tab':self.sel['tab'],'focused_pane':self.sel['pane']})
        spaces=[{'id':s,'name':s,'tabs':[{'id':t,'terminals':[{'terminal':f'term-{p}','pane':p} for p in ps]}
                                         for t,ps in tabs.items() if not(self.hide_new_terminal and t=='tb-new')]}
                for s,tabs in self.spaces.items()]
        return json.dumps({'spaces':spaces}).encode()


class KeepFocusTests(unittest.TestCase):
    def create(self,win):
        with tempfile.TemporaryDirectory() as home,patch.dict(os.environ,{'HERDR_APP_HOME':home}), \
                patch.object(sys,'argv',['workspace.py','Example','/project']),patch.object(workspace,'app',side_effect=win.app), \
                patch.object(workspace.subprocess,'check_output',side_effect=win.output),patch.object(workspace.subprocess,'run'), \
                patch.object(workspace.time,'sleep'),patch.object(workspace.site_config,'load',return_value={}), \
                contextlib.redirect_stdout(io.StringIO()):
            workspace.main()

    def test_the_new_space_does_not_take_the_selection(self):
        win=Window();self.create(win)
        self.assertEqual(win.sel,{'space':'sp-main','tab':'tb-main','pane':'p-main'})

    def test_a_selection_the_creation_did_not_move_stays(self):
        win=Window();win.new_takes_selection=False;self.create(win)
        self.assertEqual(win.sel,{'space':'sp-main','tab':'tb-main','pane':'p-main'})

    def test_a_person_choosing_another_existing_space_meanwhile_is_not_overridden(self):
        win=Window();win.new_takes_selection=False;win.person_picks=('sp-other','tb-other','p-other');self.create(win)
        self.assertEqual(win.sel,{'space':'sp-other','tab':'tb-other','pane':'p-other'})

    def test_a_failure_before_the_terminal_shows_still_undoes_what_the_creation_moved(self):
        win=Window();win.hide_new_terminal=True
        with self.assertRaises(SystemExit):self.create(win)
        self.assertEqual(win.sel['space'],'sp-main')

    def test_a_failure_that_moved_nothing_leaves_a_persons_choice_alone(self):
        win=Window();win.hide_new_terminal=True;win.new_takes_selection=False;win.person_picks=('sp-other','tb-other','p-other')
        with self.assertRaises(SystemExit):self.create(win)
        self.assertEqual(win.sel['space'],'sp-other')


if __name__=='__main__':unittest.main()
