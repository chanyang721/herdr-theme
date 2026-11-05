// Question and permission cards from an optional local bridge (herdr-harness `asks`).
// The bridge's files and CLI are the whole contract: `asks --json` lists pending cards and names
// `token_dir`, where each card's one-time token is `<id>.token`;
// `asks answer <id> --allow|--deny --token T [--choice "question=label"]...` answers one.
// Pure helpers only, so they run under node:test without the app.

export const KIND_WORDS = {
  ko: { permission: '권한', question: '질문', plan: '계획', allow: '허용', deny: '거부', send: '보내기', title: '확인 대기 카드', failed: '응답 실패' },
  en: { permission: 'Permission', question: 'Question', plan: 'Plan', allow: 'Allow', deny: 'Deny', send: 'Send', title: 'Cards waiting', failed: 'Answer failed' },
};

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN = /^[0-9a-f]{64}$/;

// The bridge script from harness-local/config.json; null hides the cards entirely.
export function bridgeFrom(configText) {
  let config;
  try { config = JSON.parse(configText || 'null'); } catch { return null; }
  const repo = typeof config?.repo_path === 'string' && config.repo_path.trim() ? config.repo_path.trim() : null;
  if (!repo) return null;
  return { python: typeof config.python === 'string' && config.python ? config.python : 'python3',
           script: `${repo.replace(/[\\/]+$/, '')}/runtime/harness.py` };
}

// Pending cards from `asks --json`; anything malformed is dropped, never guessed.
export function parseAsks(stdout) {
  let data;
  try { data = JSON.parse(stdout || 'null'); } catch { return null; }
  if (data?.schema !== 1 || !Array.isArray(data.asks)) return null;
  return {
    dir: typeof data.dir === 'string' ? data.dir : null,
    tokenDir: typeof data.token_dir === 'string' ? data.token_dir : null,
    asks: data.asks.filter(a => a && a.schema === 1 && ID.test(a.id) && a.status === 'pending'
      && ['permission', 'question', 'plan'].includes(a.kind)),
  };
}

export function askFor(asks, terminal) {
  return (asks ?? []).find(a => a.terminal && a.terminal === terminal) ?? null;
}

// The questions of an AskUserQuestion card, with their option labels.
export function questionsOf(ask) {
  const qs = ask?.tool_input?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.filter(q => typeof q?.question === 'string' && q.question).map(q => ({
    question: q.question,
    header: typeof q.header === 'string' ? q.header : '',
    multi: Boolean(q.multiSelect),
    options: (Array.isArray(q.options) ? q.options : []).map(o => typeof o === 'string' ? o : o?.label).filter(Boolean),
  }));
}

// One selection step: single-select replaces, multi-select toggles (labels kept in option order).
export function choose(selected, q, label) {
  const now = { ...(selected ?? {}) };
  if (!q.multi) { now[q.question] = [label]; return now; }
  const set = new Set(now[q.question] ?? []);
  if (set.has(label)) set.delete(label); else set.add(label);
  now[q.question] = q.options.filter(o => set.has(o));
  if (!now[q.question].length) delete now[q.question];
  return now;
}

export function complete(ask, selected) {
  const qs = questionsOf(ask);
  return qs.length > 0 && qs.every(q => (selected?.[q.question] ?? []).length > 0);
}

// harness.py arguments for an answer. Multi-select labels join with ", " as Claude expects.
// The card's token file, read just before answering.
export function tokenPath(tokenDir, ask) {
  if (!tokenDir || !ID.test(ask?.id ?? '')) return null;
  return `${tokenDir.replace(/[\\/]+$/, '')}/${ask.id}.token`;
}

export function cleanToken(text) {
  const token = String(text ?? '').trim();
  return TOKEN.test(token) ? token : null;
}

export function answerArgs(script, ask, decision, selected, token) {
  if (!ID.test(ask?.id ?? '')) throw new Error('bad ask id');
  if (decision !== 'allow' && decision !== 'deny') throw new Error('bad decision');
  const clean = cleanToken(token);
  if (!clean) throw new Error('card token missing');
  const args = [script, 'asks', 'answer', ask.id, decision === 'allow' ? '--allow' : '--deny', '--token', clean];
  if (decision === 'allow' && ask.kind === 'question') {
    for (const q of questionsOf(ask)) {
      const labels = selected?.[q.question] ?? [];
      if (!labels.length) throw new Error('unanswered question');
      args.push('--choice', `${q.question}=${labels.join(', ')}`);
    }
  }
  return args;
}

// The one line under a card's title: what the agent is about to do.
export function detailOf(ask) {
  const input = ask?.tool_input ?? {};
  if (ask?.kind === 'plan') return typeof input.plan === 'string' ? input.plan.split(/\r?\n/).find(l => l.trim())?.trim() ?? '' : '';
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
  }
  return '';
}

// Only names under the asks folder that are cards themselves (not leases, locks or temp files).
export function touchesCards(paths, dir) {
  if (!dir) return true;
  return (paths ?? []).some(p => {
    const name = String(p).split(/[\\/]/).pop();
    return String(p).replace(/\\/g, '/') === dir.replace(/\\/g, '/') || /^[0-9A-Z]{26}\.json$/.test(name);
  });
}
