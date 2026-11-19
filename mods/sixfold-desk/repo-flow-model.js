// Optional display data only. A local command result is not a remote push,
// a CI result, or an installation receipt. Those stages require their own data.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const label = (value, max = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const key = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : '';
const STATES = new Set(['unknown', 'none', 'waiting', 'running', 'succeeded', 'failed', 'offline']);
const revision = value => typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value) ? value : '';
const normalized = new WeakSet();

export const REPO_FLOW_GEOMETRY = Object.freeze({row: 24, heading: 22, cloud: 36, cell: 10, push: 32, ci: 20, cd: 22, gap: 3, stages: 84});

// The alias is the same optional DTO, not a second event stream to merge or
// count. Entry points accept either a complete feed or that DTO directly.
export function repoFlowActivity(value) {
  const raw = object(value);
  return raw.schema ? raw : object(raw.repo_activity || raw.repo_flow);
}

export function repoStage(value) {
  const raw = object(value), state = STATES.has(raw.state) ? raw.state : 'unknown';
  return {state, detail: label(raw.detail), sha: revision(raw.sha)};
}

// No fraction from elapsed time or the number of connected machines. The
// denominator includes explicitly waiting/offline destinations, too.
export function repoDeployment(value, expectedSha = '') {
  const raw = object(value), stage = repoStage(raw);
  const expected = stage.sha || revision(expectedSha);
  const targets = [], seen = new Set();
  for (const item of list(raw.targets).slice(0, 100)) {
    const row = object(item), id = key(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    targets.push({id, name: label(row.name, 80), computer: key(row.computer),
      environment: label(row.environment, 40), ...repoStage(row)});
  }
  const installed = targets.filter(target => target.state === 'succeeded' && (!expected || target.sha === expected)).length;
  return {...stage, targets, installed, total: targets.length,
    fraction: targets.length ? installed / targets.length : stage.state === 'succeeded' ? 1 : 0,
    pending: targets.some(target => ['waiting', 'offline'].includes(target.state))};
}

export function repoFlowModel(activity) {
  if (activity && typeof activity === 'object' && normalized.has(activity)) return activity;
  const raw = repoFlowActivity(activity);
  if (raw.schema !== 'repo_activity_v1') return {repositories: [], clouds: []};
  const accounts = new Map();
  for (const item of list(raw.accounts).slice(0, 64)) {
    const row = object(item), id = key(row.id);
    if (id && !accounts.has(id) && ['personal', 'company'].includes(row.kind)) accounts.set(id, {id, name: label(row.name, 80), kind: row.kind});
  }
  const repositories = [], seen = new Set();
  for (const item of list(raw.repositories).slice(0, 100)) {
    const row = object(item), id = key(row.id), account = accounts.get(key(row.account_id)), name = label(row.name, 80);
    if (!id || !name || !account || seen.has(id)) continue;
    seen.add(id);
    const flow = object(row.flow), commit = object(flow.commit);
    repositories.push({id, account, name, namespace: label(row.namespace, 80), private: row.private === true,
      quiet: row.quiet === true, commit: {issue: label(commit.issue, 40), title: label(commit.title), sha: revision(commit.sha)},
      push: repoStage(flow.push), ci: repoStage(flow.ci), cd: repoDeployment(flow.cd, revision(commit.sha)),
      provider: flow.provider === 'aws' ? 'aws' : null});
  }
  const clouds = [];
  for (const account of accounts.values()) {
    const repos = repositories.filter(repo => repo.account.id === account.id && account.kind === 'company' && repo.provider === 'aws');
    if (repos.length) clouds.push({id: account.id, name: account.name, repositories: repos});
  }
  const model = {repositories, clouds};
  normalized.add(model);
  return model;
}

export function repoComputerInstalls(model, computer) {
  if (!computer) return [];
  return model.repositories.flatMap(repo => repo.cd.targets.filter(target => target.computer === computer)
    .map(target => ({...target, repository: repo.id, repoName: repo.name})));
}

export function repoFlowRows(model, expanded = false) {
  const quiet = model.repositories.filter(repo => repo.quiet);
  return {repositories: model.repositories.filter(repo => expanded || !repo.quiet), hidden: expanded ? 0 : quiet.length, quiet: quiet.length};
}
