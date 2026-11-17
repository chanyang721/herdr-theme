import {appHome, exec, readTextFile} from 'herdr';
import {parseStartConfig, startArgv, startResult, startAllowed} from './issue-start-model.js';

// The IO of "작업 시작": read the local setting file and run its command once per press.
// The guard lives here (not in a popover) so closing and reopening the search cannot send twice.
const guards = new Map();   // `${space}\u0000${issue}` -> {running, at}
const guardKey = (space, issue) => `${space}\u0000${issue}`;

export const startConfigPath = () => `${appHome()}/data/sixfold/issue-start.json`;

// The parsed setting, or null when the file is missing or anything in it is off.
export async function loadStartConfig({read = readTextFile, path = startConfigPath()} = {}) {
  const text = await read(path).catch(() => null);
  return text ? parseStartConfig(text) : null;
}

export const startGuarded = (space, issue, now = Date.now()) => !startAllowed(guards.get(guardKey(space, issue)), now);

// Runs the command for one issue. Returns null when the press is ignored (one already running or
// sent within the guard window), else {ok, text}. A value that fails the checks runs nothing.
export async function runStart(config, params, {run = exec, now = () => Date.now()} = {}) {
  const key = guardKey(params?.space, params?.issue);
  if (!startAllowed(guards.get(key), now())) return null;
  const argv = startArgv(config, params);
  if (!argv) return {ok: false, text: '안 보냄 · 작업 시작 값 확인 실패'};
  const guard = {running: true, at: now()};
  guards.set(key, guard);   // claimed before anything is awaited
  let result = null;
  try { result = await run(argv.command, argv.args, {timeout: argv.timeout}); } catch { result = null; }
  guard.running = false; guard.at = now();
  for (const [k, g] of guards) if (startAllowed(g, now())) guards.delete(k);   // drop expired guards
  return startResult(result);
}

// Tests only.
export const resetStartGuards = () => guards.clear();
