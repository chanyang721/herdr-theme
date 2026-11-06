// The host's live event log is in memory and has no filesystem notification.
// One sampler per key compares that typed snapshot; it never reads any file.
const REGISTRY='__sixfoldLiveEventSamplesV1';
function immutable(value,seen=new Set()){
  if(!value||typeof value!=='object'||seen.has(value))return value;
  seen.add(value);for(const key of Object.keys(value))immutable(value[key],seen);
  return Object.freeze(value);
}
const done=task=>{try{return !task||(typeof task.is_done==='function'&&task.is_done());}catch{return true;}};
const cancel=task=>{try{task?.cancel?.();}catch{/* A retired source may already have released the timer. */}};

export function subscribeLiveEvents({key,read,cx,onChange,intervalMs=500}){
  if(typeof key!=='string'||!key)throw new TypeError('A live-event key is required');
  if(typeof read!=='function'||typeof onChange!=='function')throw new TypeError('read and onChange callbacks are required');
  if(!Number.isFinite(intervalMs)||intervalMs<=0)throw new RangeError('A positive sampling interval is required');
  if(typeof cx?.timer?.every!=='function')throw new TypeError('An async timer context is required');
  const registry=globalThis[REGISTRY]??(globalThis[REGISTRY]=new Map());
  let service=registry.get(key);
  if(!service){
    const subscribers=new Set();
    let reader=read,owner=cx,period=intervalMs,timer=null,token=0,value=null,signature=null,disposed=false;
    const stop=()=>{token++;cancel(timer);timer=null;};
    const remove=listener=>{
      subscribers.delete(listener);
      if(!subscribers.size){disposed=true;stop();if(registry.get(key)===service)registry.delete(key);return;}
      reader=[...subscribers].at(-1).read;
      if(owner===listener.cx){
        const next=[...subscribers].find(item=>item.cx!==owner);
        if(next){stop();ensure(next.cx);}
      }
    };
    const deliver=(listener,snapshot,stamp)=>{
      if(disposed||!subscribers.has(listener)||listener.signature===stamp||signature!==stamp)return;
      listener.signature=stamp;
      try{
        const result=listener.onChange(snapshot);
        if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{if(subscribers.has(listener))remove(listener);});
      }catch{remove(listener);}
    };
    const sample=()=>{
      if(disposed||!subscribers.size)return;
      let next,stamp;
      try{next=reader();if(!Array.isArray(next))return;stamp=JSON.stringify(next);}catch{return;}
      if(stamp===signature)return;
      signature=stamp;value=immutable(next);
      for(const listener of [...subscribers])deliver(listener,value,signature);
    };
    const ensure=context=>{
      if(disposed||!subscribers.size||!done(timer))return;
      cancel(timer);owner=context;
      const version=++token;
      timer=context.timer.every(period,()=>{if(!disposed&&version===token)sample();},{owner:null});
    };
    service={
      subscribe(readerNext,context,callback,interval){
        reader=readerNext;
        if(period!==interval){period=interval;stop();}
        const listener={cx:context,read:readerNext,onChange:callback,signature:null};subscribers.add(listener);
        const retired=Boolean(timer&&done(timer));
        ensure(context);
        if(signature===null||retired)sample();
        if(value!==null){const snapshot=value,stamp=signature;Promise.resolve().then(()=>deliver(listener,snapshot,stamp));}
        let active=true;
        return ()=>{if(!active)return;active=false;remove(listener);};
      },
    };
    registry.set(key,service);
  }
  return service.subscribe(read,cx,onChange,intervalMs);
}
