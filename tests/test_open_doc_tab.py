import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from open_doc_tab import choose_space

class ChooseSpaceTests(unittest.TestCase):
    def test_rules_of_removed_spaces_are_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root).resolve();doc=folder/'guide.md';doc.write_text('x')
            config={'spaces':{'old':{'name':'Herdr','folders':[str(folder)]},'new':{'name':'Herdr','folders':[str(folder)]}}}
            self.assertEqual(choose_space(config,doc,live={'new'}),'new')
            self.assertEqual(choose_space(config,doc,'Herdr',live={'new'}),'new')
            self.assertIsNone(choose_space(config,doc,live=set()))

    def test_keyword_rule_beats_bare_folder(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root).resolve();doc=folder/'20261103_프로젝트비_회신.md';doc.write_text('x')
            config={'spaces':{'share':{'folders':[str(folder)]},'pb':{'folders':[{'path':str(folder),'match':['프로젝트비']}]}}}
            self.assertEqual(choose_space(config,doc,live={'share','pb'}),'pb')

if __name__=='__main__':unittest.main()
