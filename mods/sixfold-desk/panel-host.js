// Join display records only through explicit native navigation identities.
export const PANEL_FLOW=Object.freeze({gutter:72,right:8,width:64,message:22,messageNext:32,collaboration:44,computer:60,endpoint:14});

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
      for(const row of next.rows)if(row.kind==='agent')anchors.set(row.agent.id,{...layout.anchors.get(row.agent.id),y:row.y+row.height/2});
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
