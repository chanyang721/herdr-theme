// --- Who wrote to whom, readable text, attachments. The same code is in
// sixfold-slack-inbox/model.js (mods cannot import each other); a test keeps the two equal.
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
// The names one item reads with: its own mentions, then the feed, then the machine-local names.
export const namesFor = (item, feed = {}, site = {}) => ({...(site ?? {}), ...(feed ?? {}), ...(item?.mentions && typeof item.mentions === 'object' ? item.mentions : {})});
// Sender: author_name, then a "Name <ID>" author, then the names known for its ID, then the ID.
export function senderName(item, feed = {}, site = {}) {
  const raw = plain(item?.author), names = namesFor(item, feed, site);
  const id = plain(item?.author_id) || (USER.test(raw) ? raw : /<([UWB][A-Z0-9]+)>$/.exec(raw)?.[1] || '');
  const spelled = raw && !USER.test(raw) ? raw.replace(/\s*<[^>]*>$/, '').trim() : '';
  return plain(item?.author_name) || spelled || (id && names[id]) || id || '보낸 사람 미확인';
}
// The people the message tags, in order, without the sender.
export function recipients(item, feed = {}, site = {}) {
  const names = namesFor(item, feed, site), author = plain(item?.author_id) || plain(item?.author), seen = [];
  for (const [, id, label] of String(item?.text ?? '').matchAll(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g)) {
    if (id === author || seen.some(s => s.id === id)) continue;
    seen.push({id, name: plain(label) || names[id] || id});
  }
  return seen.map(s => s.name);
}
export function channelLabel(item, feed = {}) {
  const name = plain(item?.channel_name).replace(/^#/, '') || feed?.[plain(item?.channel)] || '';
  return name ? `#${name}` : plain(item?.project) || plain(item?.channel) || '채널 미확인';
}
// "보낸 사람 → 받는 사람": the first tagged person ("B 외 1" for more), or the channel when nobody is tagged.
export function alertTitle(item, feed = {}, site = {}) {
  const to = recipients(item, feed, site);
  return `${senderName(item, feed, site)} → ${to.length ? `${to[0]}${to.length > 1 ? ` 외 ${to.length - 1}` : ''}` : channelLabel(item, feed)}`;
}
// Slack markup as people read it: `<@ID|이름>`/`<@ID>` -> @이름, `<#C…|채널>` -> #채널, `<url|글>` -> 글.
// `names`: Slack ID -> display name (namesFor); an unknown ID stays as the ID.
export function readable(text='',names={}) {
  const name = id => names?.[id] || id;
  return String(text ?? '')
    .replace(/<@([A-Z0-9]+)\|([^>]*)>/g, (_, id, label) => `@${plain(label) || name(id)}`)
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
