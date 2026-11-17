// One background job on a host timer: skipped while its output is not shown,
// never overlapped, run only when due (or after a fallback interval), and backed
// off after failures. Change detection before notify is the job's: see changeGate.
//   every     tick in ms (cheap checks only; the job itself runs when due)
//   job       (cx) => value | Promise; a throw or `false` counts as a failure
//   visible   () => boolean; a hidden tick is skipped and the job runs on return
//   due       () => boolean; true runs on this tick (default: every tick)
//   fallback  ms; runs at least this often while visible even when not due
//   fallbackWhen () => boolean; the fallback counts only while true (a job that runs hidden when
//             due can still keep its catch-up run for when the window is shown)
//   backoff   {base, max} ms after consecutive failures
//   spawn     run the job in cx.spawn (default); a refused spawn is not a run
export function createPoll(cx,{every,job,visible=()=>true,due=()=>true,fallback=null,fallbackWhen=()=>true,backoff=null,spawn=true,now=()=>Date.now()}){
  if(!Number.isFinite(every)||every<=0)throw new RangeError('A positive poll interval is required');
  if(typeof job!=='function')throw new TypeError('A poll job is required');
  let busy=false,stopped=false,last=-Infinity,failures=0,retryAt=0,forced=false,missed=false;
  const settle=ok=>{
    busy=false;
    if(ok===false&&backoff){failures++;retryAt=now()+Math.min(backoff.max??backoff.base,backoff.base*2**(failures-1));}
    else if(ok!==false){failures=0;retryAt=0;}
  };
  const tick=context=>{
    if(stopped||busy)return;
    if(!visible()){missed=true;return;}
    const at=now();
    if(at<retryAt)return;
    if(!(forced||missed||due()||(fallback!==null&&at-last>=fallback&&fallbackWhen())))return;
    const lastRun=last,wasForced=forced,wasMissed=missed;
    forced=false;missed=false;busy=true;last=at;
    const run=async c=>{let ok=true;try{ok=(await job(c))!==false;}catch{ok=false;}finally{settle(ok);}};
    if(!spawn){run(context??cx);return;}
    try{(context??cx).spawn(run);}
    catch{busy=false;last=lastRun;forced=wasForced;missed=wasMissed;}
  };
  const timer=cx.timer.every(every,tick);
  return {
    tick,
    // Run on the next possible tick (now when allowed), whatever `due` says.
    kick(context){forced=true;tick(context);},
    get busy(){return busy;},
    stop(){if(stopped)return;stopped=true;try{timer?.cancel?.();}catch{/* A retired generation may own the timer. */}},
  };
}

// True only when the key differs from the last one seen.
export function changeGate(initial=undefined){
  let previous=initial;
  const changed=key=>{if(key===previous)return false;previous=key;return true;};
  changed.reset=()=>{previous=initial;};
  return changed;
}

// The host window and this copy's sidebar are both shown.
export function hostVisible(window){
  try{return typeof window!=='function'||window()?.visible!==false;}catch{return true;}
}
