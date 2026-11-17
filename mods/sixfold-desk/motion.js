// The one motion policy for sixfold-desk. GPUI redraws and lays out the whole
// window every frame while any loop, spin, frames, transition or animated image
// is drawn, so motion is opt-in and nothing animates forever: an effect plays
// for BRIEF_MS after a state change, then the view renders still.
// No imports: callers pass `shared`, so tests load this module as is.
export const MOTION_KEY='sixfold.motion';
export const BRIEF_MS=8000;
const SETTLE_MS=1000;
const KEEP=256;

// Decorative motion: on only when switched on; an unset value is off.
export const motionEnabled=read=>read(MOTION_KEY)===true;
// Alert arrivals carry information and are already short, so they play unless
// motion was switched off explicitly.
export const arrivalMotionEnabled=read=>read(MOTION_KEY)!==false;
// The value the Motion button writes, and its label.
export const motionToggled=read=>!motionEnabled(read);
export const motionLabel=on=>on?'Motion on':'Motion off';

// Per-key change tracker. active(key, state) is true for `ms` after `state`
// changed for `key`. Keys first seen while the view settles start still, so a
// reload animates nothing; a key that appears later counts as a change.
export function briefWindow({ms=BRIEF_MS,settleMs=SETTLE_MS,clock=Date.now}={}){
  const born=clock(),seen=new Map();
  return {
    active(key,state,now=clock()){
      let entry=seen.get(key);
      if(!entry){
        if(seen.size>=KEEP)for(const [k,v] of seen)if(v.until<=now)seen.delete(k);
        entry={state,until:now-born<settleMs?0:now+ms};seen.set(key,entry);
      }else if(entry.state!==state){entry.state=state;entry.until=now+ms;}
      return now<entry.until;
    },
    // The earliest end still ahead, for one wake that redraws the still frame.
    nextAt(now=clock()){
      let at=null;
      for(const {until} of seen.values())if(until>now&&(at===null||until<at))at=until;
      return at;
    },
  };
}

// One timer per holder: redraw when the earliest brief effect ends.
export function wakeAtBriefEnd(holder,at,cx){
  if(holder.briefWakeAt===at)return;
  holder.briefWake?.cancel?.();holder.briefWake=null;holder.briefWakeAt=at;
  if(at===null||typeof cx?.timer?.after!=='function')return;
  holder.briefWake=cx.timer.after(Math.max(1,at-Date.now()),cx=>{holder.briefWake=null;holder.briefWakeAt=null;cx.notify();});
}
