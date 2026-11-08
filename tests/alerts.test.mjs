import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const nativeParse=JSON.parse;
const changeServices=new WeakMap();let watcherId=0;
async function alertHarness(files,{lineEnding='\n',opens=[],home='/test'}={}){
  const tasks=[],timers=new Set(),callbacks=new Map(),shared=new Map(),writes=[];
  let notifications=0,typedHook=null;
  const service=changeServices.get(files)??new Set();changeServices.set(files,service);
  const cx={notify(){notifications++;},spawn(fn){const task=fn(cx);tasks.push(task);return task;},timer:{after(ms,callback){assert.equal(ms,20,'only finite batch coalescing is scheduled');const timer={callback,cancel(){timers.delete(timer);}};timers.add(timer);return timer;},every(){assert.fail('No periodic alert I/O');}}};
  const path=name=>`${home}/data/sixfold/${name}`;
  const snapshot=path=>{const raw=files.get(path.split('/').at(-1));if(raw===undefined)return {status:'missing',hash:null};const hash=createHash('sha256').update(raw).digest('hex');try{return {status:'ready',hash,value:nativeParse(raw)};}catch{return {status:'invalid',hash};}};
  const change=changed=>{for(const listener of service)if(listener.path===changed)listener.callback([changed]);};
  const runtime={appHome:()=>home,createHash,setShared:(key,value)=>shared.set(key,value),openOverlay:value=>opens.push(value),
    subscribeJsonFile:(_cx,name,callback)=>{callbacks.set(name,callback);return()=>callbacks.delete(name);},
    subscribeFileChanges:(_cx,name,callback)=>{const listener={path:name,callback};service.add(listener);return()=>service.delete(listener);},
    readJsonSnapshot:async name=>{const value=snapshot(name);typedHook?.(name,value);return value;},
    readTextFile:async name=>files.get(name.split('/').at(-1))??null,
    writeTextFile:async(name,value,expected)=>{const key=name.split('/').at(-1),old=files.get(key)??null;if(old!==expected)throw Error('compare-and-swap conflict');writes.push({name,value,expected});files.set(key,value);change(name);},
  };
  const key=`__alertWatch${watcherId++}`;globalThis[key]=runtime;
  let source=(await readFile(new URL('../mods/sixfold-desk/alerts.js',import.meta.url),'utf8')).replace(/\r?\n/g,lineEnding).replace(/^import .*;\r?\n/gm,'');
  source=`const {${Object.keys(runtime).join(',')}}=globalThis[${JSON.stringify(key)}];\n${source}`;
  source+='\nexport {dismiss as testDismiss};';
  const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  delete globalThis[key];const view={alerts:[]},stop=module.watchAlerts(view,cx);
  const flush=async()=>{for(let count=0;count<30;count++){const pending=[...timers];timers.clear();for(const timer of pending)timer.callback(cx);await Promise.all(tasks.splice(0));await Promise.resolve();if(!timers.size&&!tasks.length)return;}assert.fail('Alert batching did not settle');};
  const publish=(name=null)=>{for(const [file,callback] of callbacks)if(name===null||file===path(name))callback(snapshot(file));};
  return {view,cx,opens,writes,shared,stop,flush,publish,path,change,dismiss:module.testDismiss,setTypedHook:hook=>{typedHook=hook;},notifications:()=>notifications,refresh:async()=>{publish();await flush();}};
}

test('initial snapshot barrier seeds existing mentions silently and changed callbacks never parse files on UI',async()=>{
  const files=new Map([['slack-mentions.json','{"items":[{"id":"history"}]}']]);
  const h=await alertHarness(files);
  try{
    for(const name of ['alerts.json','project-alerts.json','slack-alerts-read.json','slack-live-health.json','slack-workflows.json'])h.publish(name);
    await h.flush();assert.equal(files.has('slack-popup-events.json'),false,'do not seed before historical mentions arrive');
    h.publish('slack-mentions.json');await h.flush();assert.equal(h.opens.length,0);
    assert.deepEqual(nativeParse(files.get('slack-popup-events.json')).seen,['mention:history']);
    files.set('alerts.json','{"items":[{"id":"changed","status":"needs-you"}]}');
    const parse=JSON.parse;JSON.parse=()=>{throw Error('UI parsed a file');};
    try{for(let count=0;count<30;count++)h.publish('alerts.json');await h.flush();}finally{JSON.parse=parse;}
    assert.equal(h.notifications(),2,'one initial update and one coalesced file update');
    assert.equal(h.view.alerts[0].id,'changed');
    h.stop();h.publish();await h.flush();assert.equal(h.notifications(),2);
  }finally{h.stop();}
});

test('hidden sidebar caches alert inputs without popup/ledger I/O and resuming applies them once',async()=>{
  const files=new Map(),h=await alertHarness(files);
  try{
    await h.refresh();const writes=h.writes.length,notifications=h.notifications();
    h.view.panelTrackingActive=true;h.view.sidebarVisible=false;
    files.set('slack-mentions.json','{"items":[{"id":"later"}]}');files.set('alerts.json','{"items":[{"id":"latest","status":"needs-you"}]}');
    await h.refresh();assert.equal(h.writes.length,writes);assert.equal(h.opens.length,0);assert.equal(h.notifications(),notifications);
    h.view.sidebarVisible=true;h.view.refreshAlerts(h.cx);await h.flush();
    assert.equal(h.opens.length,1);assert.equal(h.view.alerts[0].id,'latest');assert.equal(h.notifications(),notifications+1);
  }finally{h.stop();}
});

test('popup CAS refuses a typed/raw hash race and honors the competing ledger on change retry',async()=>{
  const files=new Map([['slack-mentions.json','{"items":[{"id":"old"}]}']]),h=await alertHarness(files);
  try{
    await h.refresh();const writes=h.writes.length;
    files.set('slack-mentions.json','{"items":[{"id":"old"},{"id":"new"}]}');
    h.setTypedHook((name,snapshot)=>{
      if(!name.endsWith('/slack-popup-events.json')||snapshot.status!=='ready')return;
      h.setTypedHook(null);files.set('slack-popup-events.json',JSON.stringify({schema:1,seen:['mention:old','mention:new']}));h.change(name);
    });
    await h.refresh();
    assert.equal(h.opens.length,0,'the other view already owns this new mention');
    assert.equal(h.writes.length,writes,'a mismatched decoded snapshot never authorizes a CAS write');
    assert.deepEqual(nativeParse(files.get('slack-popup-events.json')).seen,['mention:old','mention:new']);
  }finally{h.stop();}
});

test('two live views consume a genuinely new mention once through the shared ledger',async()=>{
  const files=new Map(),opens=[],first=await alertHarness(files,{opens}),second=await alertHarness(files,{opens});
  try{
    await Promise.all([first.refresh(),second.refresh()]);await Promise.all([first.flush(),second.flush()]);
    files.set('slack-mentions.json','{"items":[{"id":"one-new-mention"}]}');
    await Promise.all([first.refresh(),second.refresh()]);await Promise.all([first.flush(),second.flush()]);
    assert.equal(opens.length,1);
  }finally{first.stop();second.stop();}
});

test('dismissal ledger uses typed data and exact raw hash before its compare-and-swap',async()=>{
  const files=new Map([['alerts-dismissed.json','["earlier"]']]),h=await alertHarness(files);
  try{
    const parse=JSON.parse;JSON.parse=()=>{throw Error('UI parsed a ledger file');};
    try{await h.dismiss('current');}finally{JSON.parse=parse;}
    assert.deepEqual(nativeParse(files.get('alerts-dismissed.json')),['earlier','current']);
    assert.equal(h.writes[0].expected,'["earlier"]');
    h.setTypedHook((name,snapshot)=>{if(name.endsWith('/alerts-dismissed.json')&&snapshot.status==='ready'){h.setTypedHook(null);files.set('alerts-dismissed.json','["competing"]');}});
    await assert.rejects(h.dismiss('wrong-snapshot'),/changed while reading/);
    assert.deepEqual(nativeParse(files.get('alerts-dismissed.json')),['competing']);
    assert.equal(h.writes.length,1);
  }finally{h.stop();}
});

test('alerts recover after cold install and partial writes through typed subscriptions', async () => {
  const files=new Map(),h=await alertHarness(files,{home:'/fresh-install'});
  try{
    await h.refresh();assert.deepEqual(h.view.alerts,[]);assert.equal(h.notifications(),1);
    files.set('alerts.json',JSON.stringify({items:[{id:'late',status:'needs-you'}]}));await h.refresh();
    assert.equal(h.view.alerts[0].id,'late');assert.equal(h.notifications(),2);
    await h.refresh();assert.equal(h.notifications(),2);
    files.set('alerts.json','{partial');await h.refresh();assert.equal(h.view.alerts[0].id,'late');
    files.set('alerts.json',JSON.stringify({items:[]}));await h.refresh();assert.deepEqual(h.view.alerts,[]);assert.equal(h.notifications(),3);
  }finally{h.stop();}
});

for (const lineEnding of ['\n', '\r\n']) {
test(`workflow updates never auto-open; new mentions open once across health ticks, omissions and restart (${lineEnding === '\n' ? 'LF' : 'CRLF'})`,async()=>{
  const files=new Map([
    ['alerts.json','{"items":[]}'],['project-alerts.json','{"items":[],"projects":["Project B"]}'],
    ['slack-alerts-read.json','{}'],['slack-mentions.json','{"items":[{"id":"old"}]}'],
    ['slack-live-health.json','{"state":"ok","checked":1}'],
    ['slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v1","state":"needs_decision","summary":"Review ready","artifacts":["/report.md"],"finished_at":"first"},"legacy":{"id":"legacy","state":"ready","summary":"Old wording","sources":[{"id":"slack:C1:legacy"}],"artifacts":[],"finished_at":"first"}}}'],
  ]);
  const opens=[];
  const watchers=[];
  async function startWatcher(){
    const watcher=await alertHarness(files,{lineEnding,opens});watchers.push(watcher);await watcher.refresh();return watcher.refresh;
  }
  try{
    let refresh=await startWatcher();
    assert.equal(opens.length,0,'existing messages/results are seeded silently');
    const saved=JSON.parse(files.get('slack-popup-events.json'));
    assert.equal(saved.schema,1);assert.deepEqual(saved.seen,['mention:old']);

    files.set('slack-live-health.json','{"state":"ok","checked":2}');
    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v1","state":"needs_decision","summary":"Reworded review summary","artifacts":["/report.md"],"finished_at":"second"},"legacy":{"id":"legacy","state":"ready","summary":"Reworded legacy summary","sources":[{"id":"slack:C1:legacy"}],"artifacts":[],"finished_at":"second"}}}');
    await refresh();assert.equal(opens.length,0,'health ticks, workflow versions, summaries and finished_at do not auto-open');

    files.set('slack-mentions.json','{"items":[]}');await refresh();
    files.set('slack-mentions.json','{"items":[{"id":"old"}]}');await refresh();
    assert.equal(opens.length,0,'an old source returning after a transient omission stays suppressed');
    files.set('slack-mentions.json','{"items":[{"id":"old"},{"id":"new"}]}');await refresh();
    assert.equal(opens.length,1,'a genuinely new mention opens once');
    assert.equal(opens[0].props.review,false);
    await refresh();assert.equal(opens.length,1);

    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v2","state":"needs_decision","summary":"Updated source review","artifacts":["/report.md"],"finished_at":"third"}}}');
    await refresh();assert.equal(opens.length,1,'a changed workflow result remains available without auto-opening');
    files.set('slack-workflows.json','{"jobs":{"job":{"id":"job","version":"source-v2","state":"needs_decision","summary":"Updated source review","artifacts":["/report.md"],"finished_at":"fourth"}}}');
    await refresh();assert.equal(opens.length,1,'a second workflow timestamp change remains quiet');

    refresh=await startWatcher();
    assert.equal(opens.length,1,'a fresh watcher/restart honors the persistent mention ledger');
    assert.equal(opens[0].kind,'window');
  }finally{watchers.forEach(watcher=>watcher.stop());}
});

test(`an empty first run seeds the ledger before later new source arrives (${lineEnding === '\n' ? 'LF' : 'CRLF'})`,async()=>{
  const files=new Map([
    ['alerts.json','{"items":[]}'],['project-alerts.json','{"items":[]}'],['slack-alerts-read.json','{}'],
    ['slack-mentions.json','{"items":[]}'],['slack-live-health.json','{}'],['slack-workflows.json','{"jobs":{}}'],
  ]);
  const opens=[],watcher=await alertHarness(files,{lineEnding,opens});
  try{
    await watcher.refresh();
    assert.deepEqual(JSON.parse(files.get('slack-popup-events.json')),{schema:1,seen:[]});
    files.set('slack-mentions.json','{"items":[{"id":"later"}]}');await watcher.refresh();
    assert.equal(opens.length,1,'the first post-install source still opens');
  }finally{watcher.stop();}
});
}
