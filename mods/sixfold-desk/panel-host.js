// Join display records only through explicit native navigation identities.
export const PANEL_FLOW=Object.freeze({gutter:72,right:8,width:64,message:20,messageNext:24,collaboration:30,computer:40,endpoint:0});

// Only filtered remote endpoints project to their explicitly identified
// computer. Hidden local rows must not acquire an invented route.
export function panelFlowAnchor(feed,layout,id){
  const direct=layout.anchors.get(id);if(direct)return direct;
  const owner=feed.spaces.find(space=>space.id===id||space.agents.some(agent=>agent.id===id));
  if(!owner||layout.cards.some(card=>card.space.computer===owner.computer))return null;
  return layout.anchors.get(owner.computer)||null;
}

export function taskComputerRecord(feed,machine){
  const ids=new Set((feed?.spaces||[]).filter(space=>space.nav&&space.nav.machine===(machine??null)).map(space=>space.computer));
  return ids.size===1?feed.computers.find(computer=>ids.has(computer.id))||null:null;
}

// A remote space can share a bare ID or a name with a local space.
export function nativeTaskSpace(feed, nativeSpace) {
  if (!nativeSpace) return null;
  const machine=nativeSpace.machine??null;
  const bare=String(nativeSpace.id).split('/').pop();
  const matches=(feed?.spaces||[]).filter(space=>space.nav&&space.nav.space_id===bare&&space.nav.machine===machine);
  return matches.length===1?matches[0]:null;
}

// Native workspace headers, alerts and document panels surround retained task
// bodies. Translate packet anchors into that same, computer-filtered list.
export function hostedTaskLayout(layout, entries, computerAnchors=[]) {
  const anchors=new Map(computerAnchors),cards=[];let y=0;
  for(const entry of entries){
    const card=layout?.cards.find(card=>card.space.id===entry.task?.id);
    if(card){
      const header=41+(entry.alertHeight||0);
      const delta=y+header-(card.top+35);
      const next={...card,top:y,rows:card.rows.map(row=>({...row,y:row.y+delta}))};
      cards.push(next);
      anchors.set(card.space.id,{...layout.anchors.get(card.space.id),y:y+18});
      // Shift each route anchor with its row. panelLayout already placed it
      // on the title line, which is not the middle of a two-line reason row.
      for(const row of next.rows)if(row.kind==='agent'){
        const anchor=layout.anchors.get(row.agent.id);
        anchors.set(row.agent.id,{...anchor,y:Number.isFinite(anchor?.y)?anchor.y+delta:row.y+row.height/2});
      }
    }
    y+=entry.height+12;
  }
  return {anchors,cards,height:y};
}

export function taskComputerAnchors(feed, rows, listHeight, headingHeight) {
  const result=[];
  for(const computer of feed?.computers||[]){
    const identities=new Set((feed.spaces||[]).filter(space=>space.computer===computer.id&&space.nav).map(space=>space.nav.machine));
    if(identities.size!==1)continue;
    const machine=[...identities][0],index=rows.findIndex(row=>row.name===machine);
    if(index<0)continue;
    result.push([computer.id,{kind:'computer',computer:computer.id,y:index*39+18-listHeight-headingHeight}]);
  }
  return result;
}

// Explicit row endpoints stay on those rows, even across spaces. Space-wide
// sends use headers, and a filtered remote endpoint uses its known computer.
export function panelMessageAnchors(feed,layout,event){
 return [panelFlowAnchor(feed,layout,event.from),panelFlowAnchor(feed,layout,event.to)];
}

// All flow lanes share one fixed right gutter (PANEL_FLOW.gutter): a wider
// sidebar widens the cards, never the gutter. The layout only changes when the
// sidebar crosses one of these widths (stacked stage, short stage bar, compact
// header), so nothing needs to redraw between them.
export const PANEL_BREAKPOINTS=Object.freeze([260,300,420]);
export function panelWidthClass(width){
 return PANEL_BREAKPOINTS.filter(edge=>width>=edge).length;
}
export function messageFlowGeometry(gutter){
 if(!Number.isFinite(gutter))return PANEL_FLOW;
 const width=Math.max(25,gutter-8);
 return {...PANEL_FLOW,gutter,width,computer:Math.min(PANEL_FLOW.computer,width-5),collaboration:Math.min(PANEL_FLOW.collaboration,width-12)};
}

// The cubic control width is 12 + 8% of the row distance, capped at32px.
// Its midpoint is three quarters of that width. A second queued lane remains
// inside the same 24px message band instead of crossing static links.
export function messageCurveReach(distance,lane=0){
 return .75*Math.max(8,Math.min(32,12+Math.abs(distance)*.08)-Math.min(1,Math.max(0,lane))*4);
}

export function computerFlow(feed,computer,flow=PANEL_FLOW){
 const local=taskComputerRecord(feed,null)?.id||feed.computers[0]?.id;
 const index=Math.max(0,feed.computers.filter(item=>item.id!==local).findIndex(item=>item.id===computer));
 return {...flow,computer:Math.min(flow.width,flow.computer+index*8)};
}
