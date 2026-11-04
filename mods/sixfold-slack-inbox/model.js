// `names`: Slack user ID -> display name, from the machine-local site.local.json.
export function readable(text='',names={}) {
  return text.replace(/<@[^>|]+\|([^>]+)>/g,'@$1').replace(/<@([A-Z0-9]+)>/g,(tag,id)=>names?.[id]?`@${names[id]}`:tag)
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g,'$2').replace(/&amp;/g,'&').replace(/&gt;/g,'>').replace(/&lt;/g,'<');
}
export function threadKey(item) {
  const ts=item.thread_ts || item.link?.match(/[?&]thread_ts=([\d.]+)/)?.[1]
    || item.id?.split(':').at(-1) || item.link;
  return `${item.channel || item.project}:${ts}`;
}
export function threadGroups(items,read={}) {
  const threads=new Map();
  for(const item of items){
    const key=threadKey(item);
    if(!threads.has(key))threads.set(key,{key,project:item.project || '미연결',channel:item.channel_name || item.channel || '채널 미확인',items:[]});
    const group=threads.get(key);
    if(!group.items.some(i=>i.id===item.id))group.items.push(item);
  }
  for(const group of threads.values()){
    group.items.sort((a,b)=>String(b.at || b.id).localeCompare(String(a.at || a.id)));
    group.latest=group.items[0];
    group.unread=group.items.filter(i=>read[i.id]!==i.id).length;
    group.title=readable((group.latest.text || '').replace(/<@[^>]+>/g,'')).split('\n').map(s=>s.replace(/@[^\s]+/g,'').replace(/^[\s*`>,()]+|[\s*`,()]+$/g,'').trim()).find(Boolean) || '메시지 내용 확인';
  }
  return [...threads.values()].sort((a,b)=>Number(b.unread>0)-Number(a.unread>0) || String(b.latest.at).localeCompare(String(a.latest.at)));
}
