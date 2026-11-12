// --- Who wrote to whom, readable text, attachments. The same code is in
// sixfold-desk/alert-slack.js (mods cannot import each other); a test keeps the two equal.
const USER = /^[UWB][A-Z0-9]{2,}$/;
const plain = value => String(value ?? '').trim();
// Every name the feed itself spells: `<@ID|name>` and `<#C…|name>` marks, each item's
// `mentions` map, author_id/author_name and channel/channel_name. Nothing is guessed.
export function feedNames(items) {
  const names = {};
  const put = (id, name) => { id = plain(id); name = plain(name); if (id && name && name !== id && !names[id]) names[id] = name; };
  for (const item of items ?? []) {
    for (const [, id, name] of String(item?.text ?? '').matchAll(/<[@#]([A-Z0-9]+)\|([^>]*)>/g)) put(id, name);
    for (const [id, name] of Object.entries(item?.mentions && typeof item.mentions === 'object' ? item.mentions : {})) put(id, name);
    put(item?.author_id, item?.author_name);
    put(item?.channel, String(item?.channel_name ?? '').replace(/^#/, ''));
  }
  return names;
}
// Name order (both people): the item's `mentions` map (the collector's newest names), then author_name
// or the label the text spells, then the feed's marks, then the machine-local names, then the ID.
const mentionsOf = item => item?.mentions && typeof item.mentions === 'object' && !Array.isArray(item.mentions) ? item.mentions : {};
// The names one item reads with: its own mentions, then the feed, then the machine-local names.
export const namesFor = (item, feed = {}, site = {}) => ({...(site ?? {}), ...(feed ?? {}), ...mentionsOf(item)});
const authorId = item => { const raw = plain(item?.author); return plain(item?.author_id) || (USER.test(raw) ? raw : /<([UWB][A-Z0-9]+)>$/.exec(raw)?.[1] || ''); };
// Sender: mentions, then author_name (or a "Name <ID>" author), then the feed and local names, then the ID.
export function senderName(item, feed = {}, site = {}) {
  const raw = plain(item?.author), id = authorId(item), names = namesFor(item, feed, site);
  const spelled = raw && !USER.test(raw) ? raw.replace(/\s*<[^>]*>$/, '').trim() : '';
  return (id && plain(mentionsOf(item)[id])) || plain(item?.author_name) || spelled || (id && names[id]) || id || '보낸 사람 미확인';
}
// The people the message tags, in order, leaving out the sender.
export function recipients(item, feed = {}, site = {}) {
  const names = namesFor(item, feed, site), mentions = mentionsOf(item), author = authorId(item), seen = [];
  for (const [, id, label] of String(item?.text ?? '').matchAll(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g)) {
    if (id === author || seen.some(s => s.id === id)) continue;
    seen.push({id, name: plain(mentions[id]) || plain(label) || names[id] || id});
  }
  return seen.map(s => s.name);
}
// Nobody tagged: the channel name, then the project, then the channel ID.
export function channelLabel(item) {
  const name = plain(item?.channel_name).replace(/^#/, '');
  return name ? `#${name}` : plain(item?.project) || plain(item?.channel) || '채널 미확인';
}
// "보낸 사람 → 받는 사람": the first tagged person ("B 외 1" for more), or the channel when nobody is tagged.
export function alertTitle(item, feed = {}, site = {}) {
  const to = recipients(item, feed, site);
  return `${senderName(item, feed, site)} → ${to.length ? `${to[0]}${to.length > 1 ? ` 외 ${to.length - 1}` : ''}` : channelLabel(item)}`;
}
// Slack markup as people read it: `<@ID|이름>`/`<@ID>` -> @이름, `<#C…|채널>` -> #채널, `<url|글>` -> 글.
// `names`: Slack ID -> display name (namesFor); `mentions` (the item's own map) wins over a spelled
// label, as in the title; an unknown ID stays as the ID.
export function readable(text='',names={},mentions={}) {
  const name = id => names?.[id] || id;
  return String(text ?? '')
    .replace(/<@([A-Z0-9]+)\|([^>]*)>/g, (_, id, label) => `@${plain(mentions?.[id]) || plain(label) || name(id)}`)
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${name(id)}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${plain(label) || name(id)}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<((?:https?|mailto):[^>|]+)>/g, '$1')
    .replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
}
// Attachments (`files: [{id, name, mimetype, size?, permalink}]`): a chip each. The id names the local
// text copy, so only a plain id is kept; the download link only when it is a Slack https address.
export const FILE_ID = /^[A-Za-z0-9]{1,64}$/;
const SLACK_FILE = /^https:\/\/([a-z0-9-]+\.)*slack\.com\/[^\s]*$/i;
const KINDS = [[/pdf/, 'PDF'], [/^image\//, '이미지'], [/^video\//, '동영상'], [/^audio\//, '음성'],
  [/spreadsheet|excel|csv|sheet/, '표'], [/presentation|powerpoint|slides|keynote/, '슬라이드'],
  [/word|msword|document|rtf|hwp|pages/, '문서'], [/zip|compressed|tar|gzip|rar|7z/, '압축'],
  [/json|javascript|python|x-sh|xml|yaml|typescript/, '코드'], [/^text\//, '텍스트']];
const EXT_KIND = {pdf: 'PDF', png: '이미지', jpg: '이미지', jpeg: '이미지', gif: '이미지', webp: '이미지', heic: '이미지',
  mp4: '동영상', mov: '동영상', mp3: '음성', m4a: '음성', xlsx: '표', xls: '표', csv: '표', pptx: '슬라이드', ppt: '슬라이드', key: '슬라이드',
  docx: '문서', doc: '문서', hwp: '문서', hwpx: '문서', rtf: '문서', zip: '압축', md: '텍스트', txt: '텍스트', json: '코드', js: '코드', py: '코드'};
const sizeLabel = size => { const n = Number(size); if (!Number.isFinite(n) || n <= 0) return '';
  return n < 1024 ? `${n}B` : n < 1024 ** 2 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 ** 2).toFixed(1)}MB`; };
export function attachments(item) {
  return (Array.isArray(item?.files) ? item.files : []).filter(f => f && FILE_ID.test(String(f.id ?? ''))).slice(0, 10).map(f => {
    const name = plain(f.name) || '이름 없는 파일', ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() || '';
    const mime = plain(f.mimetype).toLowerCase(), kind = KINDS.find(([re]) => re.test(mime))?.[1] || EXT_KIND[ext] || (ext ? ext.toUpperCase() : '파일');
    return {id: String(f.id), name, kind, ext: (ext || kind).slice(0, 4).toUpperCase(), size: sizeLabel(f.size), link: SLACK_FILE.test(plain(f.permalink)) ? plain(f.permalink) : ''};
  });
}
// The collector's local text copy of a file (data/sixfold/slack-files/<id>.txt); none for an unsafe id.
export const fileTextPath = (home, id) => FILE_ID.test(String(id ?? '')) ? `${home}/data/sixfold/slack-files/${id}.txt` : null;
export const FILE_TEXT_LIMIT = 20000;
export const fileTextShown = text => text.length > FILE_TEXT_LIMIT ? `${text.slice(0, FILE_TEXT_LIMIT)}\n… (앞 ${FILE_TEXT_LIMIT}자만 표시)` : text;
// --- end of the shared Slack alert code.
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
const TRIGGER={badge:'배지 변화',continue:'이어 읽기',catchup:'따라잡기',manual:'수동'};
const PARTIAL={missing_search:'빠진 검색 다시',pages_left:'남은 쪽 이어 읽기',untrusted:'모호한 결과 다시 읽기'};
const clock=value=>{const at=new Date(value||'');return Number.isFinite(at.getTime())?`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`:'';};
export function collectLine(health){
  const h=health && typeof health==='object'?health:{};
  const state=HEALTH_STATE[h.state] || '상태 확인 전';
  if(h.source!=='claude-slack-connector')
    return `수집: ${state} · 마지막 성공 ${h.last_success || '아직 없음'} · 60초마다 조회 시도`;
  const kind=h.state==='error'?SLACK_COLLECT_ERROR[h.error_kind]:h.state==='partial'?PARTIAL[h.checkpoint_reason]:'';
  const last=TRIGGER[h.last_trigger]?` · 마지막 수집 ${clock(h.last_trigger_at)} ${TRIGGER[h.last_trigger]}`:'';
  return `수집: Slack 커넥터 · ${state}${kind?` · ${kind}`:''}${last} · 마지막 성공 ${clock(h.last_success) || '아직 없음'} · 배지 변화 때와 평일 ${h.catchup_minutes || 30}분 따라잡기`;
}
