import test from 'node:test';
import assert from 'node:assert/strict';
import { bandModel, clip, fitCell, fitLine, chipWidth, BAND } from '../mods/week-timeline/summary.js';
const today = '2026-11-11';
const item = (key, extra = {}) => ({ key, title: key, status: 'Todo', state: 'todo', start: '', due: '', parent: '', ...extra });
const feedOf = issues => ({ week: { start: '2026-11-09', end: '2026-11-15' }, projects: [{ key: 'ALP', name: 'Alpha', milestones: [{ id: 'm1', target: '2026-11-14' }], issues }] });

test('deadline chips go to their day; late work, even from last week, leads Monday or its own day', () => {
  const m = bandModel(feedOf([
    item('DEMO-1', { due: '2026-11-13' }),
    item('DEMO-2', { due: '2026-11-05' }),
    item('DEMO-3', { due: '2026-11-09', state: 'started' }),
    item('DEMO-4', { due: today }),
    item('DEMO-5', { due: '2026-11-12' }),
    item('DEMO-6', { state: 'started', milestone: 'm1', parent: 'DEMO-90' }),   // milestone date stands in
    item('DEMO-7', { due: '2026-11-10' }),
  ]), { today });
  assert.deepEqual(m.days.map(d => d.items.map(c => c.key)), [['DEMO-2', 'DEMO-3'], ['DEMO-7'], ['DEMO-4'], ['DEMO-5'], ['DEMO-1'], ['DEMO-6'], []]);
  assert.deepEqual(m.days.map(d => d.items.map(c => c.tone)), [['late', 'late'], ['late'], ['soon'], ['soon'], ['todo'], ['started'], []]);
  assert.equal(m.days[2].label, '수 11/11 오늘');
  assert.deepEqual([m.due, m.ongoing.length, m.total, m.range], [7, 0, 7, '11/9 – 11/15']);
});

test('진행 중 line: started or in-review work dated after this week, or undated, in processing order', () => {
  const m = bandModel(feedOf([
    item('DEMO-1', { state: 'review', due: '2026-12-03' }),
    item('DEMO-2', { state: 'started', due: '2026-11-24' }),
    item('DEMO-3', { state: 'started', parent: 'DEMO-90' }),
    item('DEMO-5', { state: 'started' }),           // a loose undated issue: the dialog leaves it out too
    item('DEMO-4', { due: '2026-11-30' }),          // todo outside the week: not selected at all
  ]), { today });
  assert.deepEqual(m.ongoing.map(c => [c.key, c.due, c.tone]), [['DEMO-2', '11/24', 'started'], ['DEMO-1', '12/3', 'review'], ['DEMO-3', '', 'started']]);
  assert.equal(m.due, 0);
});

test('an empty or missing feed is an empty week', () => {
  for (const feed of [feedOf([]), null]) {
    const m = bandModel(feed, { today });
    assert.equal(m.days.length, 7);
    assert.equal(m.total, 0);
  }
});

test('titles are cut with an ellipsis', () => {
  assert.equal(clip('신청 API를 번호 직접 입력·수신 동의 방식으로 변경'), '신청 API를 번호 직접…');
  assert.equal(clip('짧은 제목'), '짧은 제목');
  assert.equal(clip('', 3), '');
});

test('a crowded day folds into +N; an unmeasured cell shows everything', () => {
  assert.deepEqual(fitCell(3, 0), { shown: 3, more: 0 });
  assert.deepEqual(fitCell(1, 120), { shown: 1, more: 0 });
  assert.deepEqual(fitCell(2, 221), { shown: 1, more: 1 });   // two chips never squeeze their titles away
  assert.deepEqual(fitCell(2, 270), { shown: 2, more: 0 });
  assert.deepEqual(fitCell(4, 330), { shown: 2, more: 2 });
  assert.deepEqual(fitCell(2, 60), { shown: 0, more: 2 });
});

test('the 진행 중 line keeps one row and folds the rest into +N', () => {
  const chips = ['A', 'B', 'C', 'D'].map(k => ({ key: `DEMO-${k}` }));
  const w = () => 100;
  assert.deepEqual(fitLine(chips, 0, w).more, 0);
  assert.equal(fitLine(chips, 415, w).more, 0);
  const r = fitLine(chips, 300, w);
  assert.deepEqual([r.shown.map(c => c.key), r.more], [['DEMO-A', 'DEMO-B'], 2]);
  assert.ok(chipWidth({ key: 'DEMO-1', title: '부하 시험 도구', due: '11/24' }) > chipWidth({ key: 'DEMO-1', title: '부하' }));
  // The default measure gets the chip alone, not map's index as a font size.
  const real = Array.from({ length: 8 }, (_, i) => ({ key: `DEMO-${20 + i}`, title: '부하 시험 도구 안전장치', due: '11/24' }));
  const folded = fitLine(real, 1000);
  assert.ok(folded.more > 0 && folded.shown.length >= 3, JSON.stringify([folded.shown.length, folded.more]));
  assert.equal(BAND.head + BAND.due + BAND.line + 2, BAND.height);
});
