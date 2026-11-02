import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from balance_grid import balance_grids, leaves


class GridTests(unittest.TestCase):
    def test_existing_live_ids_and_unrelated_tabs_survive(self):
        cells=[{'id':f'p{i}','type':'block','content':{'terminal':f't{i}'},'size':{'weight':i+1}} for i in range(6)]
        other={'id':'other','root':{'id':'single','type':'block','content':{'terminal':'untouched'}}}
        d={'spaces':[{'name':'example','tabs':[{'id':'tab','root':{'id':'root','type':'row','children':cells}},copy.deepcopy(other)]}]}
        balance_grids(d)
        root=d['spaces'][0]['tabs'][0]['root']
        self.assertEqual([p['id'] for p in leaves(root)],[f'p{i}' for i in range(6)])
        self.assertEqual([p['content']['terminal'] for p in leaves(root)],[f't{i}' for i in range(6)])
        self.assertEqual([r['size']['weight'] for r in root['children']],[1,1])
        self.assertTrue(all(p['size']['weight']==1 for p in leaves(root)))
        self.assertEqual(d['spaces'][0]['tabs'][1],other)


if __name__=='__main__':unittest.main()
