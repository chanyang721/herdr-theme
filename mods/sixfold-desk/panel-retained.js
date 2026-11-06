import {View,div,svg} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import {theme,spaces,shared,setShared,settings,window} from 'herdr';
import {projectPanelFeed,panelEventStates,panelSpaces} from './panel-model.js';
import {panelLayout,cardView,agentRow,panelFlowLayer} from './panel-view.js';
import {groupColors,paletteMode} from './collab-flow.js';

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
    return cardView(c,{...geometry,space,groups,rows},c.events,c.color(space.bundle||space.id),c.names,theme(),c.motion,c.rows);
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
    const working=c.feed?.spaces.flatMap(space=>space.agents).filter(agent=>agent.status==='working').length||0;
    return h_flex().h(32).px(12).gap(12).items_center().child(label(`◌ ${working}`,t.accent,12))
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

export function createRetainedPanel(cx,{macTitlebar=false,onClassic=null,onDispose=null}={}){
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
  const c={key,protocol:'2',macTitlebar,onClassic,panelWidth:224,visible:true,enabled:true,feed:null,input:null,projection:null,
    rows:new Map(),cards:new Map(),rowKeys:new Map(),cardKeys:new Map(),spaceMap:new Map(),agentSpaces:new Map(),
    names:new Map(),events:null,status:'missing',wake:null,wakeAt:null,stats:{updates:0,notifications:0,renders:{},projections:[]},
    color:()=>theme().accent,motion:false,disposed:false,onDispose,
    life:typeof cx.spawn==='function'?cx.spawn(()=>new Promise(()=>{})):null};
  registry.set(key,c);
  const make=(Class,id)=>cx.new(Class,{key,...(id?{id}:{})});
  c.entity=make(PanelRoot);c.computers=make(PanelComputers);c.summary=make(PanelSummary);c.flows=make(PanelFlows);c.list=make(PanelList);
  c.notify=entity=>{if(entity&&!c.disposed){c.stats.notifications++;c.cx.notify(entity);}};
  c.apply=(input,status=c.status)=>{
    if(c.disposed||!input)return;
    c.stats.updates++;
    const oldFeed=c.feed,oldLayoutKey=c.layoutKey,oldMotion=c.motion;
    const nextTheme=signature(theme()),themeChanged=nextTheme!==c.themeKey;
    if(themeChanged){c.themeKey=nextTheme;c.themeRevision=(c.themeRevision||0)+1;}
    c.hostVisible=typeof window!=='function'||window()?.visible!==false;
    c.preferenceKey=signature([shared('sixfold.motion'),c.enabled,c.visible,c.hostVisible,c.panelWidth,nextTheme]);
    c.input=input;c.status=status;
    c.motion=c.visible&&c.hostVisible&&c.enabled&&shared('sixfold.motion')!==false&&input.reduced_motion!==true;
    c.events=panelEventStates(input,Date.now(),{previous:c.events,motion:c.motion});
    c.projection=projectPanelFeed(input,c.projection,{includeClosedIds:new Set(c.events.tags.keys())});
    c.stats.projections.push(c.projection.stats);if(c.stats.projections.length>32)c.stats.projections.shift();
    c.feed=c.projection.feed;
    const native=panelSpaces(c.feed,spaces());c.spaceMap=new Map(native.map(space=>[space.id,space]));
    c.agentSpaces=new Map(native.flatMap(space=>space.agents.map(agent=>[agent.id,space])));
    c.names=new Map(c.feed.computers.map(computer=>[computer.id,computer.name]));
    const paletteKey=signature([c.feed.spaces.map(space=>space.bundle||space.id),paletteMode(theme())]);
    if(paletteKey!==c.paletteKey){
      c.paletteKey=paletteKey;c.palette=groupColors(c.feed.spaces.map(space=>space.bundle||space.id),paletteMode(theme()));
      c.color=value=>c.palette.get((value||'').trim().toLowerCase())?.color||theme().accent;
    }
    const topology=c.feed.spaces.map(space=>{
      const group=c.projection.groups.get(space.id);
      return [space.id,group.grouped,group.grouped?group.groups.map(g=>[g.issue?.key,g.agents.map(a=>a.id),g.hidden]):[group.agents.map(a=>a.id),group.hidden]];
    });
    c.layoutKey=signature([c.feed.computers.map(computer=>computer.id),topology]);
    if(c.layoutKey!==oldLayoutKey)c.layout=panelLayout(c.feed,c.events,spaces(),c.projection.groups);
    else if(c.layout)c.layout={...c.layout,cards:c.layout.cards.map(card=>({...card,space:c.spaceMap.get(card.space.id)}))};
    let structure=false;
    for(const space of c.feed.spaces){
      for(const agent of space.agents){
        if(!c.rows.has(agent.id))c.rows.set(agent.id,make(PanelRow,agent.id));
        const tag=c.events.tags.get(agent.id),ping=c.events.packets.some(event=>event.to===agent.id&&event.phase==='ping');
        const rowKey=signature([agent,tag?.id||null,tag?.label||null,ping,c.events.spawning.has(agent.id),c.motion,c.panelWidth<420,c.themeRevision]);
        if(c.rowKeys.get(agent.id)!==rowKey){c.rowKeys.set(agent.id,rowKey);c.notify(c.rows.get(agent.id));}
      }
      if(!c.cards.has(space.id)){c.cards.set(space.id,make(PanelSpace,space.id));structure=true;}
      const nativeSpace=c.spaceMap.get(space.id);
      const cardKey=signature([{...space,agents:undefined},topology.find(item=>item[0]===space.id),space.agents.filter(a=>a.status==='working'&&a.closing?.step!==4).length,
        c.events.packets.some(event=>event.kind==='memory'&&event.to===space.id&&event.phase==='ping'),c.motion,c.panelWidth<420,nativeSpace?.native?.active||false,c.themeRevision]);
      if(c.cardKeys.get(space.id)!==cardKey){c.cardKeys.set(space.id,cardKey);c.notify(c.cards.get(space.id));}
    }
    for(const [id,entity] of c.rows)if(!c.projection.agents.has(id)){entity.release();c.rows.delete(id);c.rowKeys.delete(id);}
    for(const [id,entity] of c.cards)if(!c.spaceMap.has(id)){entity.release();c.cards.delete(id);c.cardKeys.delete(id);structure=true;}
    const order=signature(c.feed.spaces.map(space=>space.id));
    if(structure||order!==c.orderKey||themeChanged){c.orderKey=order;c.notify(c.list);}
    const computersKey=signature([c.feed.computers,c.themeRevision]);
    if(computersKey!==c.computersKey||oldMotion!==c.motion){c.computersKey=computersKey;c.notify(c.computers);}
    const summaryKey=signature([status,c.feed.spaces.flatMap(space=>space.agents).filter(a=>a.status==='working').length,c.themeRevision]);
    if(summaryKey!==c.summaryKey){c.summaryKey=summaryKey;c.notify(c.summary);}
    const flowsKey=signature([c.layoutKey,c.feed.spaces.map(space=>[space.share,space.memory]),c.feed.links,c.events.packets.map(event=>[event.id,event.phase,event.elapsed<40?0:event.elapsed<300?1:event.elapsed<1400?2:3]),c.events.connections.map(event=>event.id),c.motion,c.panelWidth,c.themeRevision]);
    if(flowsKey!==c.flowsKey){c.flowsKey=flowsKey;c.notify(c.flows);}
    if(!oldFeed||oldMotion!==c.motion||themeChanged)c.notify(c.entity);
    c.wake?.cancel();c.wake=null;c.wakeAt=null;
    if(c.visible&&c.hostVisible&&c.enabled){
      let at=c.events.nextAt;const now=Date.now();
      for(const packet of c.events.packets)for(const offset of [300,1400]){
        const boundary=packet.at+offset;if(boundary>now&&(at===null||boundary<at))at=boundary;
      }
      if(at!==null){c.wakeAt=at;c.wake=c.cx.timer.after(Math.max(1,at-now),()=>{c.wake=null;c.wakeAt=null;c.apply(c.input);});}
    }
  };
  c.preferences=()=>{
    const next=signature([shared('sixfold.motion'),c.enabled,c.visible,typeof window!=='function'||window()?.visible!==false,c.panelWidth,signature(theme())]);
    if(c.input&&next!==c.preferenceKey)c.apply(c.input);
  };
  c.resize=(width,_cx)=>{if(Math.abs(width-c.panelWidth)>1){c.panelWidth=width;c.preferences();}};
  c.setVisible=visible=>{if(c.visible!==visible){c.visible=visible;c.preferences();}};
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
