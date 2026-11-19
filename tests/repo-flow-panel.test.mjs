import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {repoFlowActivity, repoFlowModel, repoStage, repoDeployment, repoComputerInstalls, repoFlowRows, REPO_FLOW_GEOMETRY as G} from '../mods/sixfold-desk/repo-flow-model.js';

const receipt = (id, state, extra = {}) => ({id, name: id, state, ...extra});
const fixture = () => ({schema: 'repo_activity_v1',
  accounts: [{id: 'personal', name: 'Example', kind: 'personal'}, {id: 'company', name: 'Example Org', kind: 'company'}],
  repositories: [
    {id: 'theme', account_id: 'personal', namespace: 'example', name: 'theme', private: false,
      flow: {commit: {issue: 'APP-42', title: '패널 여백 조정', sha: 'a1b2c3d'}, push: {state: 'succeeded'}, ci: {state: 'running'},
        cd: {state: 'running', targets: [receipt('pc-a', 'succeeded', {computer: 'c-local', sha: 'a1b2c3d'}),
          receipt('pc-b', 'running', {computer: 'c-remote'}), receipt('pc-c', 'offline', {computer: 'c-off'})]}}},
    {id: 'api', account_id: 'company', namespace: 'example-org', name: 'api', private: true,
      flow: {provider: 'aws', ci: {state: 'failed'}, cd: {state: 'waiting', targets: [
        receipt('stage', 'succeeded', {environment: 'stg', sha: 'b2c3d4e'}), receipt('prod', 'waiting', {environment: 'prod'})]}}},
    {id: 'notes', account_id: 'personal', namespace: 'example', name: 'notes', quiet: true,
      flow: {push: {state: 'succeeded'}, ci: {state: 'none'}, cd: {state: 'none'}}}
  ], events: [], bindings: [], coverage: {}});

test('accepts the existing DTO and either feed field without merging aliases', () => {
  const activity = fixture();
  assert.equal(repoFlowActivity(activity), activity);
  assert.deepEqual(repoFlowModel({repo_flow: activity}), repoFlowModel(activity));
  assert.deepEqual(repoFlowModel({repo_activity: activity, repo_flow: fixture()}), repoFlowModel(activity));
  assert.equal(repoFlowModel({repo_activity: activity, repo_flow: activity}).repositories.length, 3);
  for (const value of [undefined, null, [], {}, {schema: 'future'}, {repo_activity: {schema: 'future'}, repo_flow: activity}]) {
    assert.deepEqual(repoFlowModel(value), {repositories: [], clouds: []});
  }
});

test('a catalog and command observations leave unobserved remote stages empty', () => {
  const activity = fixture();
  activity.repositories = [{id: 'theme', account_id: 'personal', namespace: 'example', name: 'theme'}];
  activity.events = [{repository_id: 'theme', operation: 'push', phase: 'authorization', result: 'succeeded'},
    {repository_id: 'theme', operation: 'merge', phase: 'result', result: 'succeeded', evidence: 'head_verified'}];
  const repo = repoFlowModel(activity).repositories[0];
  assert.equal(repo.push.state, 'unknown');
  assert.equal(repo.ci.state, 'unknown');
  assert.equal(repo.cd.state, 'unknown');
  assert.equal(repo.cd.total, 0);
  assert.deepEqual(repoComputerInstalls(repoFlowModel(activity), 'c-local'), []);
});

test('CD uses explicit target receipts including offline and approval-waiting shares', () => {
  const model = repoFlowModel(fixture()), cd = model.repositories[0].cd;
  assert.equal(cd.installed, 1); assert.equal(cd.total, 3); assert.equal(cd.fraction, 1 / 3); assert.equal(cd.pending, true);
  assert.equal(model.repositories[1].cd.fraction, 0.5);
  const updated = fixture(); Object.assign(updated.repositories[0].flow.cd.targets[1], {state: 'succeeded', sha: 'a1b2c3d'});
  assert.equal(repoFlowModel(updated).repositories[0].cd.fraction, 2 / 3);
  assert.equal(cd.fraction, 1 / 3, 'normalization does not mutate prior snapshots');
  assert.equal(repoDeployment({state: 'succeeded'}).fraction, 1);
  assert.equal(repoDeployment({progress: 100}).fraction, 0, 'an unsupported percentage is not an observation');
  const older = fixture(); older.repositories[0].flow.cd.targets[0].sha = '1111111';
  assert.equal(repoFlowModel(older).repositories[0].cd.fraction, 0, 'an old installation does not fill the new revision');
});

test('AWS rows require an explicit AWS provider on a company repository', () => {
  const activity = fixture();
  assert.deepEqual(repoFlowModel(activity).clouds.map(cloud => cloud.name), ['Example Org']);
  activity.repositories[1].flow.provider = undefined;
  assert.equal(repoFlowModel(activity).clouds.length, 0);
  activity.repositories[0].flow.provider = 'aws';
  assert.equal(repoFlowModel(activity).clouds.length, 0, 'a personal account is not reclassified as a company');
});

test('PC receipts join only explicit computer identities', () => {
  const model = repoFlowModel(fixture());
  assert.deepEqual(repoComputerInstalls(model, 'c-local').map(item => [item.repoName, item.sha, item.state]), [['theme', 'a1b2c3d', 'succeeded']]);
  assert.equal(repoComputerInstalls(model, 'c-off')[0].state, 'offline');
  assert.deepEqual(repoComputerInstalls(model, 'pc-a'), [], 'a target name is not a computer identity');
  assert.deepEqual(repoComputerInstalls(model, null), []);
  assert.equal(repoFlowModel(model), model, 'one prepared model can be shared by all PC rows and the section');
});

test('quiet rows fold only when the producer explicitly says quiet', () => {
  const model = repoFlowModel(fixture());
  assert.deepEqual(repoFlowRows(model).repositories.map(item => item.id), ['theme', 'api']);
  assert.equal(repoFlowRows(model).hidden, 1);
  assert.equal(repoFlowRows(model, true).repositories.length, 3);
});

test('malformed optional rows and duplicate identities cannot crash or inflate totals', () => {
  const activity = fixture();
  activity.repositories.push(null, {}, {...activity.repositories[0]}, {id: 'bad', name: 'missing account', account_id: 'nope'});
  activity.repositories[0].flow.cd.targets.push(null, {}, receipt('pc-a', 'succeeded'), receipt(' whitespace ', 'succeeded'));
  const model = repoFlowModel(activity);
  assert.equal(model.repositories.length, 3);
  assert.equal(model.repositories[0].cd.total, 3);
  assert.equal(repoStage({state: 'PASS', sha: 'not-a-revision'}).state, 'unknown');
  assert.equal(repoStage({state: '__proto__'}).state, 'unknown');
  assert.equal(repoStage({state: 'succeeded', detail: 'a\nb', sha: 'bad'}).detail, 'a b');
  assert.equal(repoStage({state: 'succeeded', sha: {toString() {throw Error('malformed')}}}).sha, '');
});

// Exercise the actual GPUI drawing functions, capturing geometry and native
// operations without running an application or changing focus.
function element() {
  const target = {calls: [], nodes: []};
  let proxy;
  proxy = new Proxy(target, {get(node, name) {
    if (name in node) return node[name];
    if (name === 'then') return undefined;
    return (...args) => {
      if (name === 'child') node.nodes.push(args[0]);
      else if (name === 'children') node.nodes.push(...args[0]);
      else node.calls.push([name, ...args]);
      return proxy;
    };
  }});
  return proxy;
}
const source = (await readFile(new URL('../mods/sixfold-desk/repo-flow-view.js', import.meta.url), 'utf8'))
  .replace(/import \{div, (?:svg|image)\} from 'gpui-kit';/, 'const {div,svg,image}=globalThis.__repoFlowRuntime;')
  .replace("import {h_flex, v_flex} from 'gpui-base';", 'const {h_flex,v_flex}=globalThis.__repoFlowRuntime;')
  .replace("'./repo-flow-model.js'", JSON.stringify(new URL('../mods/sixfold-desk/repo-flow-model.js', import.meta.url).href));
globalThis.__repoFlowRuntime = {div: element, svg: path => element().mask(path), image: path => element().image(path), h_flex: element, v_flex: element};
const {renderRepoFlow, mountRepoFlow, repoComputerChips, repoFlowRow, repoStageCell, repoFlowHeight} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
delete globalThis.__repoFlowRuntime;
const t = {foreground: '#eee', muted: '#aab', dim: '#678', surface: '#123'};
const walk = node => node && typeof node === 'object' ? [node, ...node.nodes.flatMap(walk)] : [];
const value = (node, name) => node.calls.find(call => call[0] === name)?.[1];
const find = (node, id) => walk(node).find(item => value(item, 'id') === id);

test('render reserves 84px for square PUSH/CI/CD cells and shows a single CD fill', () => {
  const section = renderRepoFlow(fixture(), t), nodes = walk(section);
  assert(find(section, 'repo-flow-repository-theme'));
  assert(!find(section, 'repo-flow-repository-notes'));
  assert(nodes.some(node => value(node, 'w') === G.stages));
  const cd = find(section, 'repo-flow-stage-theme-cd'), fill = find(cd, 'repo-flow-fill-theme-cd');
  assert.equal(value(cd, 'w'), 22);
  assert.equal(value(fill, 'w'), 7, 'one third of the 20px interior, not three separate cells');
  assert(cd.calls.some(call => call[0] === 'border_dashed'));
  assert.equal(walk(cd).filter(node => value(node, 'id') === 'repo-flow-fill-theme-cd').length, 1);
  assert(!walk(section).some(node => node.calls.some(call => ['loop', 'spin', 'frames'].includes(call[0]))));
});

test('missing and absent stages have empty slots, while explicit failed CI is red', () => {
  for (const state of ['none', 'unknown']) {
    const cell = repoStageCell('CI', {state}, t);
    assert.equal(cell.nodes.length, 0);
    assert.equal(value(cell, 'w'), 22);
  }
  const model = repoFlowModel(fixture()), row = repoFlowRow(model.repositories[1], t);
  const ci = find(row, 'repo-flow-stage-api-ci');
  assert(walk(ci).some(node => value(node, 'bg') === '#e77777'));
  assert.match(value(ci, 'tooltip'), /실패/);
});

test('AWS logo preserves source colors and gated environment chips use the explicit company row', async () => {
  const section = renderRepoFlow(fixture(), t), cloud = find(section, 'repo-flow-cloud-company');
  assert(cloud);
  assert(walk(cloud).some(node => value(node, 'image') === 'mods/sixfold-desk/repo-flow-aws.svg'));
  assert(!walk(cloud).some(node => value(node, 'mask') === 'mods/sixfold-desk/repo-flow-aws.svg'));
  assert(find(cloud, 'repo-flow-environment-api-prod').calls.some(call => call[0] === 'border_dashed'));
  const asset = await readFile(new URL('../mods/sixfold-desk/repo-flow-aws.svg', import.meta.url), 'utf8');
  assert.match(asset, /viewBox="0 26 128.4 76"/);
  assert.match(asset, /#FF9900/);
});

test('mount toggles quiet rows locally, stops propagation and preserves layout heights', () => {
  const view = {}, cx = {stopped: 0, notified: 0, stop_propagation() {this.stopped++;}, notify() {this.notified++;}};
  const section = mountRepoFlow(view, {repo_flow: fixture()}, t, cx), button = find(section, 'repo-flow-toggle');
  value(button, 'on_click')({}, cx);
  assert.equal(cx.stopped, 1); assert.equal(cx.notified, 1); assert.equal(view.repoFlowExpanded, true);
  const expanded = mountRepoFlow(view, fixture(), t, cx);
  assert(find(expanded, 'repo-flow-repository-notes'));
  assert.equal(repoFlowHeight(fixture(), true) - repoFlowHeight(fixture()), G.row);
  assert.equal(repoFlowHeight({}), 0); assert.equal(renderRepoFlow({}, t), null);
});

test('computer chips distinguish installed, running, and offline; never fabricate a receipt', () => {
  const local = repoComputerChips(fixture(), 'c-local', t);
  assert.match(value(find(local, 'repo-flow-install-theme-pc-a'), 'tooltip'), /a1b2c3d ✓/);
  const off = repoComputerChips(fixture(), 'c-off', t);
  assert.match(value(find(off, 'repo-flow-install-theme-pc-c'), 'tooltip'), /꺼짐/);
  assert(find(off, 'repo-flow-install-theme-pc-c').calls.some(call => call[0] === 'border_dashed'));
  assert.equal(repoComputerChips(fixture(), 'unobserved', t), null);
});
