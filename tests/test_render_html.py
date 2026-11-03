import json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
SCRIPT=Path(__file__).parents[1]/'scripts/render_html.py'

# Stands in for the WebKit binary: writes two 2x tiles and counts its runs.
FAKE='''#!/usr/bin/env python3
import json,struct,sys
from pathlib import Path
doc,prefix,theme,width=sys.argv[1:5]
runs=Path(doc).with_suffix('.runs');runs.write_text(str(int(runs.read_text() or 0)+1 if runs.exists() else 1))
for i,h in enumerate((2000,300)):
    Path(f'{prefix}-{i}.png').write_bytes(b'\\x89PNG\\r\\n\\x1a\\n'+b'\\0\\0\\0\\rIHDR'+struct.pack('>II',int(width)*2,h*2))
print(json.dumps({'tiles':[{'width':int(width),'height':2000},{'width':int(width),'height':300}]}))
'''

class RenderHtmlTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();root=Path(self.folder.name)
        self.home=root/'app';tools=self.home/'data/sixfold/doc-tabs';tools.mkdir(parents=True)
        self.binary=tools/'render-html'
        self.doc=root/'report.html';self.doc.write_text('<html><body>표</body></html>')
    def tearDown(self):self.folder.cleanup()
    def run_script(self):
        result=subprocess.run([sys.executable,str(SCRIPT),'--doc',str(self.doc),'--theme','dark','--width','960'],
                              capture_output=True,text=True,env={**os.environ,'HERDR_APP_HOME':str(self.home)})
        return result.returncode,json.loads(result.stdout)
    def test_missing_renderer_reports_install_notice(self):
        code,data=self.run_script()
        self.assertEqual(code,1);self.assertIn('설치되지 않았습니다',data['error'])
    def test_tiles_are_cached_until_the_file_changes(self):
        self.binary.write_text(FAKE);self.binary.chmod(0o755)
        code,data=self.run_script()
        self.assertEqual(code,0)
        self.assertEqual([(p['width'],p['height']) for p in data['pages']],[(960,2000),(960,300)])
        self.assertTrue(all((self.home/p['path']).exists() for p in data['pages']))
        self.run_script();self.assertEqual(self.doc.with_suffix('.runs').read_text(),'1')
        self.doc.write_text('<html>바뀜</html>');self.run_script()
        self.assertEqual(self.doc.with_suffix('.runs').read_text(),'2')

if __name__=='__main__':unittest.main()
