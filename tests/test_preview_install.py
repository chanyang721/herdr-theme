import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from install_preview import replace_files

class PreviewInstallTests(unittest.TestCase):
    def test_replacing_content_preserves_layout_dimensions_visibility_and_other_panes(self):
        files={'id':'files','type':'block','size':{'px':360},'min':300,'hidden':True,'content':{'mod':'files'}}
        terminal={'id':'main','content':{'tab':'active'}}
        tree={'children':[terminal,files]}
        replacement={'id':'files','type':'stack','active':'tree','children':[{'id':'tree'}]}
        self.assertTrue(replace_files(tree,replacement))
        self.assertEqual(files['size'],{'px':360});self.assertEqual(files['min'],300);self.assertTrue(files['hidden'])
        self.assertNotIn('content',files);self.assertEqual(tree['children'][0],terminal)

    def test_absent_files_node_preserves_tree(self):
        tree={'id':'main','content':{'tab':'active'}}
        before=repr(tree)
        self.assertFalse(replace_files(tree,{'id':'files','type':'stack'}))
        self.assertEqual(repr(tree),before)

    def test_layout_without_a_files_panel_installs_nothing(self):
        import json,os,tempfile
        from unittest.mock import patch
        from install_preview import main
        with tempfile.TemporaryDirectory() as root:
            home=Path(root);(home/'layouts').mkdir()
            (home/'layouts/sixfold.json').write_text(json.dumps({'id':'main','content':{'tab':'active'}}))
            with patch.dict(os.environ,{'HERDR_APP_HOME':root}),patch.object(sys,'argv',['install_preview.py','--markdown-only']),patch('install_preview.subprocess.run') as execute:
                with self.assertRaisesRegex(SystemExit,'Files panel'):main()
                execute.assert_not_called()
            self.assertFalse((home/'mods').exists());self.assertFalse((home/'data').exists())
