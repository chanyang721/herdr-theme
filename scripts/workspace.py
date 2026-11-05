#!/usr/bin/env python3
"""Create a workspace with ONE coordinating Claude session. More panes are added later by the
harness `dispatch` when work arrives, and finished panes are closed by the observer.

--tiers <tier> opens that one pane on the model for the tier (low|mid|high|max, default high).
The plan is kept in data/sixfold/space-tiers.json. A site.local.json "new_space_tiers" list
(old six-pane setting) is used only as a fallback: its first value, with a warning. Tier -> model
and effort come from "model_tiers" (ADR-0008, scripts/model_tier.py)."""
import sys
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from agent_env import launch_argv
import model_tier
import site_config


def pane_tier(site,given=None):
    """The one pane's tier: --tiers first, else the FIRST site new_space_tiers value (warned), else high.
    More than one tier on the command line is refused before any pane opens."""
    if given:
        tiers=[t.strip() for t in given.split(',')]
        if len(tiers)!=1:
            raise SystemExit('--tiers는 세션 1개의 tier 하나만 받습니다(low|mid|high|max). 칸은 dispatch로 늘립니다.')
        tier=tiers[0]
    else:
        configured=site.get('new_space_tiers')
        if isinstance(configured,list) and configured:
            print('경고: site.local.json new_space_tiers는 더 이상 칸 6개를 열지 않습니다. 첫 값만 쓰고 나머지는 무시합니다.',file=sys.stderr)
            tier=configured[0]
        else:
            tier=None
    try:
        return model_tier.tier_name(tier)
    except ValueError as error:
        raise SystemExit(str(error)) from None


def remember(space,name,launched,by):
    """Keep which tier and model each pane was opened with, and who decided it (0600, this machine only)."""
    data=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))/'data/sixfold'
    data.mkdir(parents=True,exist_ok=True)
    path=data/'space-tiers.json'
    try:
        book=json.loads(path.read_text(encoding='utf-8'))
    except (OSError,ValueError):
        book={}
    book[space]={'name':name,'by':by,'at':int(time.time()),'panes':launched}
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(book,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def app(command, args):
    return json.loads(subprocess.check_output(['herdr-app','do',command,json.dumps(args)],text=True,encoding='utf-8'))


def view():
    """(space, tab, focused pane, {terminal: pane}) the window shows now, or None when unreadable.
    `herdr-app ls` lists only terminals, so a mod pane or tab (a document, a sidebar) is never in the map."""
    try:
        status=json.loads(subprocess.check_output(['herdr-app','status'],text=True,encoding='utf-8'))
        spaces=json.loads(subprocess.check_output(['herdr-app','ls']))['spaces']
        panes={t.get('terminal'):t.get('pane') for space in spaces for tab in space.get('tabs',[]) for t in tab.get('terminals',[])}
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError):
        return None
    if not isinstance(status,dict):return None
    return (status.get('space'),status.get('tab'),status.get('focused_pane'),panes)


def took_selection(before,reply,after):
    """True only when the selection sits on a tab or pane this creation made. When its reply names
    what it created (pane, terminal or tab), only those ids count; whatever else appeared in the
    window meanwhile belongs to someone else. Only when the creation failed or named nothing, so its
    ids are unknown, is a terminal pane that was not listed before treated as ours. An old terminal
    or a mod pane the person chose is never ours."""
    reply=reply if isinstance(reply,dict) else {}
    if any(reply.get(k) for k in ('pane','terminal','tab')):
        mine={reply.get('pane'),after[3].get(reply.get('terminal'))}
        mine.discard(None)
        return after[2] in mine or bool(reply.get('tab') and after[1]==reply.get('tab'))
    # Known limit (pinned by a test): if the creation failed and its ids are unknown, a new terminal that
    # another process made at the same moment and the person then chose looks like our half-made one, so
    # the earlier selection is put back. Not restoring would leave the window moved after a partial failure.
    return after[2] in (set(after[3].values())-set(before[3].values()))


def restore_view(before,reply):
    """Creating a space must not change what the person is looking at. herdr-app's space.new has
    no option for that, so the selection is compared afterwards. If what the creation made took
    it, the earlier selection (space, tab, pane) is put back; a selection the person made on
    anything else is left alone. Best effort: a failure here never undoes the new space."""
    after=view()
    if not before or not after or not took_selection(before,reply,after):return
    for index,(command,key) in enumerate((('space.select','id'),('tab.select','id'),('pane.focus','pane'))):
        if before[index] and after[index]!=before[index]:
            try:app(command,{key:before[index]})
            except (OSError,ValueError,subprocess.SubprocessError):pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name');parser.add_argument('folder')
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--agents',dest='agents',action='store_true',default=True)
    mode.add_argument('--shells',dest='agents',action='store_false')
    parser.add_argument('--tiers',help='tier of the single session (low|mid|high|max, default high)')
    parser.add_argument('--by',default=os.environ.get('HC_TERMINAL_ID'),help='who decided the tiers (default: this session)')
    args=parser.parse_args()
    spaces=json.loads(subprocess.check_output(['herdr-app','ls']))['spaces']
    if any(s['name']==args.name for s in spaces):
        raise SystemExit('Workspace already exists; refusing to duplicate it.')
    # Opened from inside an agent, a pane inherits its markers (child-session Claude, parent pane id).
    if args.tiers and not args.agents:
        raise SystemExit('--tiers는 에이전트 칸에만 쓸 수 있습니다(--shells와 함께 쓰지 않음).')
    tier=pane_tier(site_config.load(),args.tiers) if args.agents else None
    launched=[]
    spec={}
    if args.agents:
        used,entry=model_tier.model_for('claude',tier)
        launched.append({'kind':'claude','tier':tier,'tier_used':used,'model':(entry or {}).get('model'),
                         'effort':(entry or {}).get('effort')})
        spec={'argv':launch_argv(['claude']+model_tier.flags('claude',entry))}
    before=view()
    new=None
    try:
        new=app('space.new',{'name':args.name,'folder':args.folder,'tab':'개발',**spec})
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
    finally:
        restore_view(before,new)
    if args.agents:
        subprocess.run(['hc','label',first['terminal'],'sixfold.native-agent=claude'],check=True,capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        launched[0]['terminal']=first['terminal']
        remember(new['space'],args.name,launched,args.by)
    print(json.dumps({'space':new['space'],'tab':new['tab'],'terminals':[first],
                      **({'tiers':launched} if args.agents else {})},ensure_ascii=False))


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
