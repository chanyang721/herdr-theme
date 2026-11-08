// Local display projection. Cached tool results are supplied by the feed;
// opening, searching and changing scopes never contact an external service.
export function issueScopeData(space,scope='week',query=''){
  const catalog=space.issue_catalog;
  const selected=new Map((space.issues||[]).map(issue=>[issue.key,issue]));
  const week=new Set((catalog?.week||space.issues||[]).map(issue=>issue.key));
  const project=issue=>{
    const picked=selected.get(issue.key);
    const pinned=typeof picked?.pinned==='boolean'?picked.pinned:typeof issue.pinned==='boolean'?issue.pinned:selected.has(issue.key)&&!week.has(issue.key);
    return {...issue,week:issue.week===true||picked?.week===true||week.has(issue.key),pinned};
  };
  const sources={week:catalog?.week||space.issues||[],milestone:catalog?.milestone||[],all:catalog?.all||[]};
  const needle=query.normalize('NFC').trim().toLocaleLowerCase();
  const matches=issue=>!needle||`${issue.key} ${issue.title}`.normalize('NFC').toLocaleLowerCase().includes(needle);
  const rows=(sources[scope]||sources.week).map(project).filter(matches);
  const byMilestone=new Map();
  for(const issue of rows){
    const key=issue.milestone_id||'';
    if(!byMilestone.has(key))byMilestone.set(key,[]);
    byMilestone.get(key).push(issue);
  }
  const milestones=new Map((catalog?.milestones||[]).map(item=>[item.id,item]));
  const groups=[...byMilestone].map(([id,items])=>{
    const meta=milestones.get(id);
    return {id:id||'none',name:meta?.name||(id?'마일스톤 정보 없음':'마일스톤 없음'),due:meta?.due||'',
      progress:typeof meta?.progress==='number'?`${Math.round(meta.progress*10)/10}%`:'',items};
  });
  return {rows,groups,scopeCounts:Object.fromEntries(Object.entries(sources).map(([key,value])=>[key,value.length]))};
}

export function issueCacheLabel(space,scope='week'){
  const tool=space.work?.tool==='linear'?'Linear':space.work?.tool==='jira'?'Jira':'업무 도구';
  const cache=space.issue_catalog?.cache,local=cache?.scopes?.[scope];
  if(!cache)return {label:`${tool} · 로컬 이슈 목록`,emptyLabel:'이 범위에 표시할 이슈가 없습니다'};
  const missing=local?.state==='missing',stale=local?local.state==='stale':cache.state==='stale';
  const state=missing?'미수집':stale?'이전 수집 결과':cache.state==='empty'?'저장된 이슈 없음':'저장된 이슈';
  const at=local?.at||cache.at;
  return {label:`${tool} · ${state}${at?` · ${at}`:''}`,
    emptyLabel:missing?'이 범위의 이슈를 아직 수집하지 않았습니다':'이 범위에 표시할 이슈가 없습니다'};
}

// Fixed relative outbox only. Feed-supplied arbitrary paths, URLs, native
// addresses and traversal sequences never become file write destinations.
export function issueRequest(feedPath,space,key,desired,id){
  const request=space.issue_catalog?.import_request;
  if(!request||request.path!=='panel-issue-requests'||request.space!==space.id
    ||!['linear','jira'].includes(space.work?.tool)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))return null;
  const available=new Set(['week','milestone','all'].flatMap(scope=>(space.issue_catalog[scope]||[]).map(issue=>issue.key)));
  if(!available.has(key)||typeof desired!=='boolean'||typeof feedPath!=='string')return null;
  if(!desired&&(space.issue_catalog.week||[]).some(issue=>issue.key===key))return null;
  const slash=Math.max(feedPath.lastIndexOf('/'),feedPath.lastIndexOf('\\'));
  if(slash<0)return null;
  return {path:`${feedPath.slice(0,slash)}/panel-issue-requests/${id}.json`,
    value:{v:1,id,space:space.id,tool:space.work.tool,keys:[key],action:desired?'import':'remove'}};
}

// Exclusive creation reserves a unique name. The second SDK write atomically
// replaces that empty reservation with the complete JSON document. Consumers
// ignore incomplete/empty requests and retry on the next file notification.
export async function saveIssueRequest(request,writeTextFile){
  if(!request)throw new Error('Issue request is unavailable');
  await writeTextFile(request.path,'',null);
  await writeTextFile(request.path,JSON.stringify(request.value),'');
  return request.value.id;
}
