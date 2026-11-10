// The document finder's data side: no GPUI, no I/O. A space's indexed files become
// prepared items once (folded names, kind, folder label), then every query, chip and
// sort is a pure pass over them, so the popover recomputes only when its inputs change.

export const DOC_TABS=Object.freeze([{id:'all',label:'전체'},{id:'opened',label:'최근 연'},{id:'folders',label:'폴더'}]);
export const DOC_KINDS=Object.freeze([{id:'all',label:'모든 종류'},{id:'md',label:'md'},{id:'html',label:'html'},{id:'pdf',label:'pdf'},{id:'other',label:'기타'}]);
export const DOC_PERIODS=Object.freeze([{id:'all',label:'전 기간'},{id:'today',label:'오늘'},{id:'week',label:'7일'},{id:'month',label:'30일'}]);
export const DOC_SORTS=Object.freeze([{id:'modified',label:'최근 수정'},{id:'name',label:'이름'},{id:'opened',label:'최근 연'}]);
export const OPENED_LIMIT=200;

const DAY=86400000,KST=9*3600000;
const fold=value=>String(value??'').normalize('NFC').toLocaleLowerCase();
const BOUNDARY=/[\s_\-./()[\]·,]/;
const base=path=>{const parts=String(path||'').split(/[\\/]/).filter(Boolean);return parts.at(-1)||'';};
const dir=path=>{const text=String(path||'');const cut=Math.max(text.lastIndexOf('/'),text.lastIndexOf('\\'));return cut>0?text.slice(0,cut):'';};

export function docKind(path){
  const ext=(/\.([A-Za-z0-9]+)$/.exec(String(path||''))?.[1]||'').toLowerCase();
  return ext==='md'||ext==='markdown'?'md':ext==='html'||ext==='htm'?'html':ext==='pdf'?'pdf':'other';
}
export const docArchived=file=>file?.archived===true||/archive|아카이브|보관|\.before-/i.test(String(file?.path||'').normalize('NFC'));
// Opens in the space's 문서 tab; everything else goes to its default app.
export const docReadable=path=>/\.(md|html?)$/i.test(String(path||''));

// "Root/sub/dir" for a file: the configured root's own name, then the path under it.
export function folderLabel(file){
  const folder=file.folder||dir(file.path);
  const root=file.sourceRoot||'';
  if(root&&(folder===root||folder.startsWith(root+'/')||folder.startsWith(root+'\\'))){
    const rest=folder.slice(root.length).replace(/^[\\/]+/,'');
    return rest?`${base(root)}/${rest}`:base(root);
  }
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

// KST wall clock for a timestamp, without Intl (the runtime may not carry time zones).
export function kstParts(ms){
  const d=new Date(ms+KST);
  return {y:d.getUTCFullYear(),m:d.getUTCMonth()+1,d:d.getUTCDate(),hh:d.getUTCHours(),mm:d.getUTCMinutes()};
}
const pad=n=>String(n).padStart(2,'0');
export function kstClock(ms){if(!Number.isFinite(ms))return '';const p=kstParts(ms);return `${pad(p.hh)}:${pad(p.mm)}`;}
export function kstDate(ms,now=Date.now()){
  if(!Number.isFinite(ms))return '';
  const p=kstParts(ms),n=kstParts(now);
  return p.y===n.y?`${p.m}/${p.d}`:`${p.y}/${p.m}/${p.d}`;
}
// Start of the KST day that holds `now`.
const kstDayStart=now=>Math.floor((now+KST)/DAY)*DAY-KST;

const prepared=new WeakMap();
export function prepareDocs(group){
  if(!group||!Array.isArray(group.files))return [];
  const cached=prepared.get(group);
  if(cached)return cached;
  const items=[];
  const seen=new Set();
  for(const file of group.files){
    if(!file||typeof file.path!=='string'||seen.has(file.path))continue;
    seen.add(file.path);
    const name=String(file.name||base(file.path)).normalize('NFC');
    const label=folderLabel(file);
    items.push({key:file.path,path:file.path,name,nameF:fold(name),folder:file.folder||dir(file.path),folderLabel:label,folderF:fold(label),
      kind:docKind(file.path),archived:docArchived(file),mtime:Number.isFinite(file.mtime)?file.mtime:0});
  }
  prepared.set(group,items);
  return items;
}

// One query word against one folded text: 0 when it does not match. A contiguous hit
// beats a scattered one; a hit at the start or after a separator beats one inside a word.
export function scoreToken(token,text){
  if(!token)return 1;
  const at=text.indexOf(token);
  if(at>=0){
    let score=100+token.length*6;
    if(at===0)score+=40;else if(BOUNDARY.test(text[at-1]))score+=25;
    return score-Math.min(at,40)*0.5;
  }
  let ti=0,score=0,prev=-2,first=-1;
  for(let i=0;i<text.length&&ti<token.length;i++){
    if(text[i]!==token[ti])continue;
    if(first<0)first=i;
    score+=i===prev+1?6:1;
    if(i===0||BOUNDARY.test(text[i-1]))score+=4;
    prev=i;ti++;
  }
  if(ti<token.length)return 0;
  // A subsequence spread over the whole name is barely a match.
  const span=prev-first+1;
  return Math.max(1,score-Math.max(0,span-token.length*3)*0.3-Math.min(first,40)*0.2);
}
export const queryTokens=query=>fold(query).split(/\s+/).filter(Boolean);
// Every word must hit the name or the folder; the name counts double.
export function scoreDoc(tokens,item){
  let total=0;
  for(const token of tokens){
    const name=scoreToken(token,item.nameF),folder=scoreToken(token,item.folderF);
    if(!name&&!folder)return 0;
    total+=Math.max(name*2,folder);
  }
  return total;
}

function periodStart(period,now){
  const today=kstDayStart(now);
  return period==='today'?today:period==='week'?today-6*DAY:period==='month'?today-29*DAY:null;
}

const byName=(a,b)=>a.nameF<b.nameF?-1:a.nameF>b.nameF?1:a.key<b.key?-1:a.key>b.key?1:0;
const byModified=(a,b)=>b.mtime-a.mtime||byName(a,b);

// The whole popover's list state from one set of inputs.
// opened: Map(path → last opened ms). Returns rows (sorted items), counts for every chip and
// tab (each counted with the other choices applied), and the folders tab's list.
export function docsView(items,options={}){
  const {query='',tab='all',kind='all',period='all',archive=false,sort='modified',folder=null,opened=new Map(),now=Date.now()}=options;
  const tokens=queryTokens(query);
  const since=periodStart(period,now);
  const kinds={all:0,md:0,html:0,pdf:0,other:0},periods={all:0,today:0,week:0,month:0};
  const starts={today:periodStart('today',now),week:periodStart('week',now),month:periodStart('month',now)};
  const tabs={all:0,opened:0,folders:0};
  const folders=new Map();
  const rows=[];
  const scores=tokens.length?new Map():null;
  let archivedHidden=0;
  for(const item of items){
    if(item.archived&&!archive){archivedHidden++;continue;}
    let score=1;
    if(tokens.length){score=scoreDoc(tokens,item);if(!score)continue;}
    const inPeriod=since===null||item.mtime>=since;
    const inKind=kind==='all'||item.kind===kind;
    const wasOpened=opened.has(item.key);
    const inTab=tab!=='opened'||wasOpened;
    const inFolder=!folder||item.folder===folder;
    // The folders tab lists where matches are, before a folder is chosen.
    if(inPeriod&&inKind){
      const entry=folders.get(item.folder)||{key:item.folder,label:item.folderLabel,count:0,newest:0};
      entry.count++;if(item.mtime>entry.newest)entry.newest=item.mtime;folders.set(item.folder,entry);
    }
    if(!inFolder)continue;
    if(inPeriod&&inTab){kinds.all++;kinds[item.kind]++;}
    if(inKind&&inTab){periods.all++;for(const id of ['today','week','month'])if(item.mtime>=starts[id])periods[id]++;}
    if(inPeriod&&inKind){tabs.all++;if(wasOpened)tabs.opened++;}
    if(inPeriod&&inKind&&inTab){rows.push(item);if(scores)scores.set(item.key,score);}
  }
  const openedAt=item=>opened.get(item.key)||0;
  let compare;
  if(sort==='name')compare=byName;
  else if(sort==='opened'||(tab==='opened'&&!tokens.length))compare=(a,b)=>openedAt(b)-openedAt(a)||byModified(a,b);
  else compare=byModified;
  // Typing ranks by match first (the default sort only); an explicit sort keeps its order.
  if(scores&&sort==='modified')rows.sort((a,b)=>scores.get(b.key)-scores.get(a.key)||compare(a,b));
  else rows.sort(compare);
  const folderList=[...folders.values()].sort((a,b)=>b.newest-a.newest||(a.label<b.label?-1:1));
  tabs.folders=folderList.length;
  return {rows,kinds,periods,tabs,folders:folderList,archivedHidden,total:items.length,searching:tokens.length>0};
}

// The next sort in the one-chip cycle.
export const nextSort=sort=>DOC_SORTS[(DOC_SORTS.findIndex(item=>item.id===sort)+1)%DOC_SORTS.length].id;
// Keyboard highlight: wraps at both ends, -1 when the list is empty.
export function moveSelection(index,delta,count){
  if(count<=0)return -1;
  if(index<0||index>=count)return delta>0?0:count-1;
  return (index+delta+count)%count;
}

// The opened-documents record: newest first, at most OPENED_LIMIT paths.
export function recordOpened(opened,path,at=Date.now()){
  const next=new Map([[path,at],...[...opened].filter(([key])=>key!==path)]);
  return new Map([...next].sort((a,b)=>b[1]-a[1]).slice(0,OPENED_LIMIT));
}
export function openedFromJson(value){
  const map=new Map();
  const entries=value&&typeof value==='object'&&value.version===1&&value.opened&&typeof value.opened==='object'&&!Array.isArray(value.opened)?Object.entries(value.opened):[];
  for(const [path,at] of entries)if(typeof path==='string'&&Number.isFinite(at))map.set(path,at);
  return new Map([...map].sort((a,b)=>b[1]-a[1]).slice(0,OPENED_LIMIT));
}
export const openedToJson=opened=>JSON.stringify({version:1,opened:Object.fromEntries(opened)});
