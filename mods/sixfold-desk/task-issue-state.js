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

// '14:05 갱신' today, '11/9 14:05 갱신' another day (this computer's time zone); unreadable stays out.
export function updatedAt(at,now=new Date()){
  const d=new Date(at);if(!at||Number.isNaN(d.getTime()))return '';
  const p=n=>String(n).padStart(2,'0'),time=`${p(d.getHours())}:${p(d.getMinutes())}`;
  const today=d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
  return `${today?'':`${d.getMonth()+1}/${d.getDate()} `}${time} 갱신`;
}
export function issueCacheLabel(space,scope='week',now=new Date()){
  const tool=space.work?.tool==='linear'?'Linear':space.work?.tool==='jira'?'Jira':'업무 도구';
  const cache=space.issue_catalog?.cache,local=cache?.scopes?.[scope];
  if(!cache)return {label:`${tool} · 로컬 이슈 목록`,emptyLabel:'이 범위에 표시할 이슈가 없습니다'};
  const missing=local?.state==='missing',stale=local?local.state==='stale':cache.state==='stale';
  const state=missing?'미수집':stale?'이전 수집 결과':cache.state==='empty'?'저장된 이슈 없음':'저장된 이슈';
  const at=updatedAt(local?.at||cache.at,now);
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

// --- week-timeline.json as the newer source of the issue window -------------------------------
// The collector behind the weekly timeline refreshes data/sixfold/week-timeline.json on a schedule,
// while the feed's issue_catalog only changes when something writes it. When the timeline is newer,
// the window shows it (same-named project only); pins, import requests and results stay as they were.
const TIMELINE_STATE = {todo: 'waiting', started: 'working', review: 'review', done: 'done'};
const KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
export function parseTimelineFeed(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!value || value.v !== 2 || !Array.isArray(value.projects) || !Number.isFinite(Date.parse(value.updated || ''))) return null;
  return {updated: value.updated, week: {start: DAY.test(value.week?.start || '') ? value.week.start : '', end: DAY.test(value.week?.end || '') ? value.week.end : ''},
    projects: value.projects.slice(0, 8).filter(p => p && typeof p.workspace === 'string' && p.workspace).map(p => ({
      workspace: p.workspace,
      milestones: (Array.isArray(p.milestones) ? p.milestones : []).slice(0, 100).filter(m => m && typeof m.id === 'string' && m.id && typeof m.name === 'string')
        .map(m => ({id: m.id.slice(0, 80), name: m.name.slice(0, 100), due: DAY.test(m.target || '') ? m.target : '',
          progress: typeof m.progress === 'number' && m.progress >= 0 && m.progress <= 100 ? m.progress : null})),
      issues: (Array.isArray(p.issues) ? p.issues : []).slice(0, 800).filter(i => i && KEY.test(i.key) && i.state in TIMELINE_STATE).map(i => ({
        key: i.key, title: str(i.title, 200), state: i.blocked === true && i.state !== 'done' ? 'blocked' : TIMELINE_STATE[i.state],
        due: DAY.test(i.due || '') ? i.due : '', done_at: DAY.test(i.done_at || '') ? i.done_at : '', milestone_id: str(i.milestone, 80),
        ...(typeof i.url === 'string' && /^https:\/\/linear\.app\//.test(i.url) ? {url: i.url} : {}),
      })),
    }))};
}

// The space with a catalog made from the timeline, or the same space when the timeline is missing,
// has no project of that name, or is not newer than the catalog.
export function spaceWithTimeline(space, feed) {
  const project = feed?.projects?.find(p => p.workspace === space.name);
  if (!project) return space;
  const old = space.issue_catalog, oldAt = Date.parse(old?.updated_at || old?.cache?.at || '');
  if (Number.isFinite(oldAt) && oldAt >= Date.parse(feed.updated)) return space;
  const end = feed.week.end;
  const week = project.issues.filter(i => i.state === 'done' ? Boolean(end) && i.done_at >= feed.week.start && i.done_at <= end
    : i.state === 'working' || i.state === 'review' || i.state === 'blocked' || Boolean(i.due) && (!end || i.due <= end));
  const weekMilestones = new Set(week.map(i => i.milestone_id).filter(Boolean));
  return {...space, issue_catalog: {
    ...(old || {}), week, milestone: project.issues.filter(i => weekMilestones.has(i.milestone_id)), all: project.issues,
    milestones: project.milestones, import_request: old?.import_request ?? null,
    cache: {state: project.issues.length ? 'ready' : 'empty', at: feed.updated}, updated_at: feed.updated,
  }};
}
