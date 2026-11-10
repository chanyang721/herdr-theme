import {View,div,svg} from 'gpui-kit';
import {h_flex,v_flex,InputState,Input} from 'gpui-base';
import {theme,spaces,shared,setShared,settings,window} from 'herdr';
import {projectPanelFeed,panelEventStates,panelSpaces,panelSpacePartners,PANEL_TIMING,PANEL_LEGS,panelLeg,agentReason} from './panel-model.js';
import {panelLayout,cardView,agentRow,panelFlowLayer,panelCounts,PANEL_GEOMETRY,toolIcon,panelReasonWake,agentRowHeight,panelMetaHeight,rowArrival} from './panel-view.js';
import {groupColors,paletteMode} from './collab-flow.js';
import {issuePopover} from './task-issues-view.js';
import {issueScopeData,issueCacheLabel} from './task-issue-state.js';
import {nativeTaskSpace,hostedTaskLayout,panelWidthClass} from './panel-host.js';

// Each retained entity receives only a local controller key. Display data stays
// in this generation's registry, not in persisted shared state (which refreshes
// every mod). Only the entity whose data changed is invalidated.
const registry=globalThis.__sixfoldPanelControllers??=new Map();
const read=props=>registry.get(props.key);
const signature=value=>JSON.stringify(value);
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
class PanelSpace extends View{
  init(props){this.key=props.key;this.id=props.id;}
  render(){
    const c=read(this);if(!c)return div();countRenders(c,'space',this.id);
    const geometry=c.layout?.cards.find(card=>card.space.id===this.id),space=c.spaceMap.get(this.id);
    if(!geometry||!space)return div();
    const groups=c.projection.groups.get(this.id);
    const rows=geometry.rows.map(row=>row.kind==='agent'?{...row,agent:c.projection.agents.get(row.agent.id)}
      :row.kind==='issue'?{...row,group:groups.groups.find(group=>group.issue?.key===row.group.issue?.key)}:row);
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

export function createRetainedPanel(cx,{macTitlebar=false,onClassic=null,onDispose=null,onIssueRequest=null,embedded=false,onHostChange=null,schedule=fn=>fn()}={}){
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
  c.issuePopover=(space,trigger,t)=>{
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
    return issuePopover({id:space.id,trigger,open:state?.open===true,scope:state?.scope||'week',...data,
      leadingGap:PANEL_GEOMETRY.rightGutter+PANEL_GEOMETRY.padding+PANEL_GEOMETRY.border+PANEL_GEOMETRY.popoverGap,
      projectLabel:space.name,toolLabel:space.work?.tool==='jira'?'Jira':space.work?.tool==='linear'?'Linear':space.work?.tool||'업무 도구',
      icon:state?.open?toolIcon(space.work?.tool,t).size(24):null,
      updatedLabel:cache?.label,emptyLabel:cache?.emptyLabel,
      onExternal:space.work?.url?context=>context?.open_url?.(space.work.url):null,
      canImport:Boolean(onIssueRequest&&space.issue_catalog?.import_request),busyKeys:new Set(state?.pending.keys()||[]),error:state?.error,
      search:state?.input?Input.new(state.input).w_full().h(30):null,
      onOpen:(open)=>{
        let current=c.issueStates.get(space.id);
        if(!current){
          const input=InputState.new({placeholder:'이슈 검색'});
          current={open:false,scope:'week',query:'',input,pending:new Map(),error:null};
          c.issueStates.set(space.id,current);
          input.on('change',()=>{current.query=input.value();c.notify(c.cards.get(space.id));});
        }
        if(open)for(const [id,other] of c.issueStates)if(id!==space.id&&other.open){other.open=false;c.notify(c.cards.get(id));}
        current.open=open;c.notify(c.cards.get(space.id));
      },
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
    if(c.disposed)return;c.disposed=true;
    try{c.wake?.cancel();}catch{/* The old source generation may already be released. */}
    try{c.life?.cancel();}catch{}
    for(const entity of [...c.rows.values(),...c.cards.values(),c.computers,c.summary,c.flows,c.list,c.entity])try{entity?.release();}catch{}
    try{c.onDispose?.();}catch{}
    registry.delete(key);
  };
  return c;
}

export function panelDiagnostics(){return [...registry.values()].map(c=>({key:c.key,visible:c.visible,hostVisible:c.hostVisible??null,enabled:c.enabled,rows:c.rows.size,spaces:c.cards.size,wakeAt:c.wakeAt,stats:c.stats}));}
