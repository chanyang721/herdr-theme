// Display order only: never moves or closes a workspace.
export function orderWorkspaceGroups(groups, isPinned, isWorking) {
  return groups.map((group,index)=>({group,index,rank:isPinned(group.s)?0:isWorking(group)?1:2}))
    .sort((a,b)=>a.rank-b.rank || a.index-b.index).map(item=>item.group);
}
