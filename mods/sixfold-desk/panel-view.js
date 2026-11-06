import {div, svg, PathBuilder} from 'gpui-kit';
import {h_flex, v_flex} from 'gpui-base';
import {spaces, panes, shared, setShared, run, settings} from 'herdr';
import {agentGroups, agentState, panelEventStates, panelSpaces} from './panel-model.js';
import {groupColors, paletteMode} from './collab-flow.js';

const MARK={working:'●',idle:'○',blocked:'!',done:'✓'};
const STAGES=['배분','작업','검수','수락 대기'];
const CLOSE=['보고 작성','경험·결정 저장','기억함 제안','닫힘'];
const ISSUE={blocked:'막힘',working:'진행 중',review:'검수',waiting:'대기',done:'완료'};
const RIGHT=40, ROW=28;
const qualified=(nav,key)=>nav?.machine?`${nav.machine}/${nav[key]}`:nav?.[key];
export function navigatePanelAgent(agent){
  if(!agent.nav||agent.closing?.step===4)return false;
  const target=qualified(agent.nav,'pane_id');
  const pane=panes().find(p=>p.pane===target);
  if(!pane)return false;
  run('pane.focus',{pane:pane.pane});return true;
}

// Heights are fixed, and all labels truncate. Routes share these exact row
// centres with the cards, including issue headings and collapsed agent lists.
export function panelLayout(feed, eventState, nativeSpaces=[],groupMap=null) {
  const anchors=new Map(), cards=[];
  let y=24;
  for(const computer of feed.computers){anchors.set(computer.id,{y:y+16,kind:'computer',computer:computer.id});y+=36;}
  y+=28;
  for(const space of panelSpaces(feed,nativeSpaces)){
    const groups=groupMap?.get(space.id)||agentGroups(space,{includeClosedIds:new Set(eventState.tags.keys())});
    const card={space,groups,top:y,rows:[],height:62};
    anchors.set(space.id,{y:y+17,kind:'space',space:space.id,computer:space.computer});
    let row=y+57;
    const groupRows=groups.grouped?groups.groups:[{issue:null,agents:groups.agents,hidden:groups.hidden}];
    for(const group of groupRows){
      if(groups.grouped){card.rows.push({kind:'issue',group,y:row});row+=22;}
      for(const agent of group.agents){
        anchors.set(agent.id,{y:row+ROW/2,kind:'agent',space:space.id,computer:space.computer});
        card.rows.push({kind:'agent',agent,y:row});row+=ROW;
      }
      if(group.hidden){card.rows.push({kind:'more',count:group.hidden,y:row});row+=22;}
    }
    if(!card.rows.length){card.rows.push({kind:'empty',y:row});row+=ROW;}
    card.height=row-y+5;cards.push(card);y+=card.height+10;
  }
  return {anchors,cards,height:y};
}

const familyIcon=agent=>['claude','codex'].includes(agent.family)
  ? svg(`mods/sixfold-desk/icons/${agent.family}.svg`).size(13).flex_none()
  : div().size(12).flex_none().rounded(3).border(1);
function toolIcon(tool,t){
  if(tool==='linear')return svg('mods/sixfold-desk/icons/tool-linear.svg').size(11).flex_none().text_color(t.muted);
  if(tool==='jira')return svg('mods/sixfold-desk/icons/tool-jira.svg').size(11).flex_none().text_color(t.ansi4||t.accent);
  return div().size(10).flex_none().rounded(2).border(1).border_color(t.dim).tooltip(tool||'업무 도구');
}
function spaceIcon(color){
  return v_flex().size(13).gap(2).flex_none().children([0,1].map(()=>h_flex().gap(2)
    .children([0,1].map(()=>div().size(5).rounded(1).bg(color)))));
}
const square=(color,filled=false,size=6)=>div().size(size).flex_none().rounded(1).border(1).border_color(color)
  .when(filled,e=>e.bg(color));
const text=(value,color,size=10)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);

function stageBar(agent,tag,color,t,motion,compact){
  const closing=agent.closing;
  const blocked=agent.status==='blocked'||Boolean(closing?.blocked_reason);
  const tone=blocked?t.blocked:closing?(t.ansi6||t.accent):color;
  const active=closing?closing.step-1:Math.max(-1,Math.min(4,agent.stage-1));
  const tip=closing?closing.blocked_reason||CLOSE[active]:agent.stage===5?'완료':STAGES[active]||'대기·계획';
  const slot=h_flex().w(compact?64:82).h(18).flex_none().gap(3).items_center().tooltip(tag?.label||tip);
  if(tag)return slot.child(text(tag.label,tone,9).flex_1());
  return slot.children(STAGES.map((_,index)=>div().id(`panel-stage-${agent.id}-${index}`).h(4).flex_1().rounded(2)
    .bg(index<=active?tone:t.border).when(index===active&&agent.status!=='done'&&!blocked&&motion,e=>e.loop('opacity',{from:0.4,to:1,period:2200,easing:'ease-in-out'}))));
}
export function agentRow(view,agent,space,tag,state,color,t,motion){
  const compact=(view.panelWidth||224)<420;
  const closingBlocked=Boolean(agent.closing?.blocked_reason);
  const status=closingBlocked?'blocked':agent.status;
  const pulse=state.packets.some(event=>event.to===agent.id&&event.phase==='ping');
  const born=state.spawning.has(agent.id);
  return h_flex().id(`panel-agent-${agent.id}`).h(ROW).flex_none().px(7).gap(5).items_center().rounded(3)
    .opacity(agentState(agent)==='done'?0.52:1)
    .when(born,e=>e.border(1).border_dashed().border_color(color))
    .when(pulse,e=>e.border(1).border_color(color))
    .tooltip([agent.title,agent.tooltip_addr,agent.closing?.blocked_reason].filter(Boolean).join('\n'))
    .when(Boolean(agent.nav)&&agent.closing?.step!==4,e=>e.cursor_pointer().hover(h=>h.bg(t.hover))
      .on_click((_event,cx)=>{cx.stop_propagation();navigatePanelAgent(agent);}))
    .child(familyIcon(agent).text_color(t.foreground))
    .child(text(agent.title||'이름 없는 작업',t.foreground,11).flex_1())
    .child(stageBar(agent,tag,color,t,motion,compact))
    .child(div().w(9).flex_none().text_size(10).text_color(status==='blocked'?t.blocked:status==='working'?color:t.dim).child(MARK[status]||'○'));
}

export function cardView(view,card,state,color,computerNames,t,motion,rowEntities=null){
  const {space,groups}=card;
  const compact=(view.panelWidth||224)<420;
  const memoryWidth=compact?(space.memory.proposals>9?32:22):64;
  const sharing=Boolean(space.share), count=space.agents.filter(a=>a.status==='working'&&a.closing?.step!==4).length;
  const selected=space.native?.active;
  const memory=state.packets.some(event=>event.kind==='memory'&&event.to===space.id&&event.phase==='ping');
  const box=v_flex().id(`panel-space-${space.id}`).relative().ml(8).mr(RIGHT).mb(10).flex_none().rounded(6)
    .border(1).border_color(sharing?color:t.border).bg(t.chrome);
  if(sharing&&motion)box.child(div().id(`panel-breath-${space.id}`).absolute().top(0).left(0).right(0).bottom(0).rounded(6).border(1).border_color(color)
    .loop('opacity',{from:0.35,to:1,period:2800,easing:'ease-in-out'}));
  box.child(h_flex().h(32).flex_none().px(7).gap(4).items_center().rounded(5).bg(selected?t.selected:t.surface)
    .border_l(3).border_color(color).when(Boolean(space.native),e=>e.cursor_pointer().on_click(()=>run('space.select',{id:space.native.id})))
    .child(spaceIcon(color)).child(text(space.name,t.foreground,compact?11:12).font_bold().flex_1().min_w(28).tooltip(space.name))
    .when(sharing,e=>e.child(h_flex().gap(3).items_center().max_w(compact?44:95).min_w(0).tooltip(computerNames.get(space.share.computer)||'공유 컴퓨터')
      .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(12).flex_none().text_color(color))
      .child(text(computerNames.get(space.share.computer)||'공유 컴퓨터',color,10))))
    .when(space.memory.proposals>0,e=>e.child(div().id(`panel-memory-${space.id}`).w(memoryWidth).flex_none().px(compact?1:4).h(16).truncate().rounded(3).bg(memory?color:t.selected)
      .text_color(memory?t.background:t.ansi6||t.accent).text_size(compact&&space.memory.proposals>9?8:9).tooltip(`기억 제안 ${space.memory.proposals}`).child(compact?`◈ ${space.memory.proposals}`:`기억 제안 ${space.memory.proposals}`)))
    .child(text(`◌ ${count}`,t.muted,compact?8:10).w(compact?24:32).flex_none()));
  box.child(h_flex().h(24).flex_none().px(7).gap(5).items_center()
    .when(Boolean(space.slack),e=>e.child(svg('mods/sixfold-desk/icons/slack.svg').size(11).flex_none()))
    .child(text(space.slack?.channel||'Slack 연결 없음',space.slack?t.muted:t.dim,9).flex_1())
    .when(Boolean(space.work),e=>e.child(toolIcon(space.work.tool,t)))
    .child(text(space.work?`${space.work.key} · 이슈 ${space.work.open}`:'업무 도구 연결 없음',space.work?t.muted:t.dim,9)));
  for(const row of card.rows){
    if(row.kind==='issue')box.child(h_flex().h(22).flex_none().px(7).gap(4).items_center().bg(t.surface)
      .child(toolIcon(space.work.tool,t)).child(text(row.group.issue?.key||'이슈 없음',color,9).flex_none())
      .child(text(row.group.issue?.title||'',t.muted,9).flex_1())
      .child(text(row.group.issue?ISSUE[row.group.issue.state]||'대기':'',row.group.issue?.state==='blocked'?t.blocked:t.dim,8)));
    else if(row.kind==='agent')box.child(rowEntities?.get(row.agent.id)||agentRow(view,row.agent,space,state.tags.get(row.agent.id),state,color,t,motion));
    else if(row.kind==='more')box.child(h_flex().h(22).flex_none().px(8).items_center().child(text(`+${row.count}개`,t.dim,10)));
    else box.child(h_flex().h(ROW).px(8).items_center().child(text('진행 중인 작업 없음',t.dim,10)));
  }
  return box.child(div().h(4).flex_none());
}

function routePath(from,to,lane,endX,origin=0,startX=0){
  const r=Math.min(6,Math.abs(to-from)/2),sign=to>=from?1:-1;
  const path=PathBuilder.stroke(1).move_to(origin+startX,from);
  if(!r)return path.line_to(origin+endX,from).build();
  return path.line_to(origin+lane-r,from)
    .cubic_bezier_to(origin+lane,from+sign*r,origin+lane,from,origin+lane,from)
    .line_to(origin+lane,to-sign*r)
    .cubic_bezier_to(origin+lane-r,to,origin+lane,to,origin+lane,to)
    .line_to(origin+endX,to).build();
}
export function route(id,a,b,color,{dashed=false,packet=null,motion=false,relation=false}={}){
  const remote=a.computer&&b.computer&&a.computer!==b.computer;
  const top=Math.min(a.y,b.y),height=Math.max(2,Math.abs(b.y-a.y)),lane=relation?10:(dashed||remote?24:10);
  const base=div().id(`panel-route-${id}`).absolute().right(9).top(top).w(32).h(height+3);
  if(dashed){
    // Dashes remain visible for the lifetime of a connection. The dim dot
    // travels slowly in one direction; it is not a message packet.
    const radius=Math.min(6,height/2);
    for(let y=radius;y<height-radius;y+=8)base.child(div().absolute().left(lane).top(y).w(1).h(Math.min(3,height-radius-y)).bg(color));
    for(const y of [0,height])base.child(div().absolute().left(0).top(y).w(lane-radius).h(1).border_t(1).border_dashed().border_color(color));
    const elbows=PathBuilder.stroke(1).move_to(lane-radius,0)
      .cubic_bezier_to(lane,radius,lane,0,lane,0)
      .move_to(lane,height-radius).cubic_bezier_to(lane-radius,height,lane,height,lane,height).build();
    base.child(window.paint_path(elbows,color).absolute().left(0).top(0).w(32).h(height+3));
    if(motion&&!relation)base.child(div().id(`panel-link-dot-${id}`).absolute().left(lane-1).size(3).rounded(2).bg(color)
      .loop('top',{from:0,to:height,period:16000,easing:'linear'}));
  }else{
    const origin=Math.max(0,-(a.x||0),-(b.x||0));
    const path=routePath(a.y-top,b.y-top,lane,b.x||0,origin,a.x||0);
    base.child(window.paint_path(path,color).absolute().left(-origin).top(0).w(32+origin).h(height+3));
    if(packet&&motion&&['start','travel'].includes(packet.phase)){
      const elapsed=packet.elapsed;
      const point=elapsed<40?{x:a.x||0,y:a.y-top,ms:1}
        :elapsed<300?{x:lane,y:a.y-top,ms:260}
        :elapsed<1400?{x:lane,y:b.y-top,ms:1100}
        :{x:b.x||0,y:b.y-top,ms:240};
      // An actual four-pixel square, not another one-pixel copy of the pipe:
      // repeating the same stroke made the earlier moving mask invisible.
      base.child(div().id(`panel-packet-${id}`).absolute().left(point.x-2).top(point.y-2).size(4).rounded(1).bg(color)
        .transition('left',{duration:point.ms,easing:'linear'})
        .transition('top',{duration:point.ms,easing:'linear'}));
    }
    if(packet?.phase==='fade')base.opacity(0.2).when(motion,e=>e.transition('opacity',900));
  }
  return base;
}

export function panelFlowLayer(feed,layout,state,color,t,motion,width){
  const layer=div().absolute().left(0).top(0).w_full().h(layout.height);
  for(const card of layout.cards){
    const s=card.space;if(!s.share)continue;
    const from=layout.anchors.get(s.share.kind==='agent'?s.share.agent_id:s.id),to=layout.anchors.get(s.share.computer);
    if(!from||!to)continue;
    layer.child(route(`share-${s.id}`,from,to,color(s.bundle||s.id),{dashed:true,motion}));
    layer.child(div().absolute().right(RIGHT-3).top(from.y-3).when(s.share.kind==='agent',e=>e.size(6).rounded(3).bg(color(s.bundle||s.id)))
      .when(s.share.kind==='space',e=>e.child(square(color(s.bundle||s.id),false))));
  }
  for(const link of feed.links){
    const a=layout.anchors.get(link.a),b=layout.anchors.get(link.b);if(a&&b)layer.child(route(`task-${link.a}-${link.b}`,a,b,t.dim,{dashed:true,relation:true}));
  }
  for(const packet of state.packets){
    const a=layout.anchors.get(packet.from);let b=layout.anchors.get(packet.to);
    if(b&&packet.kind==='memory'){
      const proposals=feed.spaces.find(space=>space.id===packet.to)?.memory.proposals||0;
      b={...b,x:width<420?(proposals>9?-52:-47):-76};
    }
    if(a&&b)layer.child(route(packet.id,a,b,color(feed.spaces.find(s=>s.id===a.space)?.bundle),{packet,motion}));
  }
  if(!motion)for(const event of state.connections){
    const a=layout.anchors.get(event.from),b=layout.anchors.get(event.to);if(a&&b)layer.child(route(event.id,a,b,t.dim));
  }
  return layer;
}

export function renderPanelTracking(view,t,cx,{macTitlebar=false}={}){
  const feed=view.panelState.feed;
  const motion=shared('sixfold.motion')!==false&&feed.reduced_motion!==true&&view.panelReducedMotion!==true;
  const now=Date.now();
  const state=panelEventStates(feed,now,{previous:view.panelEvents,motion});view.panelEvents=state;
  let nextAt=state.nextAt;
  for(const packet of state.packets)for(const offset of [300,1400]){
    const at=packet.at+offset;if(at>now&&(nextAt===null||at<nextAt))nextAt=at;
  }
  if(view.panelWakeAt!==nextAt){
    view.panelWakeTimer?.cancel();view.panelWakeAt=nextAt;
    if(nextAt!==null)view.panelWakeTimer=cx.timer.after(Math.max(1,nextAt-now),cx=>{view.panelWakeAt=null;cx.notify();});
  }
  const layout=panelLayout(feed,state,spaces());
  const colors=groupColors(feed.spaces.map(s=>s.bundle||s.id),paletteMode(t));
  const color=key=>colors.get((key||'').trim().toLowerCase())?.color||t.accent;
  const names=new Map(feed.computers.map(c=>[c.id,c.name]));
  const rows=v_flex().relative().flex_none();
  rows.child(h_flex().h(24).px(10).items_center().child(text('COMPUTERS',t.dim,10).font_bold()));
  for(const computer of feed.computers)rows.child(h_flex().id(`panel-computer-${computer.id}`).h(32).mb(4).ml(8).mr(RIGHT).px(7).gap(6).items_center().rounded(5).bg(t.surface)
    .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(15).flex_none().text_color(color(computer.bundle)))
    .child(text(computer.name,t.foreground,11).flex_1())
    .when(computer.traffic.up!==null||computer.traffic.down!==null,e=>e.child(text(`↑${computer.traffic.up??'—'} ↓${computer.traffic.down??'—'}`,t.dim,9)))
    .child(square(computer.linked?color(computer.bundle):t.dim,computer.linked,5)));
  rows.child(h_flex().h(28).px(10).items_center().child(text('SPACES',t.dim,10).font_bold()));
  for(const card of layout.cards)rows.child(cardView(view,card,state,color(card.space.bundle||card.space.id),names,t,motion));
  for(const card of layout.cards){
    const s=card.space;if(!s.share)continue;
    const from=layout.anchors.get(s.share.kind==='agent'?s.share.agent_id:s.id),to=layout.anchors.get(s.share.computer);
    if(!from||!to)continue;
    rows.child(route(`share-${s.id}`,from,to,color(s.bundle||s.id),{dashed:true,motion}));
    rows.child(div().absolute().right(RIGHT-3).top(from.y-3).when(s.share.kind==='agent',e=>e.size(6).rounded(3).bg(color(s.bundle||s.id)))
      .when(s.share.kind==='space',e=>e.child(square(color(s.bundle||s.id),false))));
  }
  for(const link of feed.links){
    const a=layout.anchors.get(link.a),b=layout.anchors.get(link.b);if(a&&b)rows.child(route(`task-${link.a}-${link.b}`,a,b,t.dim,{dashed:true,relation:true}));
  }
  for(const packet of state.packets){
    const a=layout.anchors.get(packet.from);let b=layout.anchors.get(packet.to);
    if(b&&packet.kind==='memory'){
      const proposals=feed.spaces.find(space=>space.id===packet.to)?.memory.proposals||0;
      b={...b,x:(view.panelWidth||224)<420?(proposals>9?-52:-47):-76};
    }
    if(a&&b)rows.child(route(packet.id,a,b,color(feed.spaces.find(s=>s.id===a.space)?.bundle),{packet,motion}));
  }
  if(!motion)for(const event of state.connections){
    const a=layout.anchors.get(event.from),b=layout.anchors.get(event.to);
    if(a&&b)rows.child(route(event.id,a,b,t.dim));
  }
  const working=feed.spaces.flatMap(s=>s.agents).filter(a=>a.status==='working').length;
  return v_flex().id('sixfold-sidebar').size_full().bg(t.chrome).text_color(t.foreground)
    .on_size_change((size,cx)=>{const width=size.width/(settings().zoom||1);if(Math.abs((view.panelWidth||224)-width)>1){view.panelWidth=width;cx.notify();}})
    .child(h_flex().h(48).flex_none().pl(macTitlebar?76:20).pr(10).gap(8).items_center()
      .child(text('Herdr Theme',t.foreground,14).font_bold().flex_1())
      .child(div().id('panel-workspaces').text_size(10).text_color(t.muted).cursor_pointer().tooltip('워크스페이스 목록')
        .on_click(()=>setShared('sixfold.panel.enabled',false)).child('목록'))
      .child(div().id('panel-motion').text_size(10).text_color(t.dim).cursor_pointer()
        .tooltip(view.panelReducedMotion===true?'시스템 동작 줄이기 적용 중':'움직임 켜기/끄기')
        .on_click(()=>setShared('sixfold.motion',shared('sixfold.motion')===false)).child(motion?'Motion on':'Motion off')))
    .child(h_flex().h(32).px(12).gap(12).items_center().child(text(`◌ ${working}`,t.accent,12))
      .when(view.panelState.status!=='ready',e=>e.child(text(view.panelState.status==='stale'?'업데이트 대기':'최근 표시 유지',t.blocked,10))))
    .child(div().id('panel-scroll').flex_1().min_h(0).overflow_y_scroll().child(rows));
}
