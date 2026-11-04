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
    def run_script(self,width='960'):
        result=subprocess.run([sys.executable,str(SCRIPT),'--doc',str(self.doc),'--theme','dark','--width',width],
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
    def test_width_snaps_to_40px_steps_and_each_step_is_cached(self):
        self.binary.write_text(FAKE);self.binary.chmod(0o755)
        _,data=self.run_script('797');self.assertEqual(data['width'],760);self.assertEqual(data['pages'][0]['width'],760)
        self.run_script('770');self.assertEqual(self.doc.with_suffix('.runs').read_text(),'1')
        _,data=self.run_script('100');self.assertEqual(data['width'],320)
        self.assertEqual(self.doc.with_suffix('.runs').read_text(),'2')
    def test_static_page_is_not_interactive_but_controls_are(self):
        self.binary.write_text(FAKE);self.binary.chmod(0o755)
        _,data=self.run_script();self.assertEqual(data['interactive'],[]);self.assertFalse(data['truncated'])
        self.doc.write_text('<p>표</p><details><summary>더</summary></details><script>b.addEventListener("click",f)</script>')
        _,data=self.run_script();self.assertEqual(data['interactive'],['스크립트 이벤트','펼침 영역'])

class InteractiveTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0,str(SCRIPT.parent));import render_html;self.check=render_html.interactive
    def test_static_reports_and_chart_only_pages_pass(self):
        self.assertEqual(self.check('<h1>보고</h1><table><tr><td>1</td></tr></table>'),[])
        self.assertEqual(self.check('<canvas id=c></canvas><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><script>new Chart(c,{});addEventListener("resize",f);window.addEventListener("load",g)</script>'),[])
        self.assertEqual(self.check('<input type="hidden" name="a">'),[])
    def test_markup_shown_as_text_is_ignored(self):
        self.assertEqual(self.check('<!-- <button>x</button> --><pre><form><select></pre><code>onclick="x"</code>'),[])
    def test_each_kind_of_control_is_named(self):
        cases={'<a onclick="go()">x</a>':'클릭 이벤트','<details><summary>s</summary></details>':'펼침 영역',
               '<dialog open>d</dialog>':'팝업','<a data-bs-toggle="modal">m</a>':'팝업','<div role="tablist"></div>':'탭',
               '<select><option>1</option></select>':'입력 양식','<input type="radio">':'입력 양식','<div x-data="{}"></div>':'UI 라이브러리'}
        for html,label in cases.items():
            with self.subTest(html=html):self.assertIn(label,self.check(html))

# Compiles the real WebKit renderer; slow, so it runs only with HERDR_RENDER_LIVE=1.
@unittest.skipUnless(os.environ.get('HERDR_RENDER_LIVE')=='1','set HERDR_RENDER_LIVE=1 to run the WebKit renderer')
class LiveRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0,str(SCRIPT.parent));import install_doc_tabs
        cls.folder=tempfile.TemporaryDirectory();cls.root=Path(cls.folder.name)
        cls.binary=cls.root/'render-html';install_doc_tabs.compile_swift(SCRIPT.with_suffix('.swift'),cls.binary)
    @classmethod
    def tearDownClass(cls):cls.folder.cleanup()
    def render(self,html,width=600):
        doc=self.root/'page.html';doc.write_text(html)
        result=subprocess.run([str(self.binary),str(doc),str(self.root/'out/tile'),'dark',str(width)],capture_output=True,text=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr);return json.loads(result.stdout)
    def test_short_page_is_as_tall_as_its_content(self):
        tiles=self.render('<p style="margin:0;height:150px">짧은 문서</p>')['tiles']
        self.assertEqual([(t['width'],t['height']) for t in tiles],[(600,8+150+8)], 'content plus the default body margins')
    def test_viewport_height_sections_and_late_script_content_are_measured_once(self):
        data=self.render('<!doctype html><body style="margin:0"><div style="height:100vh"></div><div style="height:3000px"></div>'
                         '<div id=late></div><script>setTimeout(()=>{late.style.height="500px"},700)</script></body>')
        self.assertEqual(sum(t['height'] for t in data['tiles']),1200+3000+500)
        self.assertEqual([t['height'] for t in data['tiles']],[2000,2000,700]);self.assertFalse(data['truncated'])

if __name__=='__main__':unittest.main()
