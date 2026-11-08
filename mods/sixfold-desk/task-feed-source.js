// The task feed is one display stream. Its source key is local state, never a
// display label or a navigation identifier.
export const TASK_FEED_FILE='data/sixfold/task-feed.json';
export function createTaskFeedSource(deliver){
  let last=null;
  return (source,snapshot)=>{
    if(source!=='task'||!snapshot||snapshot===last)return;
    last=snapshot;deliver(snapshot,{source:'task',switched:false});
  };
}
