// Every setShared rewrites the whole shared.json and re-renders every mod, so a
// key is written only when its value changed. `token` (e.g. the source file's
// hash) skips even the serialisation when the input did not change. A new
// watcher (reload, another copy) starts empty and writes each key once.
import {createHash} from 'crypto';

export function createSharedPublisher(setShared){
  const last=new Map();
  return (key,value,token=null)=>{
    const seen=last.get(key);
    if(token!==null&&seen?.token===token)return false;
    const text=JSON.stringify(value??null);
    const digest=`${text.length}:${createHash('sha256').update(text).digest('hex')}`;
    if(seen?.digest===digest){last.set(key,{digest,token});return false;}
    setShared(key,value);
    last.set(key,{digest,token});
    return true;
  };
}

// Only the health fields a reader draws (alert-inbox slackCopyDelay, the Slack
// inbox collect/freshness lines). Timings, costs and coverage change on every
// collection and are not shown, so they no longer rewrite shared.json.
const SLACK_HEALTH=['source','state','error_kind','checkpoint_reason','last_trigger','last_trigger_at','last_success',
  'catchup_minutes','slack_freshness','mirror_latest_at','mirror_stale_hours','app_badge'];
// No reader draws Linear health today; keep the state a future reader needs.
const LINEAR_HEALTH=['source','state','last_success','errors','unread','count'];
const pick=(value,keys)=>{
  const out={};
  if(value&&typeof value==='object')for(const key of keys)if(Object.hasOwn(value,key))out[key]=value[key];
  return out;
};
export const slackHealthView=health=>pick(health,SLACK_HEALTH);
export const linearHealthView=health=>pick(health,LINEAR_HEALTH);
