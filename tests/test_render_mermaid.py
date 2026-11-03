import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
from render_mermaid import mermaid_blocks

class MermaidBlockTests(unittest.TestCase):
    def test_matches_the_tab_fence_rules(self):
        text='앞\n```mermaid\nflowchart LR\n  A-->B\n```\n중간\n~~~~ mermaid\nsequenceDiagram\n~~~~\n```js\nmermaid\n```\n끝'
        self.assertEqual(mermaid_blocks(text),['flowchart LR\n  A-->B','sequenceDiagram'])
    def test_unclosed_and_short_closing_fences_are_not_diagrams(self):
        self.assertEqual(mermaid_blocks('```mermaid\nunclosed'),[])
        self.assertEqual(mermaid_blocks('````mermaid\ngraph TD\n```\n````'),['graph TD\n```'])

if __name__=='__main__':unittest.main()
