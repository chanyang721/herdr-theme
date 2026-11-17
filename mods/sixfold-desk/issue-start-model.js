// "작업 시작" from the issue search: pure rules only (no IO). The issue row opens a strip with
// a choice of agent and tier; [작업 시작] runs one command template from the local setting file
// (data/sixfold/issue-start.json) without a shell. Every value placed into the command is checked
// here first; anything off means nothing is run.
//
// Duplicate guard: it lives only in this window's memory (one start per issue while running and
// for three minutes after). Duplicates across windows or restarts must be refused by the command
// being run. In the setting, never use {title} (or {space}) as an argument on its own: write
// "{issue} {title}" so a value cannot stand where an option would; a value that would start an
// argument with '-' where the template's argument does not is refused anyway.

export const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
export const START_GUARD_MS = 3 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 300000;
const MAX_ARGS = 40, MAX_ARG = 2000, MAX_CHOICES = 12;
const CHOICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// C0, DEL and C1 control characters, and the line/paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SENT = new Set(['sent', 'pending', 'unconfirmed']);
// Outcomes that surely sent nothing, so the guard is lifted at once. Only these (an allow list):
// any other outcome may have sent something. A setting may name its own with "release_outcomes".
export const DEFAULT_RELEASE_OUTCOMES = Object.freeze(['blocked', 'plan']);
const OUTCOME_ID = /^[a-z][a-z0-9_]{0,31}$/;

const absolute = path => typeof path === 'string' && path.length <= 1024 && !HAS_CONTROL.test(path)
  && (/^\/[^/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path));

function choices(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_CHOICES) return null;
  const out = [], seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !CHOICE_ID.test(item.id) || seen.has(item.id)) return null;
    const label = typeof item.label === 'string' ? cleanText(item.label, 20) : '';
    seen.add(item.id); out.push({id: item.id, label: label || item.id});
  }
  return out;
}

// Removes control characters, folds runs of whitespace and cuts to `limit` characters.
export function cleanText(value, limit = 80) {
  if (typeof value !== 'string') return '';
  return [...value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()].slice(0, limit).join('').trim();
}

// The setting file's text (or parsed value) -> a frozen config, or null when anything is off.
export function parseStartConfig(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!value || typeof value !== 'object' || value.v !== 1 || !absolute(value.command)) return null;
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGS
    || value.args.some(arg => typeof arg !== 'string' || arg.length > MAX_ARG || HAS_CONTROL.test(arg))) return null;
  const providers = choices(value.providers), tiers = choices(value.tiers);
  if (!providers || !tiers) return null;
  const wanted = value.default && typeof value.default === 'object' ? value.default : {};
  const pick = (list, id) => id === undefined ? list[0].id : list.some(item => item.id === id) ? id : null;
  const provider = pick(providers, wanted.provider), tier = pick(tiers, wanted.tier);
  if (!provider || !tier) return null;
  const timeout = value.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : value.timeout_ms;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) return null;
  const release = value.release_outcomes === undefined ? DEFAULT_RELEASE_OUTCOMES : value.release_outcomes;
  if (!Array.isArray(release) || release.length > 20
    || release.some(item => typeof item !== 'string' || !OUTCOME_ID.test(item) || SENT.has(item))) return null;
  return Object.freeze({command: value.command, args: Object.freeze([...value.args]), providers, tiers,
    defaults: Object.freeze({provider, tier}), timeout, release: Object.freeze([...new Set(release)])});
}

// {space, issue, title, provider, tier} -> {command, args, timeout}, or null when a value is off.
// Each placeholder is replaced once, left to right: a title holding "{tier}" stays literal text.
export function startArgv(config, {space, issue, title, provider, tier} = {}) {
  if (!config || !Array.isArray(config.args) || !absolute(config.command)) return null;
  if (typeof issue !== 'string' || !ISSUE_KEY.test(issue)) return null;
  if (!config.providers?.some(item => item.id === provider) || !config.tiers?.some(item => item.id === tier)) return null;
  const name = typeof space === 'string' ? cleanText(space.replace(CONTROL, ''), 80) : '';
  if (!name) return null;
  const values = {space: name, issue, title: cleanText(title, 80), provider, tier};
  const args = config.args.map(arg => arg.replace(/\{(space|issue|title|provider|tier)\}/g, (_m, key) => values[key]));
  if (args.length > MAX_ARGS || args.some(arg => arg.length > MAX_ARG)) return null;
  // A value must not turn an argument into an option ('-…') the template did not write as one.
  if (args.some((arg, i) => arg.startsWith('-') && !config.args[i].startsWith('-'))) return null;
  return {command: config.command, args, timeout: config.timeout};
}

// The command's stdout -> the last line that parses as a JSON object, or null.
export function lastJson(stdout) {
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  }
  return null;
}

// exec's {code, stdout} (or null when exec itself threw) -> {ok, text, release} for the result line.
// `release`: surely not sent (a JSON answer whose outcome is on the `release` allow list), so the
// guard may be lifted at once. A timeout, no JSON, an empty or any other outcome keeps the guard.
export function startResult(result, release = DEFAULT_RELEASE_OUTCOMES) {
  const code = Number.isInteger(result?.code) ? result.code : null;
  const json = result ? lastJson(result.stdout) : null;
  if (!json) return {ok: false, text: `실행 실패(코드 ${code ?? '?'})`, release: false};
  const word = value => typeof value === 'string' || typeof value === 'number' ? cleanText(String(value), 60) : '';
  const outcome = word(json.outcome), task = word(json.task_id);
  if (SENT.has(outcome) && task) return {ok: true, text: ['보냄', word(json.target), word(json.model)].filter(Boolean).join(' · '), release: false};
  const reason = cleanText(typeof json.reason === 'string' ? json.reason : '', 120) || outcome;
  return {ok: false, text: reason ? `안 보냄 · ${reason}` : '안 보냄', release: Boolean(outcome) && !SENT.has(outcome) && release.includes(outcome)};
}

// One start per issue at a time: none while one is running, none within START_GUARD_MS of the last.
export function startAllowed(guard, now = Date.now()) {
  if (!guard) return true;
  if (guard.running) return false;
  return !(Number.isFinite(guard.at) && now - guard.at < START_GUARD_MS);
}

// The strip's choice for an issue: the stored pick when it still names listed ids, else the defaults.
export function startPick(config, pick) {
  if (!config) return null;
  const has = (list, id) => list.some(item => item.id === id);
  return {provider: has(config.providers, pick?.provider) ? pick.provider : config.defaults.provider,
    tier: has(config.tiers, pick?.tier) ? pick.tier : config.defaults.tier};
}

// What the popover's redraw depends on from this feature (for retained-render keys and tests).
export function startSignature(state) {
  if (!state) return '';
  return JSON.stringify([state.detail || null, state.startPick || null,
    [...(state.starts || new Map())].map(([key, entry]) => [key, entry.running === true, entry.text || ''])]);
}
