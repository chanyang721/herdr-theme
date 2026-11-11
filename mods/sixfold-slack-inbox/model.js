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
// Mirror lag and the Slack app's own unread badge (local app status, no message content).
// The mirror's newest message stops moving when the mirror stalls; say so instead of "0 new".
export function freshness(health={},now=Date.now(),staleHours=6) {
  const parts=[];
  const latest=Date.parse(health.mirror_latest_at || '');
  if(Number.isFinite(latest) && now-latest>staleHours*3600e3){
    const at=new Date(latest);
    parts.push(`미러 최신 메시지 ${at.getMonth()+1}/${at.getDate()} ${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')} 이후 없음 · 미러 지연 가능`);
  }
  const badge=String(health.app_badge ?? '').trim();
  if(badge && badge!=='0')parts.push(`Slack 앱 미확인 표시 ${badge==='•'?'있음':badge}`);
  return parts.join(' · ');
}
