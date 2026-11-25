import * as native from 'herdr';
import {createHash} from 'crypto';
import {Buffer} from 'buffer';
import {getSharedFileHub,filePathKey} from './file-feed.js';

const previousText=globalThis.__sixfoldJsonCompatibility??=new Map();
const metrics=globalThis.__sixfoldJsonMetrics??={nativeReads:0,compatibilityReads:0,errors:0};
const deliveries=globalThis.__sixfoldFileDeliveries??=new WeakMap();
const externalRoots=globalThis.__sixfoldExternalFileRoots??=new Map();
export const FILE_CHANGED_COMMAND='file-feed-changed';

// AsyncContext methods resolve ambient native application ownership. A saved
// context or a plain JS promise cannot switch to a different mod copy. The
// existing native command channel resumes each shown receiver in its own scope.
export function fileDelivery(cx){
  let state=deliveries.get(cx);
  if(!state){state={queue:[],wake:null,signaled:false};deliveries.set(cx,state);}
  else if(typeof state.signaled!=='boolean')state.signaled=Boolean(state.queue.length||state.wake);
  state.acks??=[];
  const finish=(waiter,error)=>{waiter.active=false;error?waiter.reject(new Error(error)):waiter.resolve();};
  const rejectWake=()=>{for(const waiter of state.acks.splice(0))finish(waiter,'file_delivery_wake_failed');};
  const removeQueued=callback=>{
    const pending=state.queue.findIndex(([deliver])=>deliver===callback);
    if(pending>=0)state.queue.splice(pending,1);
    if(!state.queue.length){
      try{state.wake?.cancel?.();}catch{/* A retired generation may have released it. */}
      state.wake=null;state.signaled=false;
    }
  };
  return {
    diagnostics(){return {queued:state.queue.length,acknowledgements:state.acks.length,signaled:state.signaled,wakeScheduled:Boolean(state.wake)};},
    enqueue(callback,value,{awaitDelivery=false}={}){
      const pending=state.queue.findIndex(([deliver])=>deliver===callback);
      if(pending<0)state.queue.push([callback,value]);else state.queue[pending][1]=value;
      // A hidden receiver may not consume a native command until it resumes.
      // Keep one signal outstanding and only the latest value per subscriber.
      if(!state.signaled){
        state.signaled=true;
        try{
          state.wake=cx.timer.after(0,()=>{
            state.wake=null;
            try{native.run(`sixfold-desk.${FILE_CHANGED_COMMAND}`);}
            catch{state.signaled=false;metrics.errors++;metrics.lastErrorKind='delivery_command_failed';rejectWake();}
          },{owner:null});
        }catch(error){
          // Keep the latest queued value, but allow the subscriber's next bounded
          // delivery attempt to schedule a wake rather than remaining signaled forever.
          state.wake=null;state.signaled=false;metrics.errors++;metrics.lastErrorKind='delivery_schedule_failed';rejectWake();
          throw error;
        }
      }
      // Only callers needing delivery acknowledgement opt in. Their existing
      // sampler owns retries; the file receiver creates no retry timer itself.
      if(awaitDelivery){
        const waiter={callback,active:true};
        const promise=new Promise((resolve,reject)=>{waiter.resolve=resolve;waiter.reject=reject;state.acks.push(waiter);});
        promise.is_pending=()=>waiter.active&&state.acks.includes(waiter);
        promise.cancel=()=>{
          if(!promise.is_pending())return;
          state.acks=state.acks.filter(item=>item!==waiter);finish(waiter,'file_delivery_cancelled');
          if(!state.acks.some(item=>item.callback===callback))removeQueued(callback);
        };
        return promise;
      }
    },
    remove(callback){
      removeQueued(callback);
      for(const waiter of state.acks.filter(item=>item.callback===callback))finish(waiter,'file_delivery_cancelled');
      state.acks=state.acks.filter(item=>item.callback!==callback);
      if(!state.queue.length){
        try{state.wake?.cancel?.();}catch{/* The source generation may already be gone. */}
        state.wake=null;state.signaled=false;
      }
    },
    flush(){
      try{state.wake?.cancel?.();}catch{/* An already retired generation may have released its timer. */}
      state.wake=null;
      const queued=state.queue.splice(0);
      const acknowledgements=state.acks.splice(0);
      state.signaled=false;
      for(const [callback,value] of queued){
        const waiters=acknowledgements.filter(item=>item.callback===callback);
        try{callback(value);for(const waiter of waiters)finish(waiter);}
        catch(error){metrics.errors++;metrics.lastError=String(error?.stack||error);for(const waiter of waiters)finish(waiter,'file_delivery_callback_failed');}
      }
    },
  };
}

export function typedFileReadsAvailable(){return typeof native.readJsonFile==='function';}

async function readJson(path,{hash}={}){
  if(typedFileReadsAvailable()){
    metrics.nativeReads++;
    const result=await native.readJsonFile(path,{hash,maxBytes:2*1024*1024});
    const status=typeof result?.status==='string'?result.status:'unknown';
    const statuses=metrics.nativeStatuses??={};statuses[status]=(statuses[status]??0)+1;
    if(status==='read_error'&&result.errorKind==='not_found')return {status:'missing',hash:null,changed:true,nativeStatus:status};
    if(status!=='ok'||typeof result.hash!=='string'||!result.hash)return {status:'invalid',hash:null,changed:true,nativeStatus:status};
    // A native hash hit omits its typed payload as null. Do not replace the
    // shared cache with that sentinel; a changed JSON null is still real data.
    const unchanged=result.changed===false&&result.value===null;
    return {status:'ready',hash:result.hash,changed:result.changed===true,nativeStatus:status,...(!unchanged?{value:result.value}:{})};
  }
  // Compatibility with an older host. This path is deliberately reported by
  // diagnostics: its parsing is NOT a background native JSON read. New hosts
  // use the API above and never enter JSON.parse on the UI thread here.
  metrics.compatibilityReads++;
  const raw=await native.readTextFile(path);
  if(raw===null)return {status:'missing',hash:null,changed:hash!==null};
  // Old readTextFile cannot bound disk I/O. Bound UTF-8 bytes before hashing
  // or UI-thread JSON parsing; Buffer.from is supported by the older SDK.
  // The UTF-16 length check avoids allocating an encoding for huge ASCII files.
  const maxBytes=2*1024*1024;
  if(raw.length>maxBytes||Buffer.from(raw,'utf8').length>maxBytes)
    return {status:'invalid',hash:null,changed:true};
  const digest=createHash('sha256').update(raw).digest('hex');
  const previous=previousText.get(path);
  if(previous?.raw===raw)return {status:previous.status,hash:digest,changed:digest!==hash,
    ...(digest!==hash&&previous.status==='ready'?{value:previous.value}:{})};
  try{
    const value=JSON.parse(raw);previousText.set(path,{raw,status:'ready',value});
    return {status:'ready',hash:digest,changed:digest!==hash,value};
  }catch{
    previousText.set(path,{raw,status:'invalid'});
    return {status:'invalid',hash:digest,changed:digest!==hash};
  }
}

function under(path,root){return path===root||path.startsWith(root+'/');}
function externalRoot(prefix){
  const key=filePathKey(prefix);
  const pieces=key.split('/').filter(Boolean);
  if(!(/^[a-z]:\//i.test(key)||key.startsWith('/'))||key==='/'||/^[a-z]:\/?$/i.test(key)
    ||(key.startsWith('//')&&pieces.length<=2)||pieces.some(piece=>piece==='.'||piece==='..')||/[\u0000-\u001f\u007f]/.test(key))throw new RangeError('A specific absolute external directory is required');
  return key;
}
function rootFor(path,directory=false){
  const home=native.appHome(),key=filePathKey(path),homeKey=filePathKey(home);
  if(under(key,homeKey))return home;
  const roots=externalRoots.get(homeKey)??new Map();
  if(directory){const root=externalRoot(path);roots.set(root,path);externalRoots.set(homeKey,roots);return path;}
  const match=[...roots].filter(([root])=>under(key,root)).sort((a,b)=>b[0].length-a[0].length)[0];
  if(match)return match[1];
  throw new RangeError('External JSON subscriptions require an explicit directory subscription');
}
// App-home folders whose paths never reach subscribers: settings `sixfold.watchIgnore`, a list of
// folders relative to the app home, for local tools that rewrite their state many times a minute.
// The watch itself stays on the app home because shared.json and settings.json live at its root
// and a folder watch is always recursive.
export function ignoredFolders(){
  const list=native.settings?.()?.['sixfold.watchIgnore'];
  return Array.isArray(list)?list.filter(folder=>typeof folder==='string'&&folder&&!folder.includes('..')):[];
}
// The shared hub outlives a theme reload (it stays in globalThis and only its
// adapter is replaced), so a fix to how reads are trusted must live here, in
// the adapter this module hands it, not only in the hub's own code.
// "Unchanged" (no value) holds only for the hash asked about; any other hash
// would tag the hub's old value with the new hash, so read the value instead.
export async function checkedRead(path,options={}){
  const asked=options?.hash??null;
  let result=await readJson(path,options);
  if(result?.status==='ready'&&!Object.hasOwn(result,'value')&&(result.hash??null)!==asked){
    metrics.unchangedMismatches=(metrics.unchangedMismatches??0)+1;
    result=await readJson(path,{...options,hash:null});
    if(result?.status==='ready'&&!Object.hasOwn(result,'value'))result={status:'invalid',hash:null,changed:true};
  }
  return result;
}
// The hub's code generation. A hub kept in globalThis by an older theme copy is replaced (disposed),
// not rebound, when this changes: v3 releases the native watch on stop, which a v2 hub never did.
export const FILE_HUB_GENERATION='panel-files-v3';
function hubFor(root=native.appHome()){
  externalRoot(root); // Never turn a malformed configuration into a volume watch.
  const home=native.appHome();
  return getSharedFileHub({
    root,appHome:home,readJson:checkedRead,watch:folder=>native.watchFolder(folder),
    ignore:root===home?ignoredFolders().map(folder=>`${home}/${folder}`):[],
    start:(body,options,owner)=>owner.spawn(body,options),
    schedule:(ms,fn,owner)=>owner.timer.after(ms,fn,{owner:null}),
    onError:()=>{metrics.errors++;},
  },{appHome:home,generation:FILE_HUB_GENERATION});
}

export const readJsonSnapshot=readJson;
function ownedSubscription(cx,subscribe,callback,prefix=null){
  const receiver=fileDelivery(cx);let live=true;
  const paths=new Map();let invalidated=false;
  const prefixKey=prefix===null?null:filePathKey(prefix);
  const deliver=value=>{
    if(!live)return;
    if(prefix===null){callback(value);return;}
    const batch=invalidated?[prefix]:[...paths.values()];paths.clear();invalidated=false;
    callback(batch);
  };
  const release=subscribe(value=>{
    if(prefix===null){receiver.enqueue(deliver,value);return;}
    if(!invalidated)for(const path of Array.isArray(value)?value:[]){
      if(typeof path!=='string'||!path)continue;
      const key=filePathKey(path);
      if(key===prefixKey||prefixKey.startsWith(key+'/')){invalidated=true;paths.clear();break;}
      paths.set(key,path);
      if(paths.size>512){invalidated=true;paths.clear();break;}
    }
    receiver.enqueue(deliver,null);
  });
  return ()=>{live=false;paths.clear();receiver.remove(deliver);release();};
}
export function subscribeJsonFile(cx,path,callback){const root=rootFor(path);return ownedSubscription(cx,send=>hubFor(root).subscribe(path,send,cx),callback);}
export function subscribeFileChanges(cx,prefix,callback){const root=rootFor(prefix,true);return ownedSubscription(cx,send=>hubFor(root).subscribeChanges(prefix,send,cx),callback,prefix);}

export function panelIoDiagnostics(){return {...metrics,backgroundJson:typedFileReadsAvailable(),
  liveEvents:[...(globalThis.__sixfoldLiveEventSamplesV2?.values()??[])].map(service=>service.inspect())};}
