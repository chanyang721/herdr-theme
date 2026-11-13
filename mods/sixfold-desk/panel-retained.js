import {View,div,svg} from 'gpui-kit';
import {h_flex,v_flex,InputState,Input} from 'gpui-base';
import {theme,spaces,shared,setShared,settings,window,exec,appHome,readTextFile,writeTextFile} from 'herdr';
import {issueAlerts,issueAlertSignature,alertedIssues,issueReadTargets,groupReadTargets} from './alert-model.js';
import {requestReads,checkReads,readPendingIds,lastReadError,READ_POLL_MS} from './linear-reads.js';
import {autoView,autoSignature} from './linear-auto-model.js';
import {approve,local,busyKeys,doneIds,autoError,checkApprovals,settleLedger,AUTO_POLL_MS} from './linear-auto.js';
import {autoGroup} from './linear-auto-view.js';
import {projectPanelFeed,panelEventStates,panelSpaces,panelSpacePartners,PANEL_TIMING,PANEL_LEGS,panelLeg,agentReason} from './panel-model.js';
import {panelLayout,cardView,agentRow,panelFlowLayer,panelCounts,PANEL_GEOMETRY,toolIcon,panelReasonWake,agentRowHeight,panelMetaHeight,rowArrival} from './panel-view.js';
import {groupColors,paletteMode} from './collab-flow.js';
import {issuePopover,alertedGroup} from './task-issues-view.js';
import {issueScopeData,issueCacheLabel,parseTimelineFeed,spaceWithTimeline,rowStatus,milestoneSource} from './task-issue-state.js';
import {ensure,cached,waiting,checkCaches,anyWaiting,CACHE_POLL_MS,LOOK_POLL_MS} from './linear-cache.js';
import {statusIndex,teamStatuses,statusFilters,filterRows,foldedCount,milestoneList,detailData} from './issue-model.js';
import {nativeTaskSpace,hostedTaskLayout,panelWidthClass} from './panel-host.js';

// Each retained entity receives only a local controller key. Display data stays
// in this generation's registry, not in persisted shared state (which refreshes
// every mod). Only the entity whose data changed is invalidated.
const registry=globalThis.__sixfoldPanelControllers??=new Map();
const read=props=>registry.get(props.key);
const signature=value=>JSON.stringify(value);
// A native input handle answers value() until it is released; afterwards every use throws.
const inputAlive=input=>{if(!input)return false;try{input.value();return true;}catch{return false;}};
const label=(value,color,size=10)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const countRenders=(c,kind,id='all')=>{const key=`${kind}:${id}`;c.stats.renders[key]=(c.stats.renders[key]||0)+1;};

class PanelRow extends View{
  init(props){this.key=props.key;this.id=props.id;}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'row',this.id);
    const agent=c.projection?.agents.get(this.id),space=c.agentSpaces.get(this.id);
    if(!agent||!space)return div();
    return agentRow(c,agent,space,c.events.tags.get(agent.id),c.events,c.color(space.bundle||space.id),theme(),c.motion);
  }
}
// A card's issue search and comment inputs are created by the card itself, in init() and
// update(): the native store gives retained state to the view whose call created it, so an
// input made in an event handler belongs to whichever view ran that event (a peek, a popup)
// and dies with it while this card still draws it. Released inputs are replaced here, never
// in render; render only leaves them out.
class PanelSpace extends View{
  init(props){this.key=props.key;this.id=props.id;read(this)?.adoptInputs?.(this.id);}
  update(props){this.key=props.key;this.id=props.id;read(this)?.adoptInputs?.(this.id);}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'space',this.id);
    const geometry=c.layout?.cards.find(card=>card.space.id===this.id),space=c.spaceMap.get(this.id);
    if(!geometry||!space)return div();
    const groups=c.projection.groups.get(this.id);
    const rows=geometry.rows.map(row=>row.kind==='agent'?{...row,agent:c.projection.agents.get(row.agent.id)}
      :row.kind==='issue'?{...row,group:groups.groups.find(group=>group.issue?.key===row.group.issue?.key)}:row);
    c.alertMarks?.set(this.id,c.alertMark(space));   // what this render shows; alertsChanged redraws only when it differs
    return cardView(c,{...geometry,space,groups,rows},c.events,c.color(space.bundle||space.id),c.names,theme(),c.motion,c.rows,{bodyOnly:c.embedded});
  }
}
class PanelComputers extends View{
  init(props){this.key=props.key;}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'computers');const t=theme();
    return v_flex().flex_none()
      .child(h_flex().h(24).px(10).items_center().child(label('COMPUTERS',t.dim).font_bold()))
      .children((c.feed?.computers||[]).map(computer=>h_flex().id(`panel-computer-${computer.id}`).h(32).mb(4).ml(8).mr(40).px(7).gap(6).items_center().rounded(5).bg(t.surface)
        .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(15).flex_none().text_color(c.color(computer.bundle)))
        .child(label(computer.name,t.foreground,11).flex_1())
        .when(computer.traffic.up!==null||computer.traffic.down!==null,e=>e.child(label(`↑${computer.traffic.up??'—'} ↓${computer.traffic.down??'—'}`,t.dim,9)))
        .child(div().size(5).flex_none().rounded(1).border(1).border_color(computer.linked?c.color(computer.bundle):t.dim).when(computer.linked,e=>e.bg(c.color(computer.bundle))))));
  }
}
class PanelSummary extends View{
  init(props){this.key=props.key;}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'summary');const t=theme();
    const counts=panelCounts(c.feed);
    return h_flex().h(32).px(12).gap(12).items_center()
      .child(label(`◌ ${counts.working}`,t.accent,12))
      .when(counts.blocked>0,e=>e.child(label(`! ${counts.blocked}`,t.blocked,12)))
      .when(counts.done>0,e=>e.child(label(`✓ ${counts.done}`,t.dim,12)))
      .when(c.status!=='ready',e=>e.child(label('최근 표시 유지',t.blocked)));
  }
}
class PanelFlows extends View{
  init(props){this.key=props.key;}
  render(){
    const c=read(this);if(!c||!c.feed||!c.layout)return div();countRenders(c,'flows');
    return panelFlowLayer(c.feed,c.layout,c.events,c.color,theme(),c.motion,c.panelWidth);
  }
}
class PanelList extends View{
  init(props){this.key=props.key;}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'list');const t=theme();
    return v_flex().relative().flex_none().child(c.computers)
      .child(h_flex().h(28).px(10).items_center().child(label('SPACES',t.dim).font_bold()))
      .children((c.feed?.spaces||[]).map(space=>c.cards.get(space.id)).filter(Boolean)).child(c.flows);
  }
}
class PanelRoot extends View{
  init(props,cx){this.key=props.key;const c=read(this);c.cx=cx;}
  close(){read(this)?.dispose();}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'root');const t=theme();
    return v_flex().id('sixfold-sidebar').size_full().bg(t.chrome).text_color(t.foreground)
      .on_size_change((size,cx)=>c.resize(size.width/(settings().zoom||1),cx))
      .child(h_flex().h(48).flex_none().pl(c.macTitlebar?76:20).pr(10).gap(8).items_center()
        .child(label('Herdr Theme',t.foreground,14).font_bold().flex_1())
        .child(div().id('panel-workspaces').text_size(10).text_color(t.muted).cursor_pointer().tooltip('워크스페이스 목록')
          .on_click(()=>{setShared('sixfold.panel.enabled',false);c.onClassic?.();}).child('목록'))
        .child(div().id('panel-motion').text_size(10).text_color(t.dim).cursor_pointer()
          .on_click(()=>{setShared('sixfold.motion',shared('sixfold.motion')===false);c.preferences();}).child(c.motion?'Motion on':'Motion off')))
      .child(c.summary).child(div().id('panel-scroll').flex_1().min_h(0).overflow_y_scroll().child(c.list));
  }
}

export function createRetainedPanel(cx,{macTitlebar=false,onClassic=null,onDispose=null,onIssueRequest=null,embedded=false,onHostChange=null,schedule=fn=>fn(),cardAlerts=null,slackAlerts=null,cardBadges=null}={}){
  const prune=()=>{
  for(const previous of [...registry.values()]){
    let retired=previous.protocol!=='2';try{retired||=previous.life?.is_done()===true;}catch{retired=true;}
    if(retired){
      // Earlier generations can contain handles already released by the host.
      // Always retire their registry entry even if their old cleanup throws.
      try{previous.dispose();}catch{}finally{registry.delete(previous.key);}
    }
  }
  };
  prune();
  // Replacement init runs before the host commits retirement of the old
  // generation. Recheck once after that transaction, without a polling loop.
  cx.timer.after(0,prune);
  const serial=globalThis.__sixfoldPanelControllerSerial=(globalThis.__sixfoldPanelControllerSerial||0)+1;
  const key=`panel-${serial}-${Date.now()}`;
  const c={key,protocol:'2',macTitlebar,onClassic,embedded,onHostChange,panelWidth:224,visible:typeof window!=='function'||window()?.visible!==false,enabled:true,feed:null,input:null,projection:null,
    rows:new Map(),cards:new Map(),rowKeys:new Map(),cardKeys:new Map(),spaceMap:new Map(),agentSpaces:new Map(),
    names:new Map(),issueStates:new Map(),expandedIssueSpaces:new Set(),expandedParents:new Set(),rowMeta:new Map(),events:null,status:'missing',wake:null,wakeAt:null,stats:{updates:0,notifications:0,renders:{},projections:[]},
    color:()=>theme().accent,motion:false,disposed:false,onDispose,
    life:typeof cx.spawn==='function'?cx.spawn(()=>new Promise(()=>{})):null};
  registry.set(key,c);
  const make=(Class,id)=>cx.new(Class,{key,...(id?{id}:{})});
  c.entity=make(PanelRoot);c.computers=make(PanelComputers);c.summary=make(PanelSummary);c.flows=make(PanelFlows);c.list=make(PanelList);
  c.notify=entity=>{if(entity&&!c.disposed){c.stats.notifications++;c.cx.notify(entity);}};
  c.taskFor=space=>nativeTaskSpace(c.feed,space);
  // Alert counts on the card's meta line come from the host (Slack and Linear feeds).
  c.cardAlerts=cardAlerts?space=>cardAlerts(space,c.motion):null;c.slackAlerts=slackAlerts;
  // The host's workspace badges with a state ride on the same line: {key, view(t)} or null.
  c.cardBadges=cardBadges?space=>space.native?cardBadges(space.native):null:null;
  // New alerts redraw a card only when what it shows changed: its meta-line counts, and the
  // alerted issues of an open issue search. Bounded by the number of cards; no timer.
  c.alertMarks=new Map();
  c.alertMark=space=>{
    const state=c.issueStates.get(space.id);
    return JSON.stringify([c.cardAlerts?.(space)||null,c.cardBadges?.(space)?.key||null,state?.open?issueAlertSignature(shared('sixfold.linearItems')??[],space.name):'',shared('sixfold.alertPopover')?.space===space.name?shared('sixfold.alertPopover'):null,
      state?.open?[[...readPendingIds()].sort().join(','),lastReadError()]:null,
      state?.open?[autoSignature(shared('sixfold.linearAuto'),space.name),[...busyKeys()].sort().join(','),[...doneIds()].sort().join(','),autoError()]:null]);
  };
  // Read marks: one request per alert (the collector runs it once through its guard). While any is
  // pending, its result is read every READ_POLL_MS; the timer stops when none is left (at most 3 min).
  c.readTimer=null;
  c.pollReads=()=>{
    if(c.disposed||c.readTimer||!readPendingIds().size)return;
    c.readTimer=c.cx.timer.after(READ_POLL_MS,()=>{c.readTimer=null;if(c.disposed)return;
      c.cx.spawn(async()=>{try{await checkReads();}catch{}c.alertsChanged();c.pollReads();});});
  };
  // Linear details read only on demand (the collector's read-only runner answers into linear-cache/):
  // the space's milestones, issues and statuses when its issue search opens, an issue when its
  // detail opens. While anything is read, or a pressed write runs, its file is checked.
  c.cacheTimer=null;c.statusMemo=new Map();
  c.askLinear=(kind,target,force=false)=>{if(typeof c.cx.spawn!=='function')return;c.cx.spawn(async()=>{try{await ensure(kind,target,{force});}catch{}c.pollCaches();c.repaintIssues();});c.pollLook();};
  // While an issue search stays open, its reads (and the open detail's) are asked again every
  // LOOK_POLL_MS: ensure asks nothing while they are fresh, so this stays quiet; it repaints only
  // through the cache check when an answer comes. The timeline file is read again too (it repaints
  // only when its `updated` changes). Stops once every search is closed.
  c.lookTimer=null;
  c.pollLook=()=>{
    if(c.disposed||c.lookTimer||typeof c.cx.spawn!=='function'||![...c.issueStates.values()].some(state=>state.open))return;
    c.lookTimer=c.cx.timer.after(LOOK_POLL_MS,()=>{c.lookTimer=null;if(c.disposed)return;
      c.cx.spawn(async()=>{
        for(const [id,state] of c.issueStates){
          const space=c.spaceMap.get(id);if(!state.open||!space)continue;
          try{await ensure('project',space.name);if(state.detail)await ensure('issue',state.detail);}catch{}
        }
        c.loadTimeline();c.pollCaches();c.pollLook();});});
  };
  c.repaintIssues=()=>{for(const [id,state] of c.issueStates)if(state.open)c.notify(c.cards.get(id));};
  c.pollCaches=()=>{
    const writing=[...c.issueStates.values()].some(state=>state.write&&!state.write.done);
    if(c.disposed||c.cacheTimer||(!anyWaiting()&&!writing))return;
    c.cacheTimer=c.cx.timer.after(CACHE_POLL_MS,()=>{c.cacheTimer=null;if(c.disposed)return;
      c.cx.spawn(async()=>{
        try{await checkCaches();}catch{}
        for(const [id,state] of c.issueStates)if(state.write&&!state.write.done)await c.checkWrite(id,state);
        c.repaintIssues();c.pollCaches();});});
  };
  // A pressed write from the detail ([상태 변경] or [댓글]): one request file, run once by the collector's guard.
  c.writeIssue=(space,state,action,fields)=>{
    if(!state.detail||state.write&&!state.write.done)return;
    const now=new Date(),id=`${now.getTime().toString(36)}-${Math.random().toString(36).slice(2,10).padEnd(8,'0')}`;
    const request={v:1,id,action,requested_at:now.toISOString(),issue:state.detail,...fields};
    state.write={id,action,key:state.detail,at:now.getTime(),done:false};state.writeNote='처리 중…';
    c.cx.spawn(async()=>{
      try{await writeTextFile(`${appHome()}/data/sixfold/linear-actions/${id}.json`,JSON.stringify(request),null);}
      catch(error){state.write.done=true;state.writeNote=`실패: 요청을 남기지 못했습니다`;}
      c.notify(c.cards.get(space.id));c.pollCaches();
    });
  };
  c.checkWrite=async(id,state)=>{
    const w=state.write;
    const text=await readTextFile(`${appHome()}/data/sixfold/linear-actions/results/${w.id}.json`).catch(()=>null);
    if(!text){if(Date.now()-w.at>5*60*1000){w.done=true;state.writeNote='실패: 응답이 없습니다. Linear에서 확인해 주세요';}return;}
    let result=null;try{result=JSON.parse(text);}catch{return;}
    w.done=true;
    state.writeNote=result?.ok?(w.action==='comment'?'댓글을 남겼습니다':'상태를 바꿨습니다'):`실패: ${String(result?.error||'이유 미확인').slice(0,120)}`;
    if(result?.ok){
      if(w.action==='comment'){const comment=c.issueInputs.get(id)?.comment;if(inputAlive(comment))comment.set_value('');}
      state.menu=null;
      const space=c.spaceMap.get(id);
      c.askLinear('issue',w.key,true);if(space&&w.action==='set_state')c.askLinear('project',space.name,true);
    }
  };
  c.issueExtra=(space,state,data)=>{
    const items=shared('sixfold.linearItems')??[];
    const project=cached('project',space.name);
    let memo=c.statusMemo.get(space.id);
    if(!memo||memo.project!==project){memo={project,index:statusIndex(project)};c.statusMemo.set(space.id,memo);}
    for(const id of c.statusMemo.keys())if(!c.spaceMap.has(id))c.statusMemo.delete(id);
    // The catalog (the feed's, or one made from the timeline) and the Linear project cache both name
    // each issue's status; whichever was read later wins, the other fills the keys it lacks. A
    // catalog status takes its type from the same-named status of the issue's own team in the cache;
    // without a team match, only a name every team types alike is used, else the row keeps its own
    // provider type or normalized state.
    let rowIndex=c.rowStatusMemo?.get(space.id);
    if(!rowIndex||rowIndex.catalog!==space.issue_catalog||rowIndex.project!==project){
      const teams=project?.statuses&&typeof project.statuses==='object'?project.statuses:{};
      const named=new Map(),clash=new Set();
      for(const list of Object.values(teams))for(const s of Array.isArray(list)?list:[]){
        if(!s?.name)continue;const seen=named.get(s.name);
        if(!seen)named.set(s.name,s);else if(seen.type!==s.type)clash.add(s.name);
      }
      for(const name of clash)named.delete(name);
      const teamOf=new Map((Array.isArray(project?.issues)?project.issues:[]).filter(i=>i?.key&&i.team).map(i=>[i.key,i.team]));
      const knownFor=row=>{const list=teams[row.team||teamOf.get(row.key)];
        const own=Array.isArray(list)?list.find(s=>s?.name===row.status):null;return own?new Map([[own.name,own]]):named;};
      rowIndex={catalog:space.issue_catalog,project,map:new Map((space.issue_catalog?.all||[]).filter(i=>i.status).map(i=>[i.key,rowStatus(i,knownFor(i))]))};
      (c.rowStatusMemo||(c.rowStatusMemo=new Map())).set(space.id,rowIndex);
    }
    const projectAt=project&&(project.state===undefined||project.state==='ok')?Date.parse(project.at||''):NaN;
    const catalogAt=Date.parse(space.issue_catalog?.updated_at||space.issue_catalog?.cache?.at||'');
    const cacheFirst=Number.isFinite(projectAt)&&(!Number.isFinite(catalogAt)||projectAt>catalogAt);
    const statusOf=project||rowIndex.map.size?key=>(cacheFirst?memo.index.get(key)||rowIndex.map.get(key):rowIndex.map.get(key)||memo.index.get(key))||null:null;
    const rows=data.rows||[];
    const lookup=statusOf||(()=>null);
    const unreadKeys=new Set(items.filter(i=>!i.read&&i.workspace===space.name&&i.issue).map(i=>i.issue));
    const milestones=milestoneList(milestoneSource(space,project),space.issue_catalog,unreadKeys);
    const writes=shared('sixfold.linearWrites')??[];
    const onDetail=key=>{
      state.detail=key||null;state.menu=null;state.writeNote='';state.hoverKey=null;
      if(key)c.askLinear('issue',key);
      c.notify(c.cards.get(space.id));
    };
    let detail=null;
    if(state.detail){
      const key=state.detail;
      const row=['week','milestone','all'].flatMap(scope=>space.issue_catalog?.[scope]||[]).find(issue=>issue.key===key)||(project?.issues||[]).find(issue=>issue.key===key)||null;
      detail=detailData(key,{issueCache:cached('issue',key),row,status:lookup(key),agents:space.agents||[],alerts:issueAlerts(items,space.name,key,6)?.lines||[]});
    }
    return {
      statusOf,hoverKey:state.hoverKey||null,
      onHover:(key,own)=>{if(key?state.hoverKey!==key:state.hoverKey===own){state.hoverKey=key;c.notify(c.cards.get(space.id));}},
      filters:statusOf?statusFilters(rows,lookup):[],filter:state.filter||'전체',
      shownRows:statusOf?filterRows(rows,lookup,state.filter||'전체',state.showFolded===true):rows,
      foldedCount:statusOf&&(state.filter||'전체')==='전체'?foldedCount(rows,lookup):0,showFolded:state.showFolded===true,
      onFilter:name=>{state.filter=name;c.notify(c.cards.get(space.id));},
      onShowFolded:value=>{state.showFolded=value;c.notify(c.cards.get(space.id));},
      milestones,milestonesCounted:milestones.some(m=>m.counted&&m.progress!==null),expanded:state.expanded||(state.expanded=new Set()),
      projectWaiting:waiting('project',space.name),
      onMilestone:id=>{const set=state.expanded||(state.expanded=new Set());set.has(id)?set.delete(id):set.add(id);if(set.size>20)set.delete(set.values().next().value);c.notify(c.cards.get(space.id));},
      onDetail,detail,detailWaiting:detail?waiting('issue',detail.key):false,
      writes,menu:state.menu||null,writeNote:state.writeNote||'',
      statuses:detail?teamStatuses(project,detail.team):[],
      onMenu:menu=>{state.menu=menu;if(menu==='comment')c.ensureInputs(space.id);c.notify(c.cards.get(space.id));},
      commentBox:state.menu==='comment'?c.inputElement(space.id,'comment')?.flex_1().h(30)??null:null,
      onSetState:name=>{if(writes.includes('set_state'))c.writeIssue(space,state,'set_state',{state:name});},
      onComment:()=>{
        const comment=c.issueInputs.get(space.id)?.comment;
        const body=inputAlive(comment)?String(comment.value()||''):'';
        if(!writes.includes('comment'))return;
        if(!body.trim()||body.length>4000){state.writeNote='실패: 댓글 내용을 입력하세요 (4000자 이하)';c.notify(c.cards.get(space.id));return;}
        c.writeIssue(space,state,'comment',{body});
      },
    };
  };
  // Linear auto work ('자동 작업'): a pressed approval drops one request file; while any is busy its
  // result is read every AUTO_POLL_MS (the ledger itself arrives through watchLinear).
  c.autoTimer=null;
  c.pollAuto=()=>{
    if(c.disposed||c.autoTimer||!busyKeys().size)return;
    c.autoTimer=c.cx.timer.after(AUTO_POLL_MS,()=>{c.autoTimer=null;if(c.disposed)return;
      c.cx.spawn(async()=>{try{await checkApprovals();}catch{}c.alertsChanged();c.pollAuto();});});
  };
  c.autoAct=(space,act)=>{c.cx.spawn(async()=>{try{await act();}catch{}c.alertsChanged();c.notify(c.cards.get(space.id));c.pollAuto();});};
  c.autoFor=(space,t)=>{
    const view=autoView(shared('sixfold.linearAuto'),space.name),writes=shared('sixfold.linearWrites')??[];
    settleLedger(view);
    const doc=()=>`${appHome()}/scripts/sixfold/herdr-theme${window?.()?.platform==='windows'?'.exe':''}`;
    return autoGroup({id:space.id,view,busy:busyKeys(),done:doneIds(),error:autoError(),
      onApprove:(r,part)=>c.autoAct(space,()=>approve(r,[part],writes)),
      onApplyAll:r=>c.autoAct(space,()=>approve(r,['comment','state'],writes)),
      // [수정]: the draft opens in the space's 문서 tab; [댓글 올리기] then posts the edited text.
      onEdit:r=>{if(r.proposal?.draft)c.cx.spawn(async()=>{await exec(doc(),['open_doc_tab',r.proposal.draft,'--space',space.id]).catch(()=>{});});},
      onDiscard:r=>c.autoAct(space,()=>local(r,'discard')),
      onStart:r=>c.autoAct(space,()=>local(r,'start')),
      onLink:url=>{if(/^https:\/\/linear\.app\//.test(url))c.cx.spawn(async()=>{await exec('open',[url]);});}},t);
  };
  // Any issue search open: a new alert then only counts on its chip (no peek over it).
  c.anyIssuesOpen=()=>[...c.issueStates.values()].some(state=>state.open);
  // A peek: the top of a space's issue search ('알림 온 이슈') opened by new alerts, drawn by the
  // arrival layer in a Popup, which takes no focus. Pressing its title opens the real search.
  c.peekIssues=(name,fresh,t)=>{
    const space=[...c.spaceMap.values()].find(item=>item.name===name);if(!space)return null;
    const items=shared('sixfold.linearItems')??[];
    const group=alertedGroup({id:`peek-${space.id}`,alerted:alertedIssues(items,space.name,''),fresh:new Set(fresh),
      readable:(shared('sixfold.linearWrites')??[]).includes('mark_read'),readPending:readPendingIds(),readError:lastReadError(),
      doneKeys:new Set((space.issues||[]).filter(issue=>issue.state==='done').map(issue=>issue.key)),
      issueTargets:key=>issueReadTargets(items,space.name,key),onRead:alerts=>c.markRead(alerts,'opened',space),
      onReadAll:()=>c.markRead(groupReadTargets(items,space.name,''),'all',space),
      onLink:(url,context,alerts)=>{if(/^https:\/\/linear\.app\//.test(url)){(context||c.cx).spawn(async()=>{await exec('open',[url]);});if(alerts?.length)c.markRead(alerts,'opened',space);}}},t);
    if(!group)return null;
    return v_flex().id(`task-issues-peek-${space.id}`).w(440).gap(8).p(12).rounded(10).border(1).border_color(t.accent)
      .bg(t.popover||t.surface).text_color(t.foreground)
      .child(h_flex().id(`task-issues-peek-head-${space.id}`).gap(8).items_center().cursor_pointer().tooltip('누르면 이슈 검색을 엽니다')
        .on_click((_event,cx)=>{cx.stop_propagation();c.openIssues(space);})
        .child(toolIcon(space.work?.tool||'linear',t).size(20))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_bold().child(`${space.name} · 이슈 검색`))
        .child(div().px(6).rounded(7).text_size(10).font_bold().bg(t.accent).text_color(t.accent_foreground||t.background).child('새 알림')))
      .child(group);
  };
  // The open/close callback of each card's issue search (kept per space id, pruned with the cards).
  c.issueOpeners=new Map();
  c.opener=(id,fn)=>{c.issueOpeners.set(id,fn);return fn;};
  c.openIssues=space=>{c.issueOpeners.get(space.id)?.(true);};
  // Each card's {search, comment} inputs, made by adoptInputs from that card's init()/update().
  c.issueInputs=new Map();c.inputRevision=0;
  c.adoptInputs=id=>{
    if(c.disposed)return;
    const old=c.issueInputs.get(id);
    if(old&&inputAlive(old.search)&&inputAlive(old.comment))return;
    const keep=input=>inputAlive(input)?input.value():'';
    let search=null,comment=null;
    try{
      search=InputState.new({placeholder:'이슈 검색',value:c.issueStates.get(id)?.query||''});
      comment=InputState.new({placeholder:'Linear에 남길 댓글',value:keep(old?.comment)});
      search.on('change',()=>{const state=c.issueStates.get(id);if(!state||!inputAlive(search))return;state.query=search.value();c.notify(c.cards.get(id));});
    }catch{
      // No input this time (entity limit, a retired source): the card draws without one and the
      // next open or update asks again.
      for(const input of [search,comment])try{input?.release?.();}catch{}
      return;
    }
    for(const input of [old?.search,old?.comment])try{input?.release?.();}catch{}
    c.issueInputs.set(id,{search,comment});
  };
  // From an event or apply (never render): a card whose inputs were released gets new props, and
  // its update() replaces them inside the card's own call.
  c.ensureInputs=id=>{
    const inputs=c.issueInputs.get(id);
    if(c.disposed||inputs&&inputAlive(inputs.search)&&inputAlive(inputs.comment))return;
    const card=c.cards.get(id);
    if(typeof card?.set_props!=='function')return;
    try{card.set_props({key:c.key,id,inputs:++c.inputRevision});}catch{}
  };
  // A released input cannot be drawn (Input.new throws and the whole card fails to render). Leave
  // it out and mark the card; apply() or the next open/menu event repairs it.
  c.staleInputs=new Set();
  c.inputElement=(id,name)=>{
    const input=c.issueInputs.get(id)?.[name];
    if(!input)return null;
    if(inputAlive(input))try{return Input.new(input);}catch{}
    c.staleInputs.add(id);
    return null;
  };
  c.markRead=(alerts,origin,space)=>{
    c.cx.spawn(async()=>{
      try{await requestReads(alerts,origin,shared('sixfold.linearWrites')??[]);}catch{}
      c.alertsChanged();c.notify(c.cards.get(space.id));c.pollReads();
    });
  };
  // A card not drawn yet has no mark and is skipped: its first render reads the current alerts.
  c.alertsChanged=()=>{
    if(c.disposed)return;
    for(const [id,space] of c.spaceMap){
      if(!c.alertMarks.has(id))continue;
      const mark=c.alertMark(space);
      if(c.alertMarks.get(id)!==mark){c.alertMarks.set(id,mark);c.notify(c.cards.get(id));}
    }
    for(const id of c.alertMarks.keys())if(!c.spaceMap.has(id))c.alertMarks.delete(id);
    for(const id of c.issueOpeners.keys())if(!c.spaceMap.has(id))c.issueOpeners.delete(id);
  };
  c.bodyFor=space=>c.cards.get(c.taskFor(space)?.id)||null;
  c.hostFlows=(entries,computerAnchors,gutter=null)=>panelFlowLayer(c.feed,hostedTaskLayout(c.layout,entries,computerAnchors),c.events,c.color,theme(),c.motion,c.panelWidth,gutter);
  c.toggleIssues=id=>{c.expandedIssueSpaces.has(id)?c.expandedIssueSpaces.delete(id):c.expandedIssueSpaces.add(id);c.apply(c.input);};
  c.toggleChildren=id=>{c.expandedParents.has(id)?c.expandedParents.delete(id):c.expandedParents.add(id);c.apply(c.input);};
  c.settleIssue=id=>{
    const space=c.spaceMap.get(id),state=c.issueStates.get(id);if(!space||!state)return;
    let changed=false;
    for(const [key,pending] of state.pending){
      const included=space.issues.some(issue=>issue.key===key);
      const result=space.issue_catalog?.results?.find(result=>result.id===pending.id&&result.space===id);
      if(result||included===pending.desired){
        state.pending.delete(key);changed=true;
        if(result?.status==='rejected')state.error=result.code==='weekly_required'?'이번 주 이슈는 해제할 수 없습니다':result.message||'이슈 요청이 거절되었습니다';
      }
    }
    if(changed)c.notify(c.cards.get(id));
  };
  // The timeline feed (data/sixfold/week-timeline.json), read when an issue search opens; the window
  // shows it instead of the catalog when it is newer. Memoized so the catalog identity stays stable.
  c.timeline=null;c.timelineMemo=new Map();
  c.loadTimeline=()=>{if(typeof c.cx.spawn!=='function')return;c.cx.spawn(async()=>{
    let next=null;try{next=parseTimelineFeed(await readTextFile(`${appHome()}/data/sixfold/week-timeline.json`));}catch{}
    // A file that cannot be read or is not whole is 'none': the catalog comes back, no older timeline is kept.
    if(c.disposed||(next?.updated??null)===(c.timeline?.updated??null))return;
    c.timeline=next;c.repaintIssues();});};
  c.withTimeline=space=>{
    const memo=c.timelineMemo.get(space.id);
    if(memo&&memo.space===space&&memo.timeline===c.timeline)return memo.result;
    const result=spaceWithTimeline(space,c.timeline);
    c.timelineMemo.set(space.id,{space,timeline:c.timeline,result});
    for(const id of c.timelineMemo.keys())if(!c.spaceMap.has(id))c.timelineMemo.delete(id);
    return result;
  };
  c.issuePopover=(space,trigger,t)=>{
    space=c.withTimeline(space);
    const state=c.issueStates.get(space.id);
    let data={};
    if(state?.open){
      if(state.catalog!==space.issue_catalog||state.issues!==space.issues||state.scopeKey!==state.scope||state.queryKey!==state.query){
        state.catalog=space.issue_catalog;state.issues=space.issues;state.scopeKey=state.scope;state.queryKey=state.query;
        state.data=issueScopeData(space,state.scope,state.query);
      }
      data=state.data;
    }
    const cache=state?.open?issueCacheLabel(space,state.scope):null;
    const extra=state?.open?c.issueExtra(space,state,data):{};
    return issuePopover({...extra,id:space.id,trigger,open:state?.open===true,scope:state?.scope||'week',...data,
      leadingGap:PANEL_GEOMETRY.rightGutter+PANEL_GEOMETRY.padding+PANEL_GEOMETRY.border+PANEL_GEOMETRY.popoverGap,
      projectLabel:space.name,toolLabel:space.work?.tool==='jira'?'Jira':space.work?.tool==='linear'?'Linear':space.work?.tool||'업무 도구',
      icon:state?.open?toolIcon(space.work?.tool,t).size(24):null,
      updatedLabel:cache?.label,emptyLabel:cache?.emptyLabel,
      onExternal:space.work?.url?context=>context?.open_url?.(space.work.url):null,
      canImport:Boolean(onIssueRequest&&space.issue_catalog?.import_request),busyKeys:new Set(state?.pending.keys()||[]),error:state?.error,
      search:state?.open?c.inputElement(space.id,'search')?.w_full().h(30)??null:null,
      alertsFor:state?.open?key=>issueAlerts(shared('sixfold.linearItems')??[],space.name,key):null,
      alerted:state?.open?alertedIssues(shared('sixfold.linearItems')??[],space.name,state.query):[],
      auto:state?.open?c.autoFor(space,t):null,
      // Opens the comment itself (#comment-…) and confirms what was opened: the Linear notification is
      // marked read in Linear (a comment read from a linked issue only on this computer).
      onLink:(url,context,alerts)=>{if(/^https:\/\/linear\.app\//.test(url)){(context||cx).spawn(async()=>{await exec('open',[url]);});if(alerts?.length)c.markRead(alerts,'opened',space);}},
      issueTargets:state?.open?key=>issueReadTargets(shared('sixfold.linearItems')??[],space.name,key):null,
      onRead:alerts=>c.markRead(alerts,'opened',space),
      onReadAll:()=>c.markRead(groupReadTargets(shared('sixfold.linearItems')??[],space.name,state?.query||''),'all',space),
      readPending:state?.open?readPendingIds():new Set(),readError:state?.open?lastReadError():'',
      readable:(shared('sixfold.linearWrites')??[]).includes('mark_read'),
      doneKeys:new Set((space.issues||[]).filter(issue=>issue.state==='done').map(issue=>issue.key)),
      onOpen:c.opener(space.id,open=>{
        let current=c.issueStates.get(space.id);
        if(!current){
          current={open:false,scope:'week',query:'',pending:new Map(),error:null};
          c.issueStates.set(space.id,current);
        }
        // The card owns the inputs; this event (a card click or a peek's title) only asks it to
        // replace released ones.
        if(open)c.ensureInputs(space.id);
        if(open)for(const [id,other] of c.issueStates)if(id!==space.id&&other.open){other.open=false;c.notify(c.cards.get(id));}
        current.open=open;
        if(!open){current.detail=null;current.menu=null;current.hoverKey=null;}
        else{c.askLinear('project',space.name);c.loadTimeline();}
        c.notify(c.cards.get(space.id));
      }),
      onScope:scope=>{if(state&&state.scope!==scope){state.scope=scope;c.notify(c.cards.get(space.id));}},
      onPull:(key,desired)=>{
        if(!state||state.pending.has(key)||!onIssueRequest)return;
        state.error=null;state.pending.set(key,{desired,id:null});c.notify(c.cards.get(space.id));
        Promise.resolve().then(()=>onIssueRequest(space,key,desired)).then(id=>schedule(()=>{
          if(c.disposed||c.issueStates.get(space.id)!==state)return;
          const pending=state.pending.get(key);if(pending)pending.id=id;
          c.settleIssue(space.id);
          c.notify(c.cards.get(space.id));
        }),()=>schedule(()=>{
          if(c.disposed||c.issueStates.get(space.id)!==state)return;
          state.pending.delete(key);
          state.error='요청을 저장하지 못했습니다';c.notify(c.cards.get(space.id));
        }));
      },
    },t);
  };
  c.apply=(input,status=c.status)=>{
    if(c.disposed||!input)return;
    c.stats.updates++;
    const oldFeed=c.feed,oldLayoutKey=c.layoutKey,oldMotion=c.motion;
    const nextTheme=signature(theme());
    c.hostVisible=typeof window!=='function'||window()?.visible!==false;
    c.preferenceKey=signature([shared('sixfold.motion'),c.enabled,c.visible,c.hostVisible,panelWidthClass(c.panelWidth),nextTheme]);
    c.input=input;c.status=status;c.now=Date.now();
    if(!c.visible||!c.hostVisible||!c.enabled){
      c.motion=false;c.events=panelEventStates(input,Date.now(),{motion:false});
      c.wake?.cancel();c.wake=null;c.wakeAt=null;
      c.stats.hiddenSnapshots=(c.stats.hiddenSnapshots||0)+1;
      return;
    }
    const themeChanged=nextTheme!==c.themeKey;
    if(themeChanged){c.themeKey=nextTheme;c.themeRevision=(c.themeRevision||0)+1;}
    c.motion=c.visible&&c.hostVisible&&c.enabled&&shared('sixfold.motion')!==false&&input.reduced_motion!==true;
    c.events=panelEventStates(input,Date.now(),{previous:c.events,motion:c.motion});
    c.projection=projectPanelFeed(input,c.projection,{includeClosedIds:new Set(c.events.tags.keys()),expandedIssueSpaces:c.expandedIssueSpaces,expandedParents:c.expandedParents});
    c.stats.projections.push(c.projection.stats);if(c.stats.projections.length>32)c.stats.projections.shift();
    c.feed=c.projection.feed;
    const native=panelSpaces(c.feed,spaces());c.spaceMap=new Map(native.map(space=>[space.id,space]));
    c.agentSpaces=new Map(native.flatMap(space=>space.agents.map(agent=>[agent.id,space])));
    c.rowMeta=new Map([...c.projection.groups.values()].flatMap(group=>[...group.rowMeta]));
    c.names=new Map(c.feed.computers.map(computer=>[computer.id,computer.name]));
    const paletteKeys=[...c.feed.spaces.map(space=>space.bundle||space.id),...c.feed.computers.map(computer=>`computer:${computer.id}`)];
    const paletteKey=signature([paletteKeys,paletteMode(theme())]);
    if(paletteKey!==c.paletteKey){
      c.paletteKey=paletteKey;c.palette=groupColors(paletteKeys,paletteMode(theme()));
      c.color=value=>c.palette.get((value||'').trim().toLowerCase())?.color||theme().accent;
    }
    const topology=c.feed.spaces.map(space=>{
      const group=c.projection.groups.get(space.id);
      // The meta line comes and goes with Slack / work-tool links and moves every row below it.
      return [space.id,panelMetaHeight(space),group.grouped,group.grouped?group.groups.map(g=>[g.issue?.key,g.agents.map(a=>a.id),g.folds]):[group.agents.map(a=>a.id),group.folds],group.issueHidden,group.issuesExpanded];
    });
    // Row height depends on the parent relation (child rows are 20px) and on a
    // reason line, so both belong to the layout key even when order is unchanged.
    const rowHeights=c.feed.spaces.flatMap(space=>space.agents.map(agent=>{
      const parent=c.rowMeta.get(agent.id)?.parent||null;
      return [agent.id,parent,agentRowHeight(agent,Boolean(parent))];
    }));
    c.layoutKey=signature([c.feed.computers.map(computer=>computer.id),topology,rowHeights]);
    if(c.layoutKey!==oldLayoutKey)c.layout=panelLayout(c.feed,c.events,spaces(),c.projection.groups);
    else if(c.layout)c.layout={...c.layout,cards:c.layout.cards.map(card=>({...card,space:c.spaceMap.get(card.space.id)}))};
    let structure=false;
    for(const space of c.feed.spaces){
      for(const agent of space.agents){
        if(!c.rows.has(agent.id))c.rows.set(agent.id,make(PanelRow,agent.id));
        const tag=c.events.tags.get(agent.id),ping=rowArrival(c.events,agent.id);
        const born=c.events.spawning.has(agent.id);
        const revealed=c.motion&&born&&c.events.active.some(event=>event.to===agent.id&&(event.kind==='spawn'||event.allocation?.kind==='new')&&event.elapsed>=PANEL_TIMING.packetMs);
        const rowKey=signature([agent,agentReason(agent,c.now).text,c.rowMeta.get(agent.id),tag?.id||null,tag?.label||null,ping,born,revealed,c.motion,panelWidthClass(c.panelWidth),c.themeRevision]);
        if(c.rowKeys.get(agent.id)!==rowKey){c.rowKeys.set(agent.id,rowKey);c.notify(c.rows.get(agent.id));}
      }
      if(!c.cards.has(space.id)){c.cards.set(space.id,make(PanelSpace,space.id));structure=true;}
      const nativeSpace=c.spaceMap.get(space.id);
      const cardKey=signature([{...space,agents:undefined},panelSpacePartners(c.feed,space.id),topology.find(item=>item[0]===space.id),space.agents.filter(a=>a.status==='working'&&a.closing?.step!==4).length,
        c.events.packets.some(event=>event.kind==='memory'&&event.to===space.id&&event.phase==='ping'),c.motion,panelWidthClass(c.panelWidth),nativeSpace?.native?.active||false,c.themeRevision]);
      if(c.cardKeys.get(space.id)!==cardKey){c.cardKeys.set(space.id,cardKey);c.notify(c.cards.get(space.id));}
      c.settleIssue(space.id);
    }
    for(const [id,entity] of c.rows)if(!c.projection.agents.has(id)){entity.release();c.rows.delete(id);c.rowKeys.delete(id);}
    for(const [id,entity] of c.cards)if(!c.spaceMap.has(id)){entity.release();c.cards.delete(id);c.cardKeys.delete(id);structure=true;}
    for(const id of c.issueStates.keys())if(!c.spaceMap.has(id)){c.issueStates.delete(id);c.expandedIssueSpaces.delete(id);}
    for(const [id,inputs] of c.issueInputs)if(!c.spaceMap.has(id)){c.issueInputs.delete(id);for(const input of [inputs.search,inputs.comment])try{input?.release?.();}catch{}}
    for(const id of [...c.staleInputs]){c.staleInputs.delete(id);if(c.spaceMap.has(id))c.ensureInputs(id);}
    for(const id of c.expandedParents)if(!c.projection.agents.has(id))c.expandedParents.delete(id);
    const order=signature(c.feed.spaces.map(space=>space.id));
    if(structure||order!==c.orderKey||themeChanged){c.orderKey=order;c.notify(c.list);}
    const computersKey=signature([c.feed.computers,c.themeRevision]);
    if(computersKey!==c.computersKey||oldMotion!==c.motion){c.computersKey=computersKey;c.notify(c.computers);}
    const summaryKey=signature([status,panelCounts(c.feed),c.themeRevision]);
    if(summaryKey!==c.summaryKey){c.summaryKey=summaryKey;c.notify(c.summary);}
    const hostKey=signature([c.layoutKey,c.feed.computers,c.feed.spaces.map(space=>[space.id,space.nav,space.memory,space.share,panelSpacePartners(c.feed,space.id),panelCounts({spaces:[space]})]),c.status]);
    if(c.embedded&&hostKey!==c.hostKey){c.hostKey=hostKey;c.onHostChange?.();}
    const flowsKey=signature([c.layoutKey,c.feed.spaces.map(space=>[space.share,space.memory]),c.feed.links,c.events.packets.map(event=>[event.id,event.phase,panelLeg(event.elapsed)]),c.events.connections.map(event=>event.id),c.motion,panelWidthClass(c.panelWidth),c.themeRevision]);
    if(flowsKey!==c.flowsKey){c.flowsKey=flowsKey;c.notify(c.flows);if(c.embedded)c.onHostChange?.();}
    if(!oldFeed||oldMotion!==c.motion||themeChanged)c.notify(c.entity);
    c.wake?.cancel();c.wake=null;c.wakeAt=null;
    if(c.visible&&c.hostVisible&&c.enabled){
      let at=c.events.nextAt;const now=Date.now();
      // Countdown text changes once a minute at most; only rows with a timer wake.
      const reasonAt=panelReasonWake(c.feed,now);if(reasonAt!==null&&(at===null||reasonAt<at))at=reasonAt;
      for(const packet of c.events.packets)for(const offset of PANEL_LEGS.slice(1)){
        const boundary=packet.at+offset;if(boundary>now&&(at===null||boundary<at))at=boundary;
      }
      if(at!==null){c.wakeAt=at;c.wake=c.cx.timer.after(Math.max(1,at-now),()=>{c.wake=null;c.wakeAt=null;c.apply(c.input);});}
    }
  };
  c.preferences=()=>{
    const next=signature([shared('sixfold.motion'),c.enabled,c.visible,typeof window!=='function'||window()?.visible!==false,panelWidthClass(c.panelWidth),signature(theme())]);
    if(c.input&&next!==c.preferenceKey)c.apply(c.input);
  };
  c.navigation=()=>{if(c.input&&c.visible&&c.enabled)c.apply(c.input);};
  // True when the width crossed a layout breakpoint (the only time anything redraws).
  c.resize=width=>{
    if(!(Math.abs(width-c.panelWidth)>1))return false;
    const crossed=panelWidthClass(width)!==panelWidthClass(c.panelWidth);
    c.panelWidth=width;
    if(crossed)c.preferences();
    return crossed;
  };
  c.setVisible=visible=>{
    if(c.visible!==visible){
      c.visible=visible;
      // A hidden window consumes the latest state as a watermark. Reopening
      // shows current work without replaying a backlog of message animations.
      if(visible&&c.input)c.events=panelEventStates(c.input,Date.now(),{motion:false});
      c.preferences();
    }
  };
  c.setEnabled=enabled=>{if(c.enabled!==enabled){c.enabled=enabled;c.preferences();}};
  c.dispose=()=>{
    if(c.disposed)return;c.disposed=true;c.readTimer?.cancel?.();c.readTimer=null;c.cacheTimer?.cancel?.();c.cacheTimer=null;c.lookTimer?.cancel?.();c.lookTimer=null;c.autoTimer?.cancel?.();c.autoTimer=null;c.statusMemo?.clear();
    try{c.wake?.cancel();}catch{/* The old source generation may already be released. */}
    try{c.life?.cancel();}catch{}
    for(const entity of [...c.rows.values(),...c.cards.values(),c.computers,c.summary,c.flows,c.list,c.entity])try{entity?.release();}catch{}
    // Releasing a card releases what it owns; explicit release covers a host without that cascade.
    for(const inputs of c.issueInputs.values())for(const input of [inputs.search,inputs.comment])try{input?.release?.();}catch{}
    c.issueInputs.clear();c.staleInputs.clear();
    try{c.onDispose?.();}catch{}
    registry.delete(key);
  };
  return c;
}

export function panelDiagnostics(){return [...registry.values()].map(c=>({key:c.key,visible:c.visible,hostVisible:c.hostVisible??null,enabled:c.enabled,rows:c.rows.size,spaces:c.cards.size,wakeAt:c.wakeAt,stats:c.stats}));}
