// The host's live event log is in memory and has no filesystem notification.
// One sampler per key compares that typed snapshot; it never reads any file.
// The V2 subscription protocol includes acknowledgements and active handles;
// never join a V1 service left alive by an older source generation.
const REGISTRY='__sixfoldLiveEventSamplesV2';
function immutable(value,seen=new Set()){
  if(!value||typeof value!=='object'||seen.has(value))return value;
  seen.add(value);for(const key of Object.keys(value))immutable(value[key],seen);
  return Object.freeze(value);
}
const done=task=>{try{return !task||(typeof task.is_done==='function'&&task.is_done());}catch{return true;}};
const cancel=task=>{try{task?.cancel?.();}catch{/* A retired source may already have released the timer. */}};
// Fingerprint the bounded typed log's rendering metadata, including corrections
// to older entries. Message bodies and arbitrary nested objects are never read.
export function eventStamp(events){
  const scalar=value=>['string','number','boolean'].includes(typeof value)?value:null;
  return JSON.stringify(events.map(event=>['id','seq','at','source','target','started','animate','status','state'].map(key=>scalar(event?.[key]))));
}

const FAILURE_LIMIT=3,IN_FLIGHT_ROUNDS=3;
export function liveEventDiagnostics(){
  return [...(globalThis[REGISTRY]?.entries()??[])].map(([key,service])=>({key,...service.inspect()}));
}

export function subscribeLiveEvents({key,read,cx,onChange,onError,intervalMs=500}){
  if(typeof key!=='string'||!key)throw new TypeError('A live-event key is required');
  if(typeof read!=='function'||typeof onChange!=='function')throw new TypeError('read and onChange callbacks are required');
  if(!Number.isFinite(intervalMs)||intervalMs<=0)throw new RangeError('A positive sampling interval is required');
  if(typeof cx?.timer?.every!=='function')throw new TypeError('An async timer context is required');
  const registry=globalThis[REGISTRY]??(globalThis[REGISTRY]=new Map());
  let service=registry.get(key);
  if(!service){
    const subscribers=new Set();
    let reader=read,owner=cx,period=intervalMs,timer=null,token=0,value=null,signature=null,disposed=false,round=0;
    const metrics={samples:0,changes:0,readFailures:0,deliveryFailures:0,retries:0,retiredListeners:0,lastErrorKind:null};
    const stop=()=>{token++;cancel(timer);timer=null;};
    const remove=listener=>{
      subscribers.delete(listener);
      listener.attemptToken++;listener.inFlight=false;
      if(!subscribers.size){disposed=true;stop();if(registry.get(key)===service)registry.delete(key);return;}
      reader=[...subscribers].at(-1).read;
      if(owner===listener.cx){
        const next=[...subscribers].find(item=>item.cx!==owner);
        if(next){stop();ensure(next.cx);}
      }
    };
    const failed=(listener,attempt,kind)=>{
      if(disposed||!subscribers.has(listener)||listener.attemptToken!==attempt)return;
      listener.attemptToken++;listener.inFlight=false;listener.failures++;listener.totalFailures++;
      listener.lastErrorKind=kind;metrics.deliveryFailures++;metrics.lastErrorKind=kind;
      const retrying=listener.failures<FAILURE_LIMIT;
      if(!retrying){metrics.retiredListeners++;remove(listener);}
      // No native handles, event payloads, exception text or message IDs leave this boundary.
      try{listener.onError?.({kind,failures:listener.failures,retrying});}catch{/* Diagnostics cannot stop another consumer. */}
    };
    const deliver=(listener,snapshot,stamp)=>{
      if(disposed||!subscribers.has(listener)||listener.inFlight||listener.signature===stamp||signature!==stamp)return;
      const attempt=++listener.attemptToken;
      listener.inFlight=true;listener.startedRound=round;listener.attempts++;
      if(listener.failures)metrics.retries++;
      const success=()=>{
        if(disposed||!subscribers.has(listener)||listener.attemptToken!==attempt)return;
        listener.inFlight=false;listener.failures=0;listener.signature=stamp;
      };
      try{
        const result=listener.onChange(snapshot);
        if(result&&typeof result.then==='function')Promise.resolve(result).then(success,()=>failed(listener,attempt,'delivery_failed'));
        else success();
      }catch{failed(listener,attempt,'delivery_failed');}
    };
    const sample=()=>{
      if(disposed||!subscribers.size)return;
      round++;metrics.samples++;
      try{
        const next=reader();
        if(Array.isArray(next)){
          const stamp=eventStamp(next);
          if(stamp!==signature){signature=stamp;value=immutable(next);metrics.changes++;}
        }else metrics.readFailures++;
      }catch{metrics.readFailures++;}
      for(const listener of [...subscribers]){
        if(listener.inFlight&&round-listener.startedRound>=IN_FLIGHT_ROUNDS)failed(listener,listener.attemptToken,'delivery_timeout');
        // An unchanged source can still have an undelivered snapshot. Retries use
        // this existing sampler, never a new timer or a synchronous retry loop.
        if(value!==null)deliver(listener,value,signature);
      }
    };
    const ensure=context=>{
      if(disposed||!subscribers.size||!done(timer))return;
      cancel(timer);owner=context;
      const version=++token;
      timer=context.timer.every(period,()=>{if(!disposed&&version===token)sample();},{owner:null});
    };
    service={
      protocol:2,
      dispose(){
        if(disposed)return;
        disposed=true;stop();
        for(const listener of subscribers){listener.attemptToken++;listener.inFlight=false;}
        subscribers.clear();
        if(registry.get(key)===service)registry.delete(key);
      },
      inspect(){return {...metrics,subscribers:subscribers.size,sampling:!disposed&&!done(timer)};},
      subscribe(readerNext,context,callback,error,interval){
        reader=readerNext;
        if(period!==interval){period=interval;stop();}
        const listener={cx:context,read:readerNext,onChange:callback,onError:error,signature:null,inFlight:false,startedRound:0,
          attempts:0,attemptToken:0,failures:0,totalFailures:0,lastErrorKind:null};subscribers.add(listener);
        const retired=Boolean(timer&&done(timer));
        ensure(context);
        if(signature===null||retired)sample();
        if(value!==null&&listener.attempts===0){const snapshot=value,stamp=signature;Promise.resolve().then(()=>deliver(listener,snapshot,stamp));}
        const stop=()=>{if(subscribers.has(listener))remove(listener);};
        stop.is_active=()=>!disposed&&subscribers.has(listener)&&!done(timer);
        stop.diagnostics=()=>({active:stop.is_active(),attempts:listener.attempts,failures:listener.failures,
          totalFailures:listener.totalFailures,inFlight:listener.inFlight,lastErrorKind:listener.lastErrorKind});
        return stop;
      },
    };
    registry.set(key,service);
  }
  return service.subscribe(read,cx,onChange,onError,intervalMs);
}
