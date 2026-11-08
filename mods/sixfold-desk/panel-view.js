import {div, svg, image, PathBuilder} from 'gpui-kit';
import {h_flex, v_flex} from 'gpui-base';
import {spaces, panes, shared, setShared, run, settings} from 'herdr';
import {agentGroups, agentState, panelEventStates, panelSpaces, panelSpacePartners} from './panel-model.js';
import {groupColors, paletteMode} from './collab-flow.js';
import {rowDetailParts} from './task-row-details.js';
import {PANEL_FLOW, panelFlowAnchor, panelMessageAnchors} from './panel-host.js';

const MARK={working:'●',idle:'○',blocked:'!',done:'✓'};
const STAGES=['배분','작업','검수','수락 대기'];
const CLOSE=['보고 작성','경험·결정 저장','기억함 제안','닫힘'];
const ISSUE={blocked:'막힘',working:'진행 중',review:'검수',waiting:'대기',done:'완료'};
const RIGHT=PANEL_FLOW.gutter, ROW=28;
export const PANEL_GEOMETRY=Object.freeze({header:34,meta:26,issue:18,row:ROW,child:20,border:1,bottom:4,gap:4,padding:7,rightGutter:RIGHT,popoverGap:10});
export function panelCounts(feed){
  const counts={working:0,idle:0,blocked:0,done:0,total:0};
  for(const agent of (feed?.spaces||[]).flatMap(space=>space.agents)){
    if(agent.closing?.step===4)continue;
    counts.total++;
    const state=agentState(agent);
    counts[state==='blocked'?'blocked':state==='done'?'done':agent.status==='working'?'working':'idle']++;
  }
  return counts;
}
export function panelHeaderMetrics(space,width=224){
  const compact=width<420,proposals=space.memory?.proposals||0;
  const count=panelCounts({spaces:[space]}).working;
  const memoryWidth=proposals>0?(compact?(proposals>9?32:22):64):0;
  const countWidth=count>0?(compact?24:32):0;
  // The flow coordinate origin is the card's right edge. Derive the memory
  // badge centre from the same fixed widths and spacing used by its header.
  const memoryAnchorX=-(PANEL_GEOMETRY.padding+PANEL_GEOMETRY.border+countWidth+(countWidth?PANEL_GEOMETRY.gap:0)+memoryWidth/2);
  return {...PANEL_GEOMETRY,compact,memoryWidth,countWidth,count,memoryAnchorX};
}
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
    const card={space,groups,top:y,rows:[],height:PANEL_GEOMETRY.header+PANEL_GEOMETRY.meta+2};
    anchors.set(space.id,{y:y+PANEL_GEOMETRY.border+PANEL_GEOMETRY.header/2,kind:'space',space:space.id,computer:space.computer});
    let row=y+PANEL_GEOMETRY.border+PANEL_GEOMETRY.header+PANEL_GEOMETRY.meta;
    const groupRows=groups.grouped?groups.groups:[{issue:null,agents:groups.agents,folds:groups.folds}];
    for(const group of groupRows){
      if(groups.grouped){card.rows.push({kind:'issue',group,y:row});row+=PANEL_GEOMETRY.issue;}
      for(const agent of group.agents){
        const height=groups.rowMeta?.get(agent.id)?.parent?PANEL_GEOMETRY.child:ROW;
        anchors.set(agent.id,{y:row+height/2,kind:'agent',space:space.id,computer:space.computer});
        card.rows.push({kind:'agent',agent,y:row,height});row+=height;
        for(const fold of group.folds||[])if(fold.after===agent.id){card.rows.push({kind:'children-more',fold,y:row});row+=22;}
      }
      if(groups.groupsExpandable&&group.issue&&group===groups.groups.filter(item=>item.issue).at(-1)){
        card.rows.push({kind:'issues-more',count:groups.issueHidden,expanded:groups.issuesExpanded,y:row});row+=22;
      }
    }
    if(!card.rows.length){card.rows.push({kind:'empty',y:row});row+=ROW;}
    card.height=row-y+5;cards.push(card);y+=card.height+10;
  }
  return {anchors,cards,height:y};
}

const familyIcon=agent=>['claude','codex'].includes(agent.family)
  ? svg(`mods/sixfold-desk/icons/${agent.family}.svg`).size(13).flex_none()
  : div().size(12).flex_none().rounded(3).border(1);
export function toolIcon(tool,t){
  if(tool==='linear')return image('mods/sixfold-desk/icons/tool-linear.svg').size(11).flex_none();
  if(tool==='jira')return image('mods/sixfold-desk/icons/tool-jira.svg').size(11).flex_none();
  return div().size(10).flex_none().rounded(2).border(1).border_color(t.dim).tooltip(tool||'업무 도구');
}
function spaceIcon(color){
  return svg('mods/sixfold-desk/icons/space-grid.svg').size(12).flex_none().text_color(color);
}
const square=(color,filled=false,size=6)=>div().size(size).flex_none().rounded(1).border(1).border_color(color)
  .when(filled,e=>e.bg(color));
const text=(value,color,size=10)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);

function stageBar(agent,tag,color,t,motion,width){
  const closing=agent.closing;
  const blocked=agent.status==='blocked'||Boolean(closing?.blocked_reason);
  const tone=blocked?t.blocked:closing?(t.ansi6||t.accent):color;
  const active=closing?closing.step-1:Math.max(-1,Math.min(4,agent.stage-1));
  const tip=closing?closing.blocked_reason||CLOSE[active]:agent.stage===5?'완료':STAGES[active]||'대기·계획';
  const slot=h_flex().w(width<300?64:120).h(18).flex_none().gap(2).items_center().justify_end().tooltip(tag?.label||tip);
  if(tag)return slot.child(text(tag.label,tone,9).flex_1());
  return slot.children(STAGES.map((_,index)=>div().id(`panel-stage-${agent.id}-${index}`).w(9).h(3).flex_none()
    .bg(index<=active?tone:t.border)));
}
export function agentRow(view,agent,space,tag,state,color,t,motion){
  const compact=(view.panelWidth||224)<420;
  const meta=view.rowMeta?.get(agent.id),child=Boolean(meta?.parent);
  const depth=child?Math.max(1,Math.min(6,meta.depth||1)):0;
  const detail=rowDetailParts({errorLabel:agent.report_missing?'보고 없음':agent.error,
    unread:agent.unread,quota:agent.usage,
    remoteName:agent.nav?.machine||space.nav?.machine?view.names?.get(space.computer)||'원격 컴퓨터':null},t,{compact,motion});
  const closingBlocked=Boolean(agent.closing?.blocked_reason);
  const status=closingBlocked?'blocked':agentState(agent)==='done'?'done':agent.status;
  const pulse=state.packets.some(event=>event.to===agent.id&&event.phase==='ping');
  const born=state.spawning.has(agent.id);
  const stacked=view.embedded&&(view.panelWidth||224)<260&&!child;
  const line=h_flex().w_full().min_w(0).gap(5).items_center();
  const row=h_flex().id(`panel-agent-${agent.id}`).relative().h(child?PANEL_GEOMETRY.child:ROW).flex_none().pl(child?30+(depth-1)*16:7).pr(7).gap(5).items_center().rounded(3)
    .opacity(agentState(agent)==='done'?0.52:1)
    .when(born,e=>e.border(1).border_dashed().border_color(color))
    .when(pulse,e=>e.border(1).border_color(color))
    .tooltip([agent.title,agent.tooltip_addr,agent.closing?.blocked_reason,detail.tooltip].filter(Boolean).join('\n'))
    .when(Boolean(agent.nav)&&agent.closing?.step!==4,e=>e.cursor_pointer().hover(h=>h.bg(t.hover))
      .on_click((_event,cx)=>{cx.stop_propagation();navigatePanelAgent(agent);}));
  line
    .child(div().relative().size(13).flex_none().child(familyIcon(agent).text_color(t.foreground)).when(Boolean(detail.remoteBadge),e=>e.child(detail.remoteBadge)))
    .child(text(agent.title||'Untitled task',t.foreground,11).flex_1())
    .when(Boolean(detail.unreadBadge),e=>e.child(detail.unreadBadge));
  if(child)row.child(div().id(`panel-child-branch-${agent.id}`).absolute().left(18+(depth-1)*16).top(0).w(8).h(PANEL_GEOMETRY.child/2)
    .border_l(1).border_b(1).border_color(t.border));
  if(child)line.child(div().id(`panel-child-dot-${agent.id}`).size(5).flex_none().rounded(3)
    .bg(detail.statusColor|| (status==='blocked'?t.blocked:status==='working'?color:t.dim)));
  const showStage=!child&&(agent.closing||tag||agent.stage!==5&&status!=='done');
  if(showStage&&!stacked)line.child(stageBar(agent,tag,color,t,motion,view.panelWidth||224));
  const remembered=agent.closing?.memory;
  if(!child||detail.statusMark)line.child(div().id(`panel-status-${agent.id}`).w(9).flex_none().text_size(10)
    .text_color(detail.statusColor|| (status==='blocked'?t.blocked:status==='working'?color:t.dim))
    .tooltip(remembered?`${remembered.state==='pending'?'기억 저장 대기':remembered.state==='saved'?'기억함에 저장됨':'기억 제안'}${remembered.proposals?` ${remembered.proposals}`:''}`:status)
    .child(detail.statusMark||(remembered?(remembered.state==='pending'?'◌':'◈'):MARK[status])||'?'));
  if(stacked)row.child(v_flex().id(`panel-stacked-${agent.id}`).w_full().min_w(0).child(line)
    .when(Boolean(showStage),e=>e.child(stageBar(agent,tag,color,t,motion,224).h(tag?10:7).ml(18).w(52).justify_start())));
  else row.child(line);
  if(born&&motion){
    const age=state.active?.find(event=>(event.kind==='spawn'||event.allocation?.kind==='new')&&event.to===agent.id)?.elapsed||0;
    // Native opacity interpolation, with only the existing finite packet
    // boundaries triggering another render. No JavaScript frame loop.
    row.opacity(age<40?0.25:1).transition('opacity',{duration:260,easing:'ease-out'});
  }
  return row;
}

export function cardView(view,card,state,color,computerNames,t,motion,rowEntities=null,{bodyOnly=false}={}){
  const {space,groups}=card;
  const metrics=panelHeaderMetrics(space,view.panelWidth||224);
  const {compact,memoryWidth,countWidth,count}=metrics;
  const sharing=Boolean(space.share);
  const partners=panelSpacePartners(view.feed||view.panelState?.feed,space.id);
  const localPartner=partners[0],partnerLabel=localPartner?localPartner.name+(partners.length>1?` +${partners.length-1}`:''):'';
  const selected=space.native?.active;
  const memory=state.packets.some(event=>event.kind==='memory'&&event.to===space.id&&event.phase==='ping');
  const box=v_flex().id(`panel-space-${space.id}`).relative().flex_none().min_w(0);
  if(!bodyOnly)box.ml(8).mr(RIGHT).mb(10).rounded(6).border(1).border_color(sharing?color:t.border).bg(t.chrome);
  if(!bodyOnly&&sharing&&motion)box.child(div().id(`panel-breath-${space.id}`).absolute().top(0).left(0).right(0).bottom(0).rounded(6).border(1).border_color(color)
    .loop('opacity',{from:0.35,to:1,period:2800,easing:'ease-in-out'}));
  if(!bodyOnly)box.child(h_flex().h(PANEL_GEOMETRY.header).flex_none().px(7).gap(4).items_center().rounded(5).bg(selected?t.selected:t.surface)
    .border_l(3).border_color(color).when(Boolean(space.native),e=>e.cursor_pointer().on_click(()=>run('space.select',{id:space.native.id})))
    .child(spaceIcon(t.muted)).child(text(space.name,t.foreground,compact?11:12).font_bold().flex_1().min_w(0).tooltip(space.name))
    .when(sharing,e=>e.child(h_flex().id(`panel-partner-${space.id}`).h(18).rounded(9).border(1).border_color(color+'66').bg(color+'26').px(compact?4:7).gap(3).items_center().max_w((view.panelWidth||224)<300?48:95).min_w(0).tooltip(computerNames.get(space.share.computer)||'공유 컴퓨터')
      .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(12).flex_none().text_color(color))
      .child(text(computerNames.get(space.share.computer)||'공유 컴퓨터',color,10))))
    .when(Boolean(localPartner),e=>e.child(h_flex().id(`panel-local-partner-${space.id}`).h(18).rounded(9)
      .border(1).border_color('#c3a6ff5c').bg('#c3a6ff1f').px(compact?4:7).gap(3).items_center()
      .max_w((view.panelWidth||224)<300?(sharing?32:48):95).min_w(0).tooltip(partners.map(partner=>partner.name).join(', '))
      .child(text('↔','#c3a6ff',10).flex_none()).child(text(partnerLabel,'#c3a6ff',10))))
    .when(space.memory.proposals>0,e=>e.child(div().id(`panel-memory-${space.id}`).w(memoryWidth).flex_none().px(compact?1:4).h(16).truncate().rounded(3).bg(memory?color:t.selected)
      .text_color(memory?t.background:t.ansi6||t.accent).text_size(compact&&space.memory.proposals>9?8:9).tooltip(`기억 제안 ${space.memory.proposals}`).child(compact?`◈ ${space.memory.proposals}`:`기억 제안 ${space.memory.proposals}`)))
    .when(count>0,e=>e.child(text(`◌ ${count}`,t.muted,compact?8:10).w(countWidth).flex_none())));
  const tool=h_flex().gap(5).items_center().min_w(0)
    .when(Boolean(space.work),e=>e.child(toolIcon(space.work.tool,t)))
    .child(text(space.work?`${space.work.key} · 이슈 ${space.work.open}`:'업무 도구 연결 없음',space.work?t.muted:t.dim,9))
    .when(Boolean(space.work),e=>e.cursor_pointer().tooltip('이번 주 · 마일스톤 · 전체 이슈'));
  box.child(h_flex().h(PANEL_GEOMETRY.meta).flex_none().px(7).gap(5).items_center()
    .when(Boolean(space.slack),e=>e.child(image('mods/sixfold-desk/icons/slack.svg').size(11).flex_none()))
    .child(text(space.slack?.channel||'Slack 연결 없음',space.slack?t.muted:t.dim,9).flex_1())
    .child(space.work&&view.issuePopover?view.issuePopover(space,tool,t):tool));
  for(const row of card.rows){
    if(row.kind==='issue')box.child(h_flex().h(PANEL_GEOMETRY.issue).flex_none().px(7).gap(4).items_center().bg(t.surface).opacity(row.group.issue?.state==='done'?0.5:1)
      .child(toolIcon(space.work.tool,t)).child(text(row.group.issue?.key||'이슈 없음',color,9).flex_none())
      .child(text(row.group.issue?.title||'',t.muted,9).flex_1())
      .when(row.group.issue&&(row.group.issue.pinned===true&&!row.group.issue.week||typeof row.group.issue.pinned!=='boolean'&&space.issue_catalog&&!space.issue_catalog.week.some(issue=>issue.key===row.group.issue.key)),e=>e.child(text('가져옴',t.ansi6||t.accent,8)))
      .child(text(row.group.issue?ISSUE[row.group.issue.state]||'대기':'',row.group.issue?.state==='blocked'?t.blocked:t.dim,8)));
    else if(row.kind==='agent')box.child(rowEntities?.get(row.agent.id)||agentRow(view,row.agent,space,state.tags.get(row.agent.id),state,color,t,motion));
    else if(row.kind==='children-more'||row.kind==='issues-more')box.child(h_flex().id(`panel-fold-${space.id}-${row.fold?.parent||'issues'}`).h(22).flex_none()
      .pl(row.fold?30+Math.min(6,view.rowMeta?.get(row.fold.parent)?.depth||0)*16:8).pr(8).items_center().cursor_pointer()
      .on_click((_event,cx)=>{cx.stop_propagation();row.fold?view.toggleChildren?.(row.fold.parent):view.toggleIssues?.(space.id);})
      .child(text((row.fold?.expanded||row.expanded)?'접기':`+${row.fold?.hidden??row.count}개`,t.dim,10)));
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
  const top=Math.min(a.y,b.y),height=Math.max(2,Math.abs(b.y-a.y));
  const lane=relation?6:dashed?PANEL_FLOW.computer:packet?(packet.routeLane?PANEL_FLOW.messageNext:PANEL_FLOW.message):PANEL_FLOW.collaboration;
  const startX=a.x??(packet?PANEL_FLOW.endpoint:0),endX=b.x??(packet?PANEL_FLOW.endpoint:0);
  const base=div().id(`panel-route-${id}`).absolute().right(PANEL_FLOW.right).top(top).w(PANEL_FLOW.width).h(height+3);
  if(packet?.kind==='message'){
    const start=a.y-top,end=b.y-top;
    const sourceX=a.kind==='computer'?PANEL_FLOW.computer:startX;
    const targetX=b.kind==='computer'?PANEL_FLOW.computer:endX;
    const reach=Math.min(PANEL_FLOW.width-4-(packet.routeLane?0:4),Math.max(40,height*0.22+40));
    const ease=t=>t<0.5?4*t*t*t:1-(-2*t+2)**3/2;
    // Keep the native horizontal easing policy constant through the turn.
    // Changing easing while a transition is live resamples its old leg with
    // the new policy and causes a visible jump. The spline follows exactly
    // the same two horizontal halves and one full vertical interpolation.
    const points=Array.from({length:25},(_,i)=>{const t=i/24;return {
      x:t<=0.5?sourceX+(reach-sourceX)*ease(t*2):reach+(targetX-reach)*ease(t*2-1),
      y:start+(end-start)*ease(t),
    };});
    const path=stroke=>{
      const p=PathBuilder.stroke(stroke).move_to(sourceX,start);
      for(let i=0;i<points.length-1;i++){
        const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
        p.cubic_bezier_to(c.x,c.y,b.x+(c.x-a.x)/6,b.y+(c.y-a.y)/6,c.x-(d.x-b.x)/6,c.y-(d.y-b.y)/6);
      }
      return p.build();
    };
    const shape=(stroke,tint)=>window.paint_path(path(stroke),tint).absolute().left(0).top(0).w(PANEL_FLOW.width+8).h(height+8);
    base.child(shape(9,color+'22')).child(shape(5,color+'BB')).child(shape(3,color+'44'));
    if(motion&&['start','travel','ping'].includes(packet.phase)){
      const initial=packet.phase==='start',turn=packet.elapsed>=495;
      const x=initial?sourceX:turn?targetX+0.001:reach,y=initial?start:end;
      for(const [index,size,opacity,delay] of [[3,3,0.2,90],[2,4,0.4,60],[1,6,0.7,30],[0,9,1,0]]){
        const part=div().id(index?`panel-packet-tail-${id}-${index}`:`panel-packet-${id}`).absolute()
          .left(x-size/2).top(y-size/2).size(size).rounded(size/2).bg(color).opacity(packet.phase==='ping'?0:opacity);
        part.transition('left',{duration:initial?1:375,delay,easing:'ease-in-out'})
          .transition('top',{duration:initial?1:750,delay,easing:'ease-in-out'})
          .transition('opacity',{duration:120,easing:'ease-out'});
        if(!index)part.child(div().absolute().left(3).top(3).size(3).rounded(2).bg('#FFFFFF'));
        base.child(part);
      }
    }
    if(motion)for(const [suffix,x,y,expanded] of [['sender',Math.max(14,sourceX),start,packet.phase!=='start'],['receiver',Math.max(14,targetX),end,['ping','fade'].includes(packet.phase)]]){
      const size=expanded?24:0;
      const ring=div().id(`panel-${suffix}-${id}`).absolute().left(x-size/2).top(y-size/2).w(size).h(size)
        .rounded(1).border(1).border_color(color).opacity(expanded?0:1);
      for(const property of ['width','height','left','top','opacity'])ring.transition(property,{duration:460,easing:'ease-out'});
      base.child(ring);
    }
    if(packet.phase==='fade')base.opacity(0).when(motion,e=>e.transition('opacity',460));
    return base;
  }
  if(dashed){
    // Dashes remain visible for the lifetime of a connection. The dim dot
    // travels slowly in one direction; it is not a message packet.
    const radius=Math.min(6,height/2);
    for(let y=radius;y<height-radius;y+=8)base.child(div().absolute().left(lane).top(y).w(1).h(Math.min(3,height-radius-y)).bg(color));
    for(const y of [0,height])for(let x=0;x<lane-radius;x+=7)base.child(div().absolute().left(x).top(y).w(Math.min(4,lane-radius-x)).h(2).bg(color));
    const elbows=PathBuilder.stroke(1).move_to(lane-radius,0)
      .cubic_bezier_to(lane,radius,lane,0,lane,0)
      .move_to(lane,height-radius).cubic_bezier_to(lane-radius,height,lane,height,lane,height).build();
    base.child(window.paint_path(elbows,color).absolute().left(0).top(0).w(PANEL_FLOW.width).h(height+3));
    if(motion&&!relation)base.child(div().id(`panel-link-dot-${id}`).absolute().left(lane-1).size(3).rounded(2).bg(color)
      .loop('top',{from:0,to:height,period:16000,easing:'linear'}));
  }else{
    const origin=Math.max(0,-startX,-endX);
    const path=routePath(a.y-top,b.y-top,lane,endX,origin,startX);
    base.child(window.paint_path(path,color).absolute().left(-origin).top(0).w(PANEL_FLOW.width+origin).h(height+3));
    if(packet&&motion&&['start','travel'].includes(packet.phase)){
      const elapsed=packet.elapsed;
      const point=elapsed<40?{x:startX,y:a.y-top,ms:1}
        :elapsed<300?{x:lane,y:a.y-top,ms:260}
        :elapsed<1400?{x:lane,y:b.y-top,ms:1100}
        :{x:endX,y:b.y-top,ms:240};
      // Native delayed copies form a real fading tail, following the same
      // finite corner targets as the head. No per-frame JavaScript runs.
      for(const [index,size,opacity,delay] of [[1,6,0.8,40],[2,5,0.6,80],[3,4,0.4,120],[4,3,0.2,160]])
        base.child(div().id(`panel-packet-tail-${id}-${index}`).absolute().left(point.x-size/2).top(point.y-size/2)
          .size(size).rounded(1).bg(color).opacity(opacity)
          .transition('left',{duration:point.ms,delay,easing:'ease-in-out'})
          .transition('top',{duration:point.ms,delay,easing:'ease-in-out'}));
      base.child(div().id(`panel-packet-${id}`).absolute().left(point.x-4).top(point.y-4).size(8).rounded(1).bg(color)
        .child(div().absolute().left(3).top(3).size(2).bg('#FFFFFF'))
        .transition('left',{duration:point.ms,easing:'ease-in-out'})
        .transition('top',{duration:point.ms,easing:'ease-in-out'}));
    }
    if(packet?.phase==='fade')base.opacity(0.2).when(motion,e=>e.transition('opacity',900));
    if(packet&&motion){
      // Keep a zero-size receiver keyed throughout travel. At arrival its
      // native width/height expand while opacity fades from one to zero.
      const departing=packet.phase!=='start',departureSize=departing?24:0;
      const departure=div().id(`panel-sender-${id}`).absolute().left(startX-departureSize/2).top(a.y-top-departureSize/2)
        .w(departureSize).h(departureSize).rounded(1).border(1).border_color(color).opacity(departing?0:1);
      for(const property of ['width','height','left','top','opacity'])departure.transition(property,{duration:460,easing:'ease-out'});
      base.child(departure);
      const arriving=['ping','fade'].includes(packet.phase),size=arriving?24:0;
      const ring=div().id(`panel-receiver-${id}`).absolute().left(endX-size/2).top(b.y-top-size/2)
        .w(size).h(size).rounded(1).border(1).border_color(color).opacity(arriving?0:1);
      for(const property of ['width','height','left','top','opacity'])ring.transition(property,{duration:460,easing:'ease-out'});
      base.child(ring);
    }
  }
  return base;
}

export function panelFlowLayer(feed,layout,state,color,t,motion,width){
  const layer=div().absolute().left(0).top(0).w_full().h(layout.height);
  // A filtered-out source still keeps its computer-to-computer connection.
  // Only its workspace/session rows disappear from the selected list.
  for(const space of feed.spaces){
    if(!space.share||layout.cards.some(card=>card.space.id===space.id))continue;
    const a=layout.anchors.get(space.computer),b=layout.anchors.get(space.share.computer);
    if(!a||!b)continue;
    const tone=color(space.bundle||space.id);
    layer.child(route(`share-computers-${space.id}`,a,b,tone,{dashed:true,motion}));
    for(const [index,end] of [a,b].entries())layer.child(div().id(`panel-share-end-${space.id}-${index}`).absolute().right(RIGHT-3).top(end.y-3)
      .when(space.share.kind==='agent',e=>e.size(6).rounded(3).bg(tone))
      .when(space.share.kind==='space',e=>e.child(square(tone,false))));
  }
  for(const card of layout.cards){
    const s=card.space;if(!s.share)continue;
    const from=layout.anchors.get(s.share.kind==='agent'?s.share.agent_id:s.id),to=layout.anchors.get(s.share.computer);
    if(!from||!to)continue;
    layer.child(route(`share-${s.id}`,from,to,color(s.bundle||s.id),{dashed:true,motion}));
    layer.child(div().absolute().right(RIGHT-3).top(from.y-3).when(s.share.kind==='agent',e=>e.size(6).rounded(3).bg(color(s.bundle||s.id)))
      .when(s.share.kind==='space',e=>e.child(square(color(s.bundle||s.id),false))));
    layer.child(div().id(`panel-share-computer-${s.id}`).absolute().right(RIGHT-3).top(to.y-3)
      .when(s.share.kind==='agent',e=>e.size(6).rounded(3).bg(color(s.bundle||s.id)))
      .when(s.share.kind==='space',e=>e.child(square(color(s.bundle||s.id),false))));
  }
  for(const link of feed.links){
    const a=layout.anchors.get(link.a),b=layout.anchors.get(link.b);if(!a||!b)continue;
    if(link.kind==='collaboration'){
      layer.child(route(`collaboration-${link.a}-${link.b}`,a,b,'#c3a6ff').opacity(0.55));
      for(const [index,end] of [a,b].entries())layer.child(div().id(`panel-collaboration-end-${link.a}-${link.b}-${index}`)
        .absolute().right(RIGHT-3).top(end.y-3).child(square('#c3a6ff',false)).bg(t.chrome));
    }else if(link.kind==='task')layer.child(route(`task-${link.a}-${link.b}`,{...a,x:-8},{...b,x:-8},t.dim,{relation:true}));
  }
  for(const packet of state.packets){
    const endpoints=packet.kind==='message'?panelMessageAnchors(feed,layout,packet):[panelFlowAnchor(feed,layout,packet.from),panelFlowAnchor(feed,layout,packet.to)];
    const a=endpoints[0];let b=endpoints[1];
    if(b&&packet.kind==='memory'){
      const target=feed.spaces.find(space=>space.id===packet.to);
      if(target)b={...b,x:panelHeaderMetrics(target,width).memoryAnchorX};
    }
    if(a&&b){
      const tone=a.computer===b.computer?(paletteMode(t)==='light'?'#006C77':'#8FEFFF'):color(feed.spaces.find(s=>s.id===a.space)?.bundle);
      if(a.computer!==b.computer)layer.child(route(`remote-${packet.id}`,a,b,tone,{dashed:true,motion:false}));
      layer.child(route(packet.id,a,b,tone,{packet,motion}));
    }
  }
  if(!motion)for(const event of state.connections){
    const [a,b]=event.kind==='message'?panelMessageAnchors(feed,layout,event):[panelFlowAnchor(feed,layout,event.from),panelFlowAnchor(feed,layout,event.to)];if(a&&b)layer.child(route(event.id,a,b,t.dim,{packet:event.kind==='message'?{...event,phase:'static'}:null}));
  }
  return layer;
}

export function renderPanelTracking(view,t,cx,{macTitlebar=false}={}){
  const feed=view.panelState.feed;
  const motion=shared('sixfold.motion')!==false&&feed.reduced_motion!==true&&view.panelReducedMotion!==true;
  const now=Date.now();
  const state=panelEventStates(feed,now,{previous:view.panelEvents,motion});view.panelEvents=state;
  let nextAt=state.nextAt;
  for(const packet of state.packets)for(const offset of (packet.kind==='message'?[495]:[300,1400])){
    const at=packet.at+offset;if(at>now&&(nextAt===null||at<nextAt))nextAt=at;
  }
  if(view.panelWakeAt!==nextAt){
    view.panelWakeTimer?.cancel();view.panelWakeAt=nextAt;
    if(nextAt!==null)view.panelWakeTimer=cx.timer.after(Math.max(1,nextAt-now),cx=>{view.panelWakeAt=null;cx.notify();});
  }
  view.expandedIssueSpaces??=new Set();view.expandedParents??=new Set();
  const grouped=new Map(feed.spaces.map(space=>[space.id,agentGroups(space,{includeClosedIds:new Set(state.tags.keys()),expandedIssueSpaces:view.expandedIssueSpaces,expandedParents:view.expandedParents})]));
  const layout=panelLayout(feed,state,spaces(),grouped);
  view.rowMeta=new Map([...grouped.values()].flatMap(group=>[...group.rowMeta]));
  view.toggleIssues=id=>{view.expandedIssueSpaces.has(id)?view.expandedIssueSpaces.delete(id):view.expandedIssueSpaces.add(id);cx.notify();};
  view.toggleChildren=id=>{view.expandedParents.has(id)?view.expandedParents.delete(id):view.expandedParents.add(id);cx.notify();};
  const colors=groupColors(feed.spaces.map(s=>s.bundle||s.id),paletteMode(t));
  const color=key=>colors.get((key||'').trim().toLowerCase())?.color||t.accent;
  const names=new Map(feed.computers.map(c=>[c.id,c.name]));
  view.names=names;
  const rows=v_flex().relative().flex_none();
  rows.child(h_flex().h(24).px(10).items_center().child(text('COMPUTERS',t.dim,10).font_bold()));
  for(const computer of feed.computers)rows.child(h_flex().id(`panel-computer-${computer.id}`).h(32).mb(4).ml(8).mr(RIGHT).px(7).gap(6).items_center().rounded(5).bg(t.surface)
    .child(svg('mods/sixfold-desk/icons/device-computer.svg').size(15).flex_none().text_color(color(computer.bundle)))
    .child(text(computer.name,t.foreground,11).flex_1())
    .when(computer.traffic.up!==null||computer.traffic.down!==null,e=>e.child(text(`↑${computer.traffic.up??'—'} ↓${computer.traffic.down??'—'}`,t.dim,9)))
    .child(square(computer.linked?color(computer.bundle):t.dim,computer.linked,5)));
  rows.child(h_flex().h(28).px(10).items_center().child(text('SPACES',t.dim,10).font_bold()));
  for(const card of layout.cards)rows.child(cardView(view,card,state,color(card.space.bundle||card.space.id),names,t,motion));
  rows.child(panelFlowLayer(feed,layout,state,color,t,motion,view.panelWidth||224));
  const working=panelCounts(feed).working;
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
