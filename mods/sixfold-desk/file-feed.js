// A data-only shared subscription hub. Native adapters own filesystem I/O,
// metadata/hash comparison and JSON parsing; no text is parsed in this module.
const REGISTRY='__sixfoldFileFeedHubsV1';
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const keyOf=value=>{
  if(typeof value!=='string'||!value)throw new TypeError('A file path is required');
  let key=value.replace(/\\/g,'/');
  // Windows watchers return extended canonical paths while appHome and callers
  // commonly use ordinary drive/UNC paths. Compare the same namespace on both
  // sides; neither the drive letter nor server/share name is special here.
  if(/^\/\/\?\/unc\//i.test(key))key='//'+key.slice(8);
  else if(/^\/\/\?\/[a-z]:\//i.test(key))key=key.slice(4);
  key=key.replace(/\/+$/,'')||'/';
  return /^[a-z]:(?:\/|$)/i.test(key)||key.startsWith('//')?key.toLowerCase():key;
};
export const filePathKey=keyOf;
function immutable(value,seen=new Set()){
  if(!value||typeof value!=='object'||seen.has(value))return value;
  seen.add(value);
  for(const key of Object.keys(value))immutable(value[key],seen);
  return Object.freeze(value);
}

export function createFileHub(adapter){
  if(typeof adapter?.readJson!=='function'||typeof adapter?.watch!=='function')throw new TypeError('readJson and watch adapters are required');
  const root=adapter.root,rootKey=keyOf(root),entries=new Map(),changes=new Set();
  let disposed=false,watchTask=null,retryTask=null,watchToken=0,waitingToken=null,context=null;
  const metrics={watchStarts:0,watchWaits:0,watchBatches:0,ignoredBatches:0,matchedFiles:0,nativeReads:0,readRequests:0,readCompletions:0,callbacks:0,fileCallbacks:0,changeCallbacks:0,rebinds:0,errors:0,lastBatchAt:null,lastPaths:[],lastError:null,lastErrorPhase:null};
  const now=()=>typeof adapter.now==='function'?adapter.now():Date.now();
  const errors=(error,phase,path)=>{
    metrics.errors++;metrics.lastError=String(error?.message??error).slice(0,300);metrics.lastErrorPhase=phase;
    try{adapter.onError?.(error,{phase,path});}catch{/* Error reporting must not stop other subscribers. */}
  };
  const taskDone=task=>{try{return !task||(typeof task.is_done==='function'&&task.is_done());}catch{return true;}};
  const cancel=task=>{try{task?.cancel?.();}catch{/* A retired source may already have released its task handle. */}};
  const retireReads=()=>{for(const entry of entries.values()){entry.epoch++;entry.reading=null;entry.dirty=false;}};
  const subscribed=()=>entries.size>0||changes.size>0;
  const consumers=()=>[...[...entries.values()].flatMap(value=>[...value.listeners]),...changes];
  const stop=()=>{
    watchToken++;
    waitingToken=null;
    cancel(watchTask);watchTask=null;
    cancel(retryTask);retryTask=null;
  };
  const cleanup=entry=>{
    if(entry.listeners.size)return;
    if(entries.get(entry.key)===entry)entries.delete(entry.key);
    if(!subscribed())stop();
  };
  const invoke=(listener,payload,failed)=>{
    try{
      metrics.callbacks++;
      if(listener.kind==='file')metrics.fileCallbacks++;else metrics.changeCallbacks++;
      const result=listener.callback(payload);
      if(result&&typeof result.then==='function')Promise.resolve(result).catch(failed);
    }catch(error){failed(error);}
  };
  const deliver=(entry,listener,snapshot)=>{
    if(disposed||!entry.listeners.has(listener))return;
    invoke(listener,snapshot,error=>{
      if(disposed||!entry.listeners.has(listener))return;
      entry.listeners.delete(listener);errors(error,'subscriber',entry.path);cleanup(entry);handoff(listener.cx);
    });
  };
  const publish=(entry,result)=>{
    const status=['ready','missing','invalid'].includes(result?.status)?result.status:'invalid';
    const hash=typeof result?.hash==='string'?result.hash:null;
    const changed=!entry.snapshot||entry.snapshot.status!==status||entry.snapshot.hash!==hash;
    if(!changed)return;
    if(status==='ready'&&own(result,'value'))entry.value=immutable(result.value);
    entry.snapshot=Object.freeze({status,hash,value:entry.value,changed:true});
    entry.hash=hash;
    for(const listener of [...entry.listeners])deliver(entry,listener,entry.snapshot);
  };
  const read=async(entry,again=false)=>{
    metrics.readRequests++;
    if(disposed||!entries.has(entry.key))return;
    if(entry.reading){if(again)entry.dirty=true;return entry.reading;}
    const epoch=entry.epoch;
    entry.reading=(async()=>{
      do{
        entry.dirty=false;
        try{
          metrics.nativeReads++;
          const result=await adapter.readJson(entry.path,{hash:entry.hash});
          metrics.readCompletions++;
          if(!disposed&&entry.epoch===epoch&&entries.get(entry.key)===entry)publish(entry,result);
        }catch(error){
          if(entry.epoch===epoch){
            errors(error,'read',entry.path);
            if(!disposed&&entries.get(entry.key)===entry)publish(entry,{status:'invalid',hash:entry.hash});
          }
        }
      }while(entry.dirty&&!disposed&&entry.epoch===epoch&&entries.get(entry.key)===entry);
    })().finally(()=>{if(entry.epoch===epoch)entry.reading=null;});
    return entry.reading;
  };
  const refresh=path=>{
    const key=path===undefined?null:keyOf(path);
    return Promise.all([...entries.values()].filter(entry=>key===null||entry.key===key).map(entry=>read(entry,true)));
  };
  const spawn=(body,cx)=>{
    if(adapter.start)return adapter.start(body,{owner:null},cx);
    if(cx?.spawn)return cx.spawn(body,{owner:null});
    let done=false;
    Promise.resolve().then(()=>body(cx)).catch(error=>errors(error,'watch',root)).finally(()=>{done=true;});
    return {cancel(){done=true;},is_done(){return done;}};
  };
  const retry=cx=>{
    if(disposed||!subscribed()||retryTask||!adapter.schedule)return;
    retryTask=adapter.schedule(2000,()=>{retryTask=null;ensureWatch(cx);},cx);
  };
  const ensureWatch=cx=>{
    if(disposed||!subscribed()||(!taskDone(watchTask)))return;
    const retired=Boolean(watchTask);
    if(retired){
      cancel(watchTask);
      // A cancelled source generation may leave its host promise pending for
      // ever. New work must not coalesce with that orphan or accept a late
      // answer from it over the fresh generation's result.
      retireReads();
    }
    context=cx??context;
    const token=++watchToken;
    // Install a marker before starting: injected/native spawn may run the body
    // synchronously until its first await.
    const marker={cancel(){},is_done(){return false;}};
    watchTask=marker;
    metrics.watchStarts++;
    try{
      const task=spawn(async()=>{
        while(!disposed&&subscribed()&&token===watchToken){
          let batch;
          try{metrics.watchWaits++;waitingToken=token;batch=await adapter.watch(root);}catch(error){
            if(token===watchToken){waitingToken=null;watchTask=null;errors(error,'watch',root);retry(context);}
            return;
          }
          if(waitingToken===token)waitingToken=null;
          metrics.watchBatches++;metrics.lastBatchAt=now();
          metrics.lastPaths=(Array.isArray(batch)?batch:[]).filter(path=>typeof path==='string').slice(0,16).map(path=>path.slice(0,500));
          if(disposed||token!==watchToken){metrics.ignoredBatches++;return;}
          const paths=new Map();
          for(const path of Array.isArray(batch)?batch:[]){if(typeof path==='string'&&path&&!paths.has(keyOf(path)))paths.set(keyOf(path),path);}
          const affected=[...entries.values()].filter(entry=>[...paths.keys()].some(path=>path===rootKey||path===entry.key||entry.key.startsWith(path+'/')));
          metrics.matchedFiles+=affected.length;
          // Re-arm the native wait immediately. Other mods may share the same
          // folder: waiting for I/O here could let another waiter drain a batch
          // while this hub is not listening.
          for(const entry of affected)read(entry,true);
          const matching=new Map();
          for(const listener of [...changes]){
            if(!changes.has(listener))continue;
            let batch=matching.get(listener.key);
            if(!batch){
              batch=Object.freeze([...paths].filter(([path])=>path===rootKey||path===listener.key||path.startsWith(listener.key+'/')||listener.key.startsWith(path+'/')).map(([,path])=>path));
              matching.set(listener.key,batch);
            }
            if(!batch.length)continue;
            invoke(listener,batch,error=>{
              if(disposed||!changes.has(listener))return;
              changes.delete(listener);errors(error,'subscriber',listener.prefix);if(!subscribed())stop();else handoff(listener.cx);
            });
          }
        }
      },context);
      if(watchTask===marker)watchTask=task||marker;
      if(retired)for(const entry of entries.values())read(entry);
    }catch(error){watchTask=null;errors(error,'watch',root);retry(context);}
  };
  const handoff=cx=>{
    // owner:null still belongs to its source generation. Both typed files and
    // change-only directory consumers can keep the shared watcher alive.
    if(subscribed()&&context===cx){
      const next=consumers().find(value=>value.cx!==cx);
      if(next){stop();retireReads();ensureWatch(next.cx);for(const entry of entries.values())read(entry);}
    }
  };
  return {
    get disposed(){return disposed;},
    diagnostics(){
      const files=[...entries.values()].map(entry=>Object.freeze({path:entry.path,hash:entry.hash,status:entry.snapshot?.status??null,subscriptions:entry.listeners.size,pending:Boolean(entry.reading),dirty:entry.dirty}));
      return Object.freeze({...metrics,lastPaths:Object.freeze([...metrics.lastPaths]),files:Object.freeze(files),disposed,
        root,fileSubscriptions:files.reduce((sum,file)=>sum+file.subscriptions,0),changeSubscriptions:changes.size,
        subscriptions:consumers().length,pending:files.filter(file=>file.pending).length,
        watchTaskPresent:Boolean(watchTask),watchTaskDone:taskDone(watchTask),watchWaiting:waitingToken===watchToken});
    },
    rebind(next){
      if(disposed)throw new Error('File hub is disposed');
      if(keyOf(next?.root)!==rootKey)throw new Error('A shared file hub cannot change its watch root');
      if(typeof next.readJson!=='function'||typeof next.watch!=='function')throw new TypeError('readJson and watch adapters are required');
      // Same public code version may come from a freshly loaded module copy.
      // Keep the shared cache/subscribers, but never retain its old native
      // host function bindings for subsequent work.
      adapter=next;
      metrics.rebinds++;
    },
    subscribe(path,callback,cx){
      if(disposed)throw new Error('File hub is disposed');
      if(typeof callback!=='function')throw new TypeError('A callback is required');
      const key=keyOf(path);
      let entry=entries.get(key);
      if(!entry){entry={key,path,listeners:new Set(),hash:null,value:null,snapshot:null,reading:null,dirty:false,epoch:0};entries.set(key,entry);}
      const listener={kind:'file',callback,cx};
      entry.listeners.add(listener);
      ensureWatch(cx);
      if(entry.snapshot){
        const snapshot=entry.snapshot;
        Promise.resolve().then(()=>deliver(entry,listener,snapshot));
      }else read(entry);
      let active=true;
      return ()=>{
        if(!active)return;active=false;entry.listeners.delete(listener);cleanup(entry);
        handoff(cx);
      };
    },
    subscribeChanges(prefix,callback,cx){
      if(disposed)throw new Error('File hub is disposed');
      if(typeof callback!=='function')throw new TypeError('A callback is required');
      const listener={kind:'changes',key:keyOf(prefix),prefix,callback,cx};
      changes.add(listener);ensureWatch(cx);
      let active=true;
      return ()=>{if(!active)return;active=false;changes.delete(listener);if(!subscribed())stop();else handoff(cx);};
    },
    refresh,
    dispose(){if(disposed)return;disposed=true;stop();for(const entry of entries.values())entry.listeners.clear();entries.clear();changes.clear();},
  };
}

// A module is re-evaluated for each source generation. An explicit global
// registry, rather than a module variable, shares one hub among panel copies.
export function getSharedFileHub(adapter,{appHome=adapter.appHome??adapter.root,generation=adapter.generation??'1'}={}){
  const key=keyOf(appHome);
  const root=keyOf(adapter.root);
  const registry=globalThis[REGISTRY]??(globalThis[REGISTRY]=new Map());
  let current=registry.get(key);
  if(current&&current.generation!==generation){
    for(const hub of new Set([...(current.hubs?.values()??[]),current.hub].filter(Boolean)))hub.dispose();
    current=null;
  }
  if(!current){current={generation,hubs:new Map(),hub:null};registry.set(key,current);}
  // Older copies registered only the default appHome hub. Preserve that
  // already running service while adding explicitly configured roots.
  if(!current.hubs)current.hubs=new Map(current.hub?[[key,current.hub]]:[]);
  const existing=current.hubs.get(root);
  if(existing&&!existing.disposed){existing.rebind(adapter);return existing;}
  const hub=createFileHub(adapter);
  current.hubs.set(root,hub);
  if(root===key)current.hub=hub;
  return hub;
}
