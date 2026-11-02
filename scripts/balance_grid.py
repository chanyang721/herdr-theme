#!/usr/bin/env python3
"""Make every six-terminal tab exactly 3 by 2, preserving pane IDs and live terminals."""
import copy
import uuid
from core_api import call


def leaves(node):
    if node.get('content',{}).get('terminal'):
        return [node]
    return [leaf for child in node.get('children',[]) for leaf in leaves(child)]


def balance_grids(document):
    changed=[]
    for space in document.get('spaces',[]):
        for tab in space.get('tabs',[]):
            old=leaves(tab['root'])
            if len(old)!=6:continue
            cells=copy.deepcopy(old)
            for cell in cells:cell['size']={'weight':1}
            tab['root']={'id':tab['root']['id'],'type':'column','children':[
                {'id':'sf-row-'+uuid.uuid4().hex,'type':'row','size':{'weight':1},'children':cells[:3]},
                {'id':'sf-row-'+uuid.uuid4().hex,'type':'row','size':{'weight':1},'children':cells[3:]}
            ]}
            assert [p['content']['terminal'] for p in leaves(tab['root'])]==[p['content']['terminal'] for p in old]
            changed.append(space.get('name','')+' / '+tab.get('name',''))
    return changed


if __name__=='__main__':
    snapshot=call('doc.get',{'name':'herdr-app'})
    changed=balance_grids(snapshot['value'])
    result=call('doc.set',{'name':'herdr-app','version':snapshot['version'],'value':snapshot['value']})
    print({'balanced':changed,'version':result['version']})
