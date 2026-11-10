import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {prepareDocs,docsView,scoreToken,queryTokens,folderLabel,docKind,docArchived,moveSelection,nextSort,
  recordOpened,openedFromJson,openedToJson,kstDate,kstClock,OPENED_LIMIT} from '../mods/sixfold-desk/docs-finder-model.js';

const DAY=86400000;
// 2026-11-10 15:00 KST.
const NOW=Date.UTC(2026,10,10,6,0,0);
const file=(path,mtime=NOW,extra={})=>({path,name:path.split('/').at(-1),mtime,folder:path.slice(0,path.lastIndexOf('/')),sourceRoot:'/r/Reports',...extra});
const group=files=>({folder:'/r/Reports',files});
const names=rows=>rows.map(row=>row.name);

test('fuzzy matching ranks prefix, word start, substring and scattered letters in that order and needs every word',()=>{
  assert.ok(scoreToken('보고','보고서.md')>scoreToken('보고','주간보고.md'),'a prefix beats a hit inside a word');
  assert.ok(scoreToken('보고','주간_보고.md')>scoreToken('보고','주간보고.md'),'a hit after a separator beats one inside a word');
  assert.ok(scoreToken('dsgn','design.md')>0,'letters in order match');
  assert.ok(scoreToken('design','design.md')>scoreToken('dsgn','design.md'),'contiguous beats scattered');
  assert.equal(scoreToken('xyz','design.md'),0);
  const items=prepareDocs(group([file('/r/Reports/20261110_문서찾기_설계.md'),file('/r/Reports/고객사/계약_검토.md'),file('/r/Reports/설계/notes.md')]));
  assert.deepEqual(names(docsView(items,{query:'문서 설계',now:NOW}).rows),['20261110_문서찾기_설계.md'],'every word must match');
  assert.deepEqual(names(docsView(items,{query:'고객사',now:NOW}).rows),['계약_검토.md'],'the folder path matches too');
  assert.deepEqual(names(docsView(items,{query:'설계',now:NOW}).rows),['20261110_문서찾기_설계.md','notes.md'],'a name hit outranks a folder hit');
  assert.deepEqual(names(docsView(items,{query:'없는말',now:NOW}).rows),[]);
});

test('path pieces, a parent folder the label leaves out and a pasted full path all find the file; scattered letters in a path do not',()=>{
  const path='/work/Alpha/docs/sub/guide.md';
  const items=prepareDocs(group([{path,name:'guide.md',folder:'/work/Alpha/docs/sub',sourceRoot:'/work/Alpha/docs',mtime:NOW},
    file('/r/Reports/sub-guide-notes.md'),{path:'C:\\Users\\me\\Beta\\plan.md',name:'plan.md',folder:'C:\\Users\\me\\Beta',sourceRoot:'C:\\Users\\me',mtime:NOW}]));
  for(const query of ['sub/guide','Alpha','alpha docs',path,'docs/sub/guide.md'])
    assert.deepEqual(docsView(items,{query,now:NOW}).rows.map(row=>row.path).filter(p=>p===path),[path],query);
  assert.deepEqual(docsView(items,{query:'sub/guide',now:NOW}).rows.map(row=>row.path),[path],'a slash piece matches only real paths');
  assert.deepEqual(docsView(items,{query:'beta\\plan',now:NOW}).rows.map(row=>row.name),['plan.md'],'Windows separators match either way');
  assert.deepEqual(docsView(items,{query:'beta/plan',now:NOW}).rows.map(row=>row.name),['plan.md']);
  assert.deepEqual(docsView(items,{query:'wkapd',now:NOW}).rows,[],'scattered letters across the path are not a match');
  assert.deepEqual(docsView(items,{query:'guide',now:NOW}).rows.map(row=>row.name),['guide.md','sub-guide-notes.md'],'a name hit still ranks by the name');
});

test('NFC and NFD names and queries match each other, case-insensitively',()=>{
  for(const nameForm of ['NFC','NFD'])for(const queryForm of ['NFC','NFD']){
    const items=prepareDocs(group([file(`/r/Reports/${'프로젝트비-Report.md'.normalize(nameForm)}`),file('/r/Reports/other.md')]));
    const rows=docsView(items,{query:'프로젝트비 report'.normalize(queryForm),now:NOW}).rows;
    assert.equal(rows.length,1,`${nameForm} name, ${queryForm} query`);
  }
  assert.deepEqual(queryTokens('  A  b '),['a','b']);
});

test('sorting: newest first by default, by match while typing, explicit name and opened orders are kept',()=>{
  const items=prepareDocs(group([file('/r/Reports/b-plan.md',NOW-3*DAY),file('/r/Reports/a-old-plan.md',NOW-9*DAY),file('/r/Reports/plan.md',NOW-5*DAY),file('/r/Reports/c.md',NOW)]));
  assert.deepEqual(names(docsView(items,{now:NOW}).rows),['c.md','b-plan.md','plan.md','a-old-plan.md']);
  assert.deepEqual(names(docsView(items,{sort:'name',now:NOW}).rows),['a-old-plan.md','b-plan.md','c.md','plan.md']);
  assert.deepEqual(names(docsView(items,{query:'plan',now:NOW}).rows),['plan.md','b-plan.md','a-old-plan.md'],'typing ranks by match, ties newest first');
  assert.deepEqual(names(docsView(items,{query:'plan',sort:'name',now:NOW}).rows),['a-old-plan.md','b-plan.md','plan.md'],'an explicit sort keeps its order');
  const opened=new Map([['/r/Reports/a-old-plan.md',NOW-10],['/r/Reports/c.md',NOW-100]]);
  assert.deepEqual(names(docsView(items,{sort:'opened',opened,now:NOW}).rows),['a-old-plan.md','c.md','b-plan.md','plan.md'],'never-opened files follow, newest first');
  const recent=docsView(items,{tab:'opened',opened,now:NOW});
  assert.deepEqual(names(recent.rows),['a-old-plan.md','c.md'],'the 최근 연 tab lists only opened files, last opened first');
  assert.equal(recent.tabs.opened,2);assert.equal(recent.tabs.all,4);
  assert.deepEqual([nextSort('modified'),nextSort('name'),nextSort('opened')],['name','opened','modified']);
});

test('kind, period (KST days), archive and folder filters combine, and every chip counts with the other choices applied',()=>{
  const files=[
    file('/r/Reports/today.md',Date.UTC(2026,10,9,15,30)),           // 11/10 00:30 KST — today
    file('/r/Reports/yesterday.md',Date.UTC(2026,10,9,14,30)),       // 11/9 23:30 KST — not today
    file('/r/Reports/sub/week.pdf',NOW-6*DAY),
    file('/r/Reports/sub/month.html',NOW-20*DAY),
    file('/r/Reports/old.docx',NOW-90*DAY),
    file('/r/Reports/_보관/archived.md',NOW),
    file('/r/Reports/flagged.md',NOW,{archived:true}),
  ];
  const items=prepareDocs(group(files));
  const all=docsView(items,{now:NOW});
  assert.equal(all.rows.length,5,'archives are hidden by default');assert.equal(all.archivedHidden,2);
  assert.deepEqual(all.kinds,{all:5,md:2,html:1,pdf:1,other:1});
  assert.deepEqual(all.periods,{all:5,today:1,week:3,month:4});
  assert.deepEqual(names(docsView(items,{period:'today',now:NOW}).rows),['today.md'],'the day starts at KST midnight');
  assert.deepEqual(names(docsView(items,{kind:'md',period:'week',now:NOW}).rows),['today.md','yesterday.md']);
  const md=docsView(items,{kind:'md',now:NOW});
  assert.equal(md.kinds.pdf,1,'kind chips are counted without the kind choice');
  assert.equal(md.periods.week,2,'period chips are counted with the kind choice');
  assert.equal(docsView(items,{archive:true,now:NOW}).rows.length,7);
  const folders=all.folders;
  assert.deepEqual(folders.map(f=>[f.label,f.count]),[['Reports',3],['Reports/sub',2]]);
  assert.deepEqual(names(docsView(items,{folder:'/r/Reports/sub',now:NOW}).rows),['week.pdf','month.html']);
  assert.equal(docsView(items,{folder:'/r/Reports/sub',now:NOW}).folders.length,2,'the folders tab still lists every folder while one is chosen');
  assert.deepEqual(docsView(prepareDocs(group([])),{now:NOW}).rows,[]);
});

test('labels, kinds and archive detection',()=>{
  assert.equal(folderLabel({path:'/r/Reports/a/b/x.md',folder:'/r/Reports/a/b',sourceRoot:'/r/Reports'}),'Reports/a/b');
  assert.equal(folderLabel({path:'/x/y/z/x.md',folder:'/x/y/z'}),'y/z');
  assert.deepEqual(['a.MD','b.htm','c.pdf','d.docx','e'].map(docKind),['md','html','pdf','other','other']);
  assert.ok(docArchived({path:'/a/아카이브/x.md'.normalize('NFD')}));assert.ok(docArchived({path:'/a/guide.before-v1.md'}));assert.ok(!docArchived({path:'/a/b.md'}));
  assert.equal(kstDate(Date.UTC(2026,10,9,15,30),NOW),'11/10');assert.equal(kstDate(Date.UTC(2025,0,1),NOW),'2025/1/1');
  assert.equal(kstClock(NOW),'15:00');
  const dup=prepareDocs(group([file('/r/Reports/a.md'),file('/r/Reports/a.md'),{path:3}]));
  assert.equal(dup.length,1,'duplicate and malformed entries are dropped');
});

test('keyboard selection wraps and the opened record keeps the newest 200 valid entries',()=>{
  assert.equal(moveSelection(0,1,3),1);assert.equal(moveSelection(2,1,3),0);assert.equal(moveSelection(0,-1,3),2);
  assert.equal(moveSelection(-1,-1,3),2);assert.equal(moveSelection(0,1,0),-1);
  let opened=new Map();
  for(let i=0;i<OPENED_LIMIT+30;i++)opened=recordOpened(opened,`/d/${i}.md`,i);
  assert.equal(opened.size,OPENED_LIMIT);assert.equal([...opened.keys()][0],`/d/${OPENED_LIMIT+29}.md`);
  opened=recordOpened(opened,'/d/100.md',10000);assert.equal([...opened.keys()][0],'/d/100.md');assert.equal(opened.size,OPENED_LIMIT);
  const round=openedFromJson(JSON.parse(openedToJson(opened)));assert.deepEqual([...round],[...opened]);
  assert.equal(openedFromJson({version:2,opened:{'/a':1}}).size,0);
  assert.deepEqual([...openedFromJson({version:1,opened:{'/a':1,'/b':'x'}})],[['/a',1]]);
  assert.equal(openedFromJson(null).size,0);
});

test('thousands of documents: one keystroke over 5000 files filters and sorts well inside a 50ms input budget',()=>{
  const make=()=>group(Array.from({length:5000},(_,i)=>file(`/r/Reports/${['고객사','ops','herdr','자료/아카이브'][i%4]}/2026${String(1+i%12).padStart(2,'0')}${String(1+i%28).padStart(2,'0')}_${['주간보고','설계','회의록','검토결과','decision'][i%5]}_${i}.${['md','md','pdf','html'][i%4]}`,NOW-i*3600000)));
  // A keystroke's cost is the work, not what else the machine runs: each case is timed five times
  // and its fastest run is compared, so a parallel test run or a busy CPU cannot fail it.
  const fastest=(fn,runs=5)=>{let best=Infinity;for(let i=0;i<runs;i++){const at=performance.now();fn();best=Math.min(best,performance.now()-at);}return best;};
  const prepare=fastest(()=>prepareDocs(make()),3);
  const g=make(),items=prepareDocs(g);
  assert.equal(prepareDocs(g),items,'prepared once per index snapshot');
  const cases=['ㄱ','고','고객','고객사 ','고객사 주간','설계','dec','2026','ops/2026','자료/아카이브','/r/Reports/herdr/2026'].map(query=>({query}));
  cases.push({sort:'name',archive:true},{kind:'pdf',period:'month'},{tab:'opened',opened:new Map([[items[0].key,NOW]])});
  const times=cases.map(options=>[JSON.stringify(options),fastest(()=>docsView(items,{now:NOW,...options}))]);
  const worst=times.reduce((a,b)=>b[1]>a[1]?b:a);
  assert.ok(prepare<500,`prepare ${prepare.toFixed(1)}ms`);
  assert.ok(worst[1]<50,`slowest keystroke ${worst[0]} ${worst[1].toFixed(1)}ms`);
});

// ---- The popover against a recording UI runtime ----

let loads=0;
async function finder({files=[file('/r/Reports/guide.md',NOW),file('/r/Reports/report.pdf',NOW-DAY),file('/r/Reports/sub/notes.md',NOW-2*DAY)],opened=null}={}){
  const handlers=new Map(),calls=[],tasks=[],writes=[],labels=[],scrolls=[],inputs=[];let run=async()=>({code:0}),rendering=false,disk=opened;
  let list=null,popover=null;
  function element(kind='div'){
    let id;const node={kind,nodes:[],calls:[]};let proxy;
    proxy=new Proxy(node,{get(target,key){
      if(key==='then')return undefined;
      if(key in target)return target[key];
      if(key==='id')return value=>{id=value;target.id=value;return proxy;};
      if(key==='on_click')return callback=>{handlers.set(id,callback);return proxy;};
      if(key==='on_key_down')return callback=>{handlers.set(`key:${id}`,callback);return proxy;};
      if(key==='on_open_change')return callback=>{handlers.set(`open:${target.popoverId}`,callback);return proxy;};
      if(key==='on_item_click')return callback=>{target.itemClick=callback;return proxy;};
      if(key==='when')return (condition,callback)=>condition?callback(proxy):proxy;
      if(key==='child'||key==='content'||key==='trigger')return value=>{if(typeof value==='string')labels.push(value);else if(value)target.nodes.push(value);return proxy;};
      if(key==='children')return values=>{for(const value of values)if(value)target.nodes.push(value);return proxy;};
      return (...args)=>{target.calls.push([key,...args]);return proxy;};
    }});
    return proxy;
  }
  const runtime={
    div:()=>element(),svg:()=>element('svg'),h_flex:()=>element(),v_flex:()=>element(),
    Popover:{new:popoverId=>{popover=element('popover');popover.popoverId=popoverId;return popover;}},
    Input:{new:state=>{const el=element('input');el.state=state;return el;}},
    InputState:{new:options=>{assert.equal(rendering,false,'native input creation during render');const input={options,text:'',events:{},focused:0,value(){return this.text;},on(event,callback){this.events[event]=callback;},focus(){this.focused++;}};inputs.push(input);return input;}},
    VirtualListScrollHandle:{new:()=>{assert.equal(rendering,false,'scroll handle creation during render');return {scroll_to_item(index){scrolls.push(index);}};}},
    v_virtual_list:(id,count,size,getKey,render)=>{list=element('list');list.id=id;list.count=count;list.size=size;list.keys=Array.from({length:count},(_,i)=>getKey(i));list.render=render;return list;},
    appHome:()=>'/app',window:()=>({platform:'macos'}),
    exec:async(command,args)=>{calls.push({command,args});return run(command,args);},
    readTextFile:async path=>{assert.equal(path,'/app/data/sixfold/docs-opened.json');return disk;},
    writeTextFile:async(path,text,expected)=>{assert.equal(expected,disk,'compare-and-swap against what was read');writes.push({path,text});disk=text;return null;},
  };
  const key=`__docsFinder${loads++}`;globalThis[key]=runtime;
  let source=(await readFile(new URL('../mods/sixfold-desk/docs-finder.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  source=source.replace(/^import \{[^}]*\} from '(?:gpui-kit|gpui-base|herdr)';\n/gm,'');
  source=source.replace("'./docs-finder-model.js'",JSON.stringify(new URL('../mods/sixfold-desk/docs-finder-model.js',import.meta.url).href));
  source=`const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${source}`;
  const mod=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const view={projectDocs:{spaces:{Demo:group(files)}},docsIndexAt:NOW};
  let notified=0;
  const timers=[];
  const cx={notify(){notified++;},stop_propagation(){},spawn(fn){const p=Promise.resolve().then(()=>fn(cx));tasks.push(p);return p;},timer:{after(ms,fn){timers.push(fn);return {cancel(){}};}}};
  const space={id:'Demo',name:'Demo'};
  const t={border:'#1',popover:'#2',surface:'#3',foreground:'#4',muted:'#5',dim:'#6',selected:'#7',accent:'#8',blocked:'#9',hover:'#a'};
  const render=(s=space)=>{handlers.clear();labels.length=0;list=null;rendering=true;try{return mod.docsFinder(view,s,element('trigger'),t,{notify:()=>notified++});}finally{rendering=false;}};
  const flush=async()=>{for(let i=0;i<5;i++){await Promise.all(tasks);await new Promise(resolve=>setImmediate(resolve));}};
  return {mod,view,cx,space,handlers,calls,writes,labels,scrolls,inputs,timers,render,flush,list:()=>list,popover:()=>popover,
    setRun:fn=>{run=fn;},state:()=>view.docsFinders?.get('Demo'),notified:()=>notified,
    rowNames:()=>list?list.keys.map(path=>path.split('/').at(-1)):[]};
}
const press=(h,key)=>h.handlers.get('key:sf-docs-finder-body-Demo')({key,keystroke:key,modifiers:{}},h.cx);

test('closed: only the trigger is drawn and nothing native is created while rendering',async()=>{
  const h=await finder();h.render();
  assert.equal(h.inputs.length,0);assert.equal(h.view.docsFinders,undefined);
  assert.equal(h.list(),null);assert.ok(h.handlers.has('open:sf-docs-finder-Demo'));
  h.handlers.get('open:sf-docs-finder-Demo')(true,h.cx);
  assert.equal(h.state().open,true);assert.equal(h.inputs.length,1);
  h.timers.forEach(fn=>fn());assert.equal(h.inputs[0].focused,1,'opening puts the keyboard in the search box');
  h.render();assert.deepEqual(h.rowNames(),['guide.md','report.pdf','notes.md']);
  assert.ok(h.labels.some(label=>label.startsWith('문서 3건')));
});

test('typing filters at once, ↑/↓ move the highlight and scroll to it, Enter opens it in the 문서 tab and records it',async()=>{
  const h=await finder();h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);h.render();
  const input=h.inputs[0];input.text='md';input.events.change({},h.cx);h.render();
  assert.deepEqual(h.rowNames(),['guide.md','notes.md']);
  press(h,'down');h.render();assert.equal(h.state().selected,1);assert.equal(h.scrolls.at(-1),1);
  press(h,'down');h.render();assert.equal(h.state().selected,0,'wraps to the top');
  press(h,'up');h.render();assert.equal(h.state().selected,1,'wraps to the bottom');
  input.events.submit({},h.cx);await h.flush();
  assert.deepEqual(h.calls.at(-1),{command:'/app/scripts/sixfold/herdr-theme',args:['open_doc_tab','/r/Reports/sub/notes.md','--space','Demo']});
  assert.equal(h.state().open,false,'a successful open closes the finder');
  assert.equal(h.writes.length,1);assert.deepEqual(Object.keys(JSON.parse(h.writes[0].text).opened),['/r/Reports/sub/notes.md']);
  h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);await h.flush();h.render();
  h.handlers.get('sf-docs-tab-Demo-opened')({},h.cx);h.render();assert.deepEqual(h.rowNames(),['notes.md'],'최근 연 tab');
});

test('a click opens other files in the default app; a failure stays open with one error line and clears on retry',async()=>{
  const h=await finder();h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);h.render();
  h.setRun(async()=>({code:1}));
  h.list().itemClick('/r/Reports/report.pdf',h.cx);await h.flush();
  assert.deepEqual(h.calls.at(-1),{command:'/app/scripts/sixfold/herdr-theme',args:['desktop','open','/r/Reports/report.pdf']});
  assert.equal(h.state().open,true);assert.match(h.state().error,/기본 앱/);assert.equal(h.writes.length,0);
  h.render();assert.ok(h.labels.includes('기본 앱에서 열지 못했습니다.'));
  h.setRun(async()=>{throw Error('gone');});h.list().itemClick('/r/Reports/guide.md',h.cx);await h.flush();assert.match(h.state().error,/문서 탭/);
  h.setRun(async()=>({code:0}));h.render();h.list().itemClick('/r/Reports/guide.md',h.cx);await h.flush();
  assert.equal(h.state().error,null);assert.equal(h.state().open,false);
});

test('chips, folders tab, sort cycle, archive toggle, Escape and the empty states',async()=>{
  const files=[file('/r/Reports/guide.md',NOW),file('/r/Reports/report.pdf',NOW-DAY),file('/r/Reports/sub/notes.md',NOW-40*DAY),file('/r/Reports/_보관/old.md',NOW)];
  const h=await finder({files});h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);h.render();
  assert.deepEqual(h.rowNames(),['guide.md','report.pdf','notes.md']);
  h.handlers.get('sf-docs-kind-Demo-pdf')({},h.cx);h.render();assert.deepEqual(h.rowNames(),['report.pdf']);
  h.handlers.get('sf-docs-kind-Demo-all')({},h.cx);h.handlers.get('sf-docs-period-Demo-week')({},h.cx);h.render();assert.deepEqual(h.rowNames(),['guide.md','report.pdf']);
  h.handlers.get('sf-docs-period-Demo-all')({},h.cx);h.handlers.get('sf-docs-sort-Demo')({},h.cx);h.render();
  assert.equal(h.state().sort,'name');assert.deepEqual(h.rowNames(),['guide.md','notes.md','report.pdf']);
  h.handlers.get('sf-docs-archive-Demo')({},h.cx);h.render();assert.equal(h.rowNames().length,4);
  h.handlers.get('sf-docs-archive-Demo')({},h.cx);
  h.handlers.get('sf-docs-tab-Demo-folders')({},h.cx);h.render();assert.equal(h.list(),null,'the folders tab lists folders, not files');
  h.handlers.get('sf-docs-folder-Demo-1')({},h.cx);h.render();
  assert.equal(h.state().tab,'all');assert.equal(h.state().folder,'/r/Reports/sub');assert.deepEqual(h.rowNames(),['notes.md']);
  assert.ok(h.labels.some(label=>label.startsWith('폴더: Reports/sub')));
  h.handlers.get('sf-docs-folder-clear-Demo')({},h.cx);h.render();assert.equal(h.rowNames().length,3);
  h.inputs[0].text='없는문서';h.inputs[0].events.change({},h.cx);h.render();
  assert.equal(h.list(),null);assert.ok(h.labels.some(label=>label.startsWith('검색과 맞는 문서가 없습니다 · 아카이브 1건 제외됨')));
  h.inputs[0].events.submit({},h.cx);await h.flush();assert.equal(h.calls.length,0,'Enter on an empty list opens nothing');
  press(h,'escape');assert.equal(h.state().open,false);
});

test('a space without a document folder explains itself, and only one finder is open at a time',async()=>{
  const h=await finder();
  const bare={id:'Bare',name:'Bare'};
  h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);h.mod.setDocsFinderOpen(h.view,bare,true,h.cx);
  assert.equal(h.state().open,false);assert.equal(h.view.docsFinders.get('Bare').open,true);
  h.render(bare);assert.ok(h.labels.some(label=>label.startsWith('이 공간에 설정된 문서 폴더가 없습니다')));
  assert.ok(h.labels.includes('문서 폴더 없음'));
});

test('a saved opened record loads once and merges with opens made before it arrived; the reveal button uses Finder',async()=>{
  const saved=JSON.stringify({version:1,opened:{'/r/Reports/report.pdf':NOW-5}});
  const h=await finder({opened:saved});
  h.mod.setDocsFinderOpen(h.view,h.space,true,h.cx);await h.flush();
  assert.deepEqual([...h.view.docsOpened.keys()],['/r/Reports/report.pdf']);
  h.render();h.handlers.get('sf-docs-tab-Demo-opened')({},h.cx);h.render();assert.deepEqual(h.rowNames(),['report.pdf']);
  h.handlers.get('sf-docs-reveal-Demo')({},h.cx);await h.flush();
  assert.deepEqual(h.calls.at(-1),{command:'open',args:['-R','/r/Reports/report.pdf']});
});
