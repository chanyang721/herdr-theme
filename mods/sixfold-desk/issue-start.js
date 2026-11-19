import {appHome, exec, readTextFile} from 'herdr';
import {parseStartConfig, startArgv, startResult, startAllowed, START_GUARD_MS} from './issue-start-model.js';

// The IO of "작업 시작": read the local setting file and run its command once per press.
// The guard lives here (not in a popover) so closing and reopening the search cannot send twice.
const guards = new Map();   // `${space}\u0000${issue}` -> {running, at}
const guardKey = (space, issue) => `${space}\u0000${issue}`;

export const startConfigPath = () => `${appHome()}/data/sixfold/issue-start.json`;

// {config, invalid}: config is the parsed setting or null; invalid is true when the file exists
// but cannot be used, so the strip can say so instead of looking unconfigured.
export async function loadStartConfigStatus({read = readTextFile, path = startConfigPath()} = {}) {
  const text = await read(path).catch(() => null);
  const config = text ? parseStartConfig(text) : null;
  return {config, invalid: Boolean(text) && !config};
}
// The parsed setting, or null when the file is missing or anything in it is off.
export async function loadStartConfig(options) {
  return (await loadStartConfigStatus(options)).config;
}

export const startGuarded = (space, issue, now = Date.now()) => !startAllowed(guards.get(guardKey(space, issue)), now);
// The finished starts of one space still guarded: [[issue, ms left]] (to redraw as each ends).
export function startGuardsOf(space, now = Date.now()) {
  const prefix = `${space}\u0000`, out = [];
  for (const [key, guard] of guards) {
    if (!key.startsWith(prefix) || guard.running) continue;
    const left = guard.at + START_GUARD_MS - now;
    if (left > 0) out.push([key.slice(prefix.length), left]);
  }
  return out;
}
// Milliseconds until a finished start's guard ends (0 when none, or while it still runs).
export function startGuardLeft(space, issue, now = Date.now()) {
  const guard = guards.get(guardKey(space, issue));
  return !guard || guard.running ? 0 : Math.max(0, guard.at + START_GUARD_MS - now);
}

// Runs the command for one issue. Returns null when the press is ignored (one already running or
// sent within the guard window), else {ok, text}. A value that fails the checks runs nothing.
export async function runStart(config, params, {run = exec, now = () => Date.now()} = {}) {
  const key = guardKey(params?.space, params?.issue);
  if (!startAllowed(guards.get(key), now())) return null;
  const argv = startArgv(config, params);
  if (!argv) return {ok: false, text: '안 보냄 · 작업 시작 값 확인 실패', release: true};
  const guard = {running: true, at: now()};
  guards.set(key, guard);   // claimed before anything is awaited
  let result = null;
  try { result = await run(argv.command, argv.args, {timeout: argv.timeout}); } catch { result = null; }
  guard.running = false; guard.at = now();
  for (const [k, g] of guards) if (startAllowed(g, now())) guards.delete(k);   // drop expired guards
  const answer = startResult(result, config.release, config.taskField);
  if (answer.release && guards.get(key) === guard) guards.delete(key);   // surely not sent: press again at once
  return answer;
}

// Tests only.
export const resetStartGuards = () => guards.clear();
