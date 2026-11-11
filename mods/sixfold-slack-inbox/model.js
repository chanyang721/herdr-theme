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
// The "수집:" line of the mention inbox. With the claude.ai Slack connector collector
// (source 'claude-slack-connector') it names the source, what started the last collection
// (Dock badge or catch-up) and, on failure, only a fixed label for the error kind — never raw text.
const HEALTH_STATE={collecting:'조회 중',partial:'일부 확인',ok:'확인됨',paused:'일시 중지',error:'조회 실패'};
export const SLACK_COLLECT_ERROR=Object.freeze({
  config:'설정 확인 필요',no_tool:'커넥터 도구 없음',needs_auth_cache:'커넥터 인증 캐시 확인 필요',timeout:'시간 초과',
  parse:'결과 형식 오류',cli:'claude 실행 실패',budget:'비용 상한',policy:'허용 밖 도구 결과 버림',ingest:'로컬 기록 실패',
});
const TRIGGER={badge:'배지 변화',catchup:'따라잡기',manual:'수동'};
const clock=value=>{const at=new Date(value||'');return Number.isFinite(at.getTime())?`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`:'';};
export function collectLine(health){
  const h=health && typeof health==='object'?health:{};
  const state=HEALTH_STATE[h.state] || '상태 확인 전';
  if(h.source!=='claude-slack-connector')
    return `수집: ${state} · 마지막 성공 ${h.last_success || '아직 없음'} · 60초마다 조회 시도`;
  const kind=h.state==='error'?SLACK_COLLECT_ERROR[h.error_kind]:'';
  const last=TRIGGER[h.last_trigger]?` · 마지막 수집 ${clock(h.last_trigger_at)} ${TRIGGER[h.last_trigger]}`:'';
  return `수집: Slack 커넥터 · ${state}${kind?` · ${kind}`:''}${last} · 마지막 성공 ${clock(h.last_success) || '아직 없음'} · 배지 변화 때와 평일 ${h.catchup_minutes || 30}분 따라잡기`;
}
