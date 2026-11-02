// Preserve only observed parent relationships. Unknown parents and cycles are
// excluded rather than guessed into the selected workspace.
export function workflowNodes(incoming, terminals) {
  const roots = new Set(terminals);
  const result = [];
  const known = new Map([...roots].map(id=>[id,id]));
  let pending = (incoming ?? []).filter(node=>node && typeof node.id==='string'
    && typeof node.parent==='string' && roots.has(node.terminal) && !roots.has(node.id));
  while (pending.length) {
    const ready = pending.filter(node=>known.get(node.parent)===node.terminal && !known.has(node.id));
    if (!ready.length) break;
    for (const node of ready) {
      if (known.has(node.id)) continue;
      known.set(node.id,node.terminal);
      const parent = result.find(item=>item.id===node.parent);
      result.push({...node,depth:(parent?.depth??0)+1});
    }
    pending = pending.filter(node=>!known.has(node.id));
  }
  return result;
}

export function delegationEvents(incoming, nodes) {
  const indexed = new Map(nodes.map(node=>[node.id,node]));
  return (incoming??[]).filter(event=>event.kind==='delegate'
    && indexed.get(event.target)?.parent===event.source);
}

export function workflowStatus(node, language='ko') {
  const labels = language==='ko'
    ? {finished:'종료',recent:'활동 추정',quiet:'조용함 추정',open:'연결 기록',closed:'연결 종료',working:'작업 중',idle:'대기',done:'완료',blocked:'확인 필요'}
    : {recent:'Recent (estimated)',quiet:'Quiet (estimated)',open:'Link recorded'};
  return labels[node.status] || node.status || (language==='ko'?'상태 미확인':'Unknown');
}
