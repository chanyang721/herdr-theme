#!/usr/bin/env python3
"""Create one tab with six splits: four Claude and two Codex sessions by default."""
import argparse
import json
import subprocess
import time
from core_api import call
from balance_grid import balance_grids


def app(command, args):
    return json.loads(subprocess.check_output(['herdr-app','do',command,json.dumps(args)],text=True,encoding='utf-8'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name');parser.add_argument('folder')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--agents',dest='agents',action='store_true',default=True)
    mode.add_argument('--shells',dest='agents',action='store_false')
    args=parser.parse_args()
    spaces=json.loads(subprocess.check_output(['herdr-app','ls']))['spaces']
    if any(s['name']==args.name for s in spaces):
        raise SystemExit('Workspace already exists; refusing to duplicate it.')
    claude={'argv':['claude']} if args.agents else {}
    codex={'argv':['codex','--no-daemon']} if args.agents else {}
    new=app('space.new',{'name':args.name,'folder':args.folder,'tab':'개발 · 6분할',**claude})
    # The core adoption can arrive after the creation acknowledgment. Identify
    # the observed terminal rather than guessing an ID or duplicating the space.
    first=None
    for _ in range(40):
        observed=json.loads(subprocess.check_output(['herdr-app','ls']))['spaces']
        for space in observed:
            for tab in space['tabs']:
                match=next((t for t in tab['terminals'] if t['terminal']==new['terminal']),None)
                if match:
                    first=match;new.update(space=space['id'],tab=tab['id'])
        if first:break
        time.sleep(0.05)
    if first is None:raise SystemExit('Terminal created but not yet visible; inspect herdr-app ls before retrying.')
    app('space.rename',{'id':new['space'],'name':args.name})
    bottom=app('pane.split',{'pane':first['pane'],'direction':'down',**claude})
    top2=app('pane.split',{'pane':first['pane'],'direction':'right',**claude})
    top3=app('pane.split',{'pane':top2['pane'],'direction':'right',**codex})
    bottom2=app('pane.split',{'pane':bottom['pane'],'direction':'right',**claude})
    bottom3=app('pane.split',{'pane':bottom2['pane'],'direction':'right',**codex})
    for _ in range(40):
        snapshot=call('doc.get',{'name':'herdr-app'})
        target=next((s for s in snapshot['value']['spaces'] if s['id']==new['space']),None)
        def count(node):return int('terminal' in node.get('content',{}))+sum(count(c) for c in node.get('children',[]))
        if target and any(count(t['root'])==6 for t in target['tabs']):break
        time.sleep(0.05)
    else:raise SystemExit('Layout is still being saved; inspect the created workspace before retrying.')
    balance_grids({'spaces':[target]})
    call('doc.set',{'name':'herdr-app','version':snapshot['version'],'value':snapshot['value']})
    order=[first,top2,top3,bottom,bottom2,bottom3]
    if args.agents:
        for terminal,kind in zip(order,['claude','claude','codex','claude','claude','codex']):
            address=terminal['terminal']
            subprocess.run(['hc','label',address,'sixfold.native-agent='+kind],check=True,capture_output=True)
    print(json.dumps({'space':new['space'],'tab':new['tab'],'terminals':order},ensure_ascii=False))


if __name__=='__main__':main()
