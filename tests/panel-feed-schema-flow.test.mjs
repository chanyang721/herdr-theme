import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validate} from './schema-subset-validate.mjs';

const schema = JSON.parse(await readFile(new URL('../schemas/herdr/panel-feed.schema.json', import.meta.url), 'utf8'));
const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const activity = () => ({
  schema: 'repo_activity_v1',
  accounts: [{id: 'ns-demo', name: 'demo', kind: 'personal', connection: 'unknown', source: 'private_catalog'}],
  repositories: [
    {id: 'r-demo-app', account_id: 'ns-demo', namespace: 'demo', name: 'demo-app', private: true, quiet: false,
      flow: {commit: {sha, title: '데모 커밋', issue: ''}, push: {state: 'waiting', detail: 'DEMO 3커밋 push 전', sha},
        ci: {state: 'none', detail: 'CI 없음', sha},
        cd: {state: 'succeeded', detail: 'DEMO 설치 기록', targets: [
          {id: 'pc-demo', name: '이 PC', computer: 'c-demo', environment: 'app', state: 'succeeded', sha, detail: 'DEMO'}]},
        provider: 'aws', futureField: {kept: true}}},
    {id: 'r-demo-old', account_id: 'ns-demo', namespace: 'demo', name: 'demo-old'}
  ],
  bindings: [], events: [],
  coverage: {state: 'gap', sensor: 'opt_in_callback', live_connected: false, gaps: ['callback_sensor_off', 'deployments']}
});
const feed = extra => ({v: 1, at: 1, computers: [], spaces: [], ...extra});

test('a feed carrying stages and repo_flow passes the schema', () => {
  assert.deepEqual(validate(schema, feed({repo_activity: activity(), repo_flow: activity()})), []);
});

test('feeds without stages, with the earlier repository shape, still pass', () => {
  const old = activity();
  old.repositories = [{id: 'r1', account_id: 'ns-demo', namespace: 'demo', name: 'demo'}];
  old.coverage = {state: 'gap', sensor: 'opt_in_callback', live_connected: false, gaps: ['remote_effects']};
  assert.deepEqual(validate(schema, feed({repo_activity: old})), []);
  assert.deepEqual(validate(schema, feed()), []);
});

test('stage values the consumer cannot read are rejected', () => {
  const bad = activity();
  bad.repositories[0].flow.push.state = 'pending';
  assert.notDeepEqual(validate(schema, feed({repo_flow: bad})), []);
  const target = activity();
  target.repositories[0].flow.cd.targets[0].sha = 'not-a-hash';
  assert.notDeepEqual(validate(schema, feed({repo_flow: target})), []);
  assert.notDeepEqual(validate(schema, feed({repo_flow: {...activity(), schema: 'other'}})), []);
});
