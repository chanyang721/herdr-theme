import * as native from 'herdr';
import {createHash} from 'crypto';
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
  if(!state){state={queue:[],wake:null};deliveries.set(cx,state);}
  return {
    enqueue(callback,value){
      state.queue.push([callback,value]);
      if(!state.wake)state.wake=cx.timer.after(0,()=>{state.wake=null;native.run(`sixfold-desk.${FILE_CHANGED_COMMAND}`);},{owner:null});
    },
    flush(){
      const queued=state.queue.splice(0);
      for(const [callback,value] of queued)try{callback(value);}catch(error){metrics.errors++;metrics.lastError=String(error?.stack||error);}
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
function hubFor(root=native.appHome()){
  externalRoot(root); // Never turn a malformed configuration into a volume watch.
  const home=native.appHome();
  return getSharedFileHub({
    root,appHome:home,readJson,watch:folder=>native.watchFolder(folder),
    start:(body,options,owner)=>owner.spawn(body,options),
    schedule:(ms,fn,owner)=>owner.timer.after(ms,fn,{owner:null}),
    onError:()=>{metrics.errors++;},
  },{appHome:home,generation:'panel-files-v2'});
}

export const readJsonSnapshot=readJson;
function ownedSubscription(cx,subscribe,callback){
  const receiver=fileDelivery(cx);let live=true;
  const release=subscribe(value=>receiver.enqueue(value=>{if(live)callback(value);},value));
  return ()=>{live=false;release();};
}
export function subscribeJsonFile(cx,path,callback){const root=rootFor(path);return ownedSubscription(cx,send=>hubFor(root).subscribe(path,send,cx),callback);}
export function subscribeFileChanges(cx,prefix,callback){const root=rootFor(prefix,true);return ownedSubscription(cx,send=>hubFor(root).subscribeChanges(prefix,send,cx),callback);}

export function panelIoDiagnostics(){return {...metrics,backgroundJson:typedFileReadsAvailable()};}
