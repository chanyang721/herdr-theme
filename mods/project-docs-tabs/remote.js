// Documents on another machine, read into memory only.
//
// The text comes from `hc file read --json --on <machine> -- <path>`: the other machine's core
// reads the file itself (a regular UTF-8 file, no shell there) and the reply arrives in this
// process's memory. Nothing here writes the text to a file, a cache, shared state or a log, and
// a remote document never goes through the local helpers that stage pictures, render Mermaid or
// draw HTML (they all write PNGs under this mod's folder). Pure apart from the `hc` it is given.
import { normalize, dirname, resolveLink, extension } from './vendor/paths.js';

// Shared key another mod sets to ask this space's 문서 tab to show a remote file:
// { [spaceId]: { on, path, at } }. Metadata only; the tab removes its entry once taken.
export const REMOTE_OPEN = 'sixfold.docs.remote-open.v1';
// A request older than this is dropped unread, so a restart never reads a remote file by itself.
export const REQUEST_TTL_MS = 5 * 60 * 1000;
// Characters shown, as for local Markdown.
export const REMOTE_LIMIT = 400000;
const MAX_PATH = 1024;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// What a remote file is shown as. HTML is shown as its source: it is never run or drawn here.
const KINDS = { md: 'markdown', markdown: 'markdown', txt: 'text', html: 'html', htm: 'html' };

const MESSAGES = {
  invalid_machine: '컴퓨터 이름이 올바르지 않습니다.',
  unknown_machine: '연결된 컴퓨터 목록에 없는 이름입니다.',
  invalid_path: '원격 문서 경로가 올바르지 않습니다.',
  unsupported: '원격 문서는 Markdown·텍스트·HTML 소스만 볼 수 있습니다.',
  roots_unverifiable: '허용 폴더 제한은 원격 링크·정션을 따라가는 읽기에서 보장할 수 없어 열지 않습니다.',
  offline: '그 컴퓨터에 연결할 수 없습니다.',
  not_found: '그 컴퓨터에 파일이 없습니다.',
  not_file: '일반 파일이 아닙니다.',
  denied: '그 컴퓨터에서 파일을 읽을 권한이 없습니다.',
  not_text: 'UTF-8 텍스트 문서가 아닙니다.',
  too_large: '원격 문서가 너무 큽니다.',
  timeout: '원격 문서를 읽는 시간이 초과되었습니다.',
  failed: '원격 문서를 읽지 못했습니다.',
};

export class RemoteDocumentError extends Error {
  constructor(kind, detail) {
    super(MESSAGES[kind] || MESSAGES.failed);
    this.name = 'RemoteDocumentError'; this.kind = MESSAGES[kind] ? kind : 'failed';
    // Only a short, single-line hint from hc (it names the path, never file text).
    if (detail) this.detail = String(detail).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 160);
  }
}

const drive = path => /^[A-Za-z]:\//.test(path);

// An absolute path on the other machine: POSIX `/x` or a drive `C:/x` (backslashes allowed).
// No UNC or device paths (they reach a third machine or a device), no `..`, no control characters.
function remotePath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || CONTROL.test(value)) throw new RemoteDocumentError('invalid_path');
  // `file:///C:/x` links arrive as `/C:/x`: a drive path.
  const slashed = value.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '');
  if (slashed.startsWith('//') || !(slashed.startsWith('/') || drive(slashed))) throw new RemoteDocumentError('invalid_path');
  if (slashed.split('/').some(part => part === '..')) throw new RemoteDocumentError('invalid_path');
  const path = normalize(slashed);
  if (path === '/' || /^[A-Za-z]:\/?$/.test(path) || path.endsWith('/')) throw new RemoteDocumentError('invalid_path');
  return path;
}

// Names `machines()` reports for other machines (null names this computer).
export function machineNames(list) {
  return Array.isArray(list) ? list.map(m => m?.name).filter(name => typeof name === 'string' && name) : null;
}

/**
 * A checked remote document: { on, path, kind, name }. Throws RemoteDocumentError.
 * `machines`: the names that may be asked (from machineNames); null skips that check.
 * A request naming `roots` (a folder limit) is refused: see below.
 */
export function remoteTarget(request, { machines = null } = {}) {
  const on = request?.on;
  if (typeof on !== 'string' || !MACHINE.test(on)) throw new RemoteDocumentError('invalid_machine');
  if (Array.isArray(machines) && !machines.includes(on)) throw new RemoteDocumentError('unknown_machine');
  const path = remotePath(request.path);
  const kind = KINDS[extension(path)];
  if (!kind) throw new RemoteDocumentError('unsupported');
  // A folder limit cannot be kept: the other core's file.read follows symbolic links, junctions
  // and linked folders inside the path, so a path that names a file under the folder can read a
  // file elsewhere. A request that asks for one is refused rather than read with a false promise.
  if (request.roots != null) throw new RemoteDocumentError('roots_unverifiable');
  return Object.freeze({ on, path, kind, name: path.split('/').pop() });
}

export const remoteKey = target => `${target.on}\u0000${target.path}`;
// Document ids for remote files: a number per machine and path, kept only in this map, so an id
// that reaches saved state (the Finder's place) names neither the machine nor the path.
export function createRemoteIds() {
  const ids = new Map();
  return target => {
    const key = remoteKey(target);
    if (!ids.has(key)) ids.set(key, `remote-${ids.size + 1}`);
    return ids.get(key);
  };
}
// hc's error kinds (herdr-core RpcError) as this module's.
function failure(error, stderr) {
  const kind = String(error?.kind || ''), message = String(error?.message || stderr || '');
  if (kind === 'machine_unknown') return new RemoteDocumentError('unknown_machine');
  if (['unreachable', 'unavailable', 'needs_login', 'busy'].includes(kind)) return new RemoteDocumentError('offline', message);
  if (kind === 'denied' || kind === 'refused' || (kind === 'io' && /denied|permission/i.test(message))) return new RemoteDocumentError('denied');
  if (kind === 'not_found') return new RemoteDocumentError('not_found');
  if (kind === 'not_text') return new RemoteDocumentError('not_text');
  if (kind === 'invalid_params' && /not a regular file/i.test(message)) return new RemoteDocumentError('not_file');
  if (kind === 'invalid_params' && /over \d+ MB/i.test(message)) return new RemoteDocumentError('too_large');
  if (kind === 'invalid_params') return new RemoteDocumentError('invalid_path');
  return new RemoteDocumentError('failed', kind || message);
}

// Lines asked for at once. The other core answers whole lines up to 8 MiB of JSON text, but the
// app keeps only the first 8 MiB of hc's output (herdr-app EXEC_OUTPUT), envelope included, so a
// reply near that size arrives cut and is not JSON. Pages of lines keep replies small; a cut
// reply is asked again with fewer lines; a single line too long for one reply is too large.
export const PAGE_LINES = 4000;
// hc calls for one document at most, page retries included (each may take up to 30 s).
export const MAX_ASKS = 24;

/**
 * Reads remote documents through `hc` (the app's `hc(args)`), page by page, until the shown
 * length or the end of the file. Reads of the same file share one request while it runs;
 * nothing is kept once it settles, so every open asks the machine again.
 */
export function createRemoteReader({ hc, limit = REMOTE_LIMIT, pageLines = PAGE_LINES, maxAsks = MAX_ASKS } = {}) {
  if (typeof hc !== 'function') throw new TypeError('createRemoteReader needs hc');
  const running = new Map();
  // One page: { text, last, lines } or { cut: true }.
  async function page(target, first, count) {
    let result;
    try { result = await hc(['file', 'read', '--json', '--on', target.on, '--offset', String(first), '--limit', String(count), '--', target.path]); }
    catch (error) {
      // The app stops hc after 30 s; any other host failure is reported without its text.
      throw /longer than|timed? ?out/i.test(String(error?.message || error)) ? new RemoteDocumentError('timeout') : new RemoteDocumentError('failed');
    }
    const stdout = String(result?.stdout || '');
    let reply = null, parsed = false;
    try { reply = JSON.parse(stdout.trim() || 'null'); parsed = true; } catch {}
    // A successful reply the app cut at its output limit: it starts like one and does not parse.
    if (!parsed && result?.code === 0 && /^\s*\{\s*"first"\s*:/.test(stdout)) return { cut: true };
    if (!reply || typeof reply !== 'object') {
      try { reply = JSON.parse(String(result?.stderr || '').trim() || 'null'); } catch {}
    }
    if (reply?.error) throw failure(reply.error, '');
    if (result?.code !== 0 || typeof reply?.text !== 'string' || !Number.isFinite(reply.last) || !Number.isFinite(reply.lines)) {
      throw new RemoteDocumentError('failed', `exit ${result?.code}`);
    }
    if (reply.text.includes('\0')) throw new RemoteDocumentError('not_text');
    return { text: reply.text, last: reply.last, lines: reply.lines };
  }
  async function ask(target) {
    let first = 1, count = pageLines, text = '', lines = null, asks = 0, more = false;
    for (;;) {
      if (asks++ >= maxAsks) { more = true; break; }
      let got;
      try { got = await page(target, first, count); }
      catch (error) {
        // A later page that no longer fits (or a file that shrank meanwhile) ends what is shown.
        if (text && (error.kind === 'too_large' || error.kind === 'invalid_path')) { more = true; break; }
        throw error;
      }
      if (got.cut) {
        if (count > 1) { count = Math.max(1, Math.floor(count / 8)); continue; }
        if (text) { more = true; break; }
        throw new RemoteDocumentError('too_large');
      }
      text += got.text; lines = got.lines;
      if (got.last >= got.lines) break;
      if (text.length >= limit || got.last < first) { more = true; break; }
      first = got.last + 1;
    }
    return { text: text.length > limit ? text.slice(0, limit) : text, truncated: more || text.length > limit, lines };
  }
  return {
    read(target) {
      const key = remoteKey(target);
      if (!running.has(key)) running.set(key, ask(target).finally(() => running.delete(key)));
      return running.get(key);
    },
    running: () => running.size,
  };
}

// A fence longer than any backtick run in the text, so the text cannot close it.
// Counted in one pass: spreading every run into Math.max overflows the stack on long text.
export function fenced(text, language = '') {
  text = String(text);
  let longest = 0, run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 96) { if (++run > longest) longest = run; } else run = 0;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

/**
 * Blocks for the viewer. Markdown keeps its text (pictures are listed as unavailable and never
 * fetched; Mermaid stays as code). Text and HTML show as code; HTML is never run or drawn.
 * `stage` is vendor stageMarkdown; with `on` set it stages nothing.
 */
export async function remoteBlocks(text, target, stage) {
  if (target.kind !== 'markdown') return { blocks: [{ text: fenced(text, target.kind === 'html' ? 'html' : '') }], unavailable: false };
  const staged = await stage(text, { file: target.path, root: dirname(target.path), on: target.on });
  if (staged.blocks.some(block => block.media)) throw new RemoteDocumentError('failed', 'staged media for a remote document');
  return { blocks: staged.blocks, unavailable: Boolean(staged.unavailable) };
}

/**
 * Where a link in a remote document goes: { url } for http(s), { remote } for another document
 * on the same machine (checked like the first), { anchor } for #, or { blocked } — never a file
 * on this computer.
 */
export function remoteLink(target, href, options = {}) {
  let link;
  try { link = resolveLink(target.path, String(href)); } catch { return { blocked: '열 수 없는 링크입니다.' }; }
  if (link.url) return /^https?:\/\//i.test(link.url) ? { url: link.url } : { blocked: '열 수 없는 링크입니다.' };
  if (link.anchor) return { anchor: true };
  try {
    return { remote: remoteTarget({ on: target.on, path: link.file }, options) };
  } catch (error) { return { blocked: error.message }; }
}

/**
 * Takes this space's open request from the shared value. Returns { request, rest, stale }:
 * `rest` is the shared value without it, to write back once; a stale request is dropped unread.
 */
export function takeRequest(value, spaceId, now = Date.now()) {
  const entry = value && typeof value === 'object' ? value[spaceId] : null;
  if (!entry) return { request: null, rest: null, stale: false };
  const rest = { ...value }; delete rest[spaceId];
  const at = Number(entry.at);
  const stale = !Number.isFinite(at) || now - at > REQUEST_TTL_MS || at - now > 60000;
  return { request: stale ? null : entry, rest, stale };
}
