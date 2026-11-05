#!/usr/bin/env python3
"""Create one tab with six splits: four Claude and two Codex sessions by default.

site.local.json "new_space_tiers" (optional) opens some panes on a lighter model: six tiers in
pane order (top-left, top-middle, top-right, bottom-left, bottom-middle, bottom-right), e.g.
["high", "mid", "high", "high", "low", "high"]. Without it every pane starts on the CLI default,
as before. Tier → model comes from "model_tiers" (ADR-0008, scripts/model_tier.py)."""
import sys
import argparse
import json
import subprocess
import time
from core_api import call
from balance_grid import balance_grids
from agent_env import launch_argv
import model_tier
import site_config


KINDS=['claude','claude','codex','claude','claude','codex']


def pane_plan(site):
    """Six tiers (or None = CLI default) in pane order; anything but a list of six is refused."""
    tiers=site.get('new_space_tiers')
    if tiers is None:return [None]*6
    if not isinstance(tiers,list) or len(tiers)!=6:
        raise SystemExit('site.local.json new_space_tiers는 칸 순서대로 6개 tier 목록이어야 합니다.')
    return [model_tier.tier_name(t) for t in tiers]


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
    # Opened from inside an agent, a pane inherits its markers (child-session Claude, parent pane id).
    plan=pane_plan(site_config.load()) if args.agents else [None]*6
    def agent(kind,tier):
        if not args.agents:return {}
        base=['claude'] if kind=='claude' else ['codex','--no-daemon']
        model=model_tier.model_for(kind,tier)[1] if tier else None
        return {'argv':launch_argv(base+model_tier.flag(kind,model))}
    # Pane order matches KINDS: first, top2, top3, bottom, bottom2, bottom3.
    argv=[agent(kind,tier) for kind,tier in zip(KINDS,plan)]
    new=app('space.new',{'name':args.name,'folder':args.folder,'tab':'개발 · 6분할',**argv[0]})
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
    bottom=app('pane.split',{'pane':first['pane'],'direction':'down',**argv[3]})
    top2=app('pane.split',{'pane':first['pane'],'direction':'right',**argv[1]})
    top3=app('pane.split',{'pane':top2['pane'],'direction':'right',**argv[2]})
    bottom2=app('pane.split',{'pane':bottom['pane'],'direction':'right',**argv[4]})
    bottom3=app('pane.split',{'pane':bottom2['pane'],'direction':'right',**argv[5]})
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
        for terminal,kind in zip(order,KINDS):
            address=terminal['terminal']
            subprocess.run(['hc','label',address,'sixfold.native-agent='+kind],check=True,capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    print(json.dumps({'space':new['space'],'tab':new['tab'],'terminals':order},ensure_ascii=False))


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
