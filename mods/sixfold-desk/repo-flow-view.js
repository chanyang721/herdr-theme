import {div, image} from 'gpui-kit';
import {h_flex, v_flex} from 'gpui-base';
import {repoFlowModel, repoFlowRows, repoComputerInstalls, REPO_FLOW_GEOMETRY as G} from './repo-flow-model.js';

const text = (value, color, size = 10) => div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const stateLabels = {waiting: '대기', running: '진행 중', succeeded: '완료', failed: '실패', offline: '꺼짐', unknown: '없음', none: '없음'};
const tone = (state, t) => state === 'failed' ? t.error || '#e77777' : state === 'succeeded' ? t.done || '#8fe3b0' : state === 'running' ? t.blocked || '#e9c46a' : t.dim || t.muted;
const stageTip = (name, stage) => [name, stateLabels[stage.state], stage.sha?.slice(0, 7), stage.detail].filter(Boolean).join(' · ');

// Five-row pixel letters keep the three fixed labels crisp without relying
// on a machine-specific font installation or a network font download.
const LETTERS = {P: ['110', '101', '110', '100', '100'], U: ['101', '101', '101', '101', '111'],
  S: ['111', '100', '111', '001', '111'], H: ['101', '101', '111', '101', '101'],
  C: ['111', '100', '100', '100', '111'], I: ['111', '010', '010', '010', '111'], D: ['110', '101', '101', '101', '110']};
function pixelWord(word, color) {
  const letters = div().relative().w(word.length * 4 - 1).h(5);
  [...word].forEach((letter, index) => LETTERS[letter].forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel === '1') letters.child(div().absolute().left(index * 4 + x).top(y).size(1).bg(color));
  })));
  return letters;
}

// Pixel corners: four one-pixel strips with the corner pixels removed. No
// rounded rectangle, glow, loop, or per-frame observer is needed.
function frame(box, width, height, color, dashed = false) {
  if (dashed) return box.border(1).border_dashed().border_color(color);
  return box
    .child(div().absolute().left(1).top(0).w(width - 2).h(1).bg(color))
    .child(div().absolute().left(1).bottom(0).w(width - 2).h(1).bg(color))
    .child(div().absolute().left(0).top(1).w(1).h(height - 2).bg(color))
    .child(div().absolute().right(0).top(1).w(1).h(height - 2).bg(color));
}

export function repoStageCell(name, stage, t, {id = name, width = 22, fraction = null, pending = false} = {}) {
  const box = div().id(`repo-flow-stage-${id}`).relative().flex_none().w(width).h(G.cell).overflow_hidden();
  // Missing data keeps the reserved slot empty. "No CI" and "unknown CI"
  // must never look like a passed CI run.
  if (['unknown', 'none'].includes(stage.state)) return box.tooltip(stageTip(name, stage));
  const color = name === 'PUSH' && stage.state === 'succeeded' ? t.blocked || '#e9c46a' : tone(stage.state, t);
  const waiting = pending || ['waiting', 'offline'].includes(stage.state);
  frame(box, width, G.cell, color, waiting);
  const filled = stage.state === 'failed' ? 1 : fraction === null ? 0 : Math.max(0, Math.min(1, fraction));
  if (filled > 0) box.child(div().id(`repo-flow-fill-${id}`).absolute().left(1).top(1).h(G.cell - 2).w(Math.round((width - 2) * filled)).bg(color).opacity(stage.state === 'failed' ? 1 : 0.3));
  return box.tooltip(stageTip(name, stage)).accessibility_label(stageTip(name, stage))
    .child(h_flex().absolute().left(0).top(0).w(width).h(G.cell).items_center().justify_center()
      .child(pixelWord(name, stage.state === 'failed' ? t.surface || '#10161d' : color)));
}

function ownerIcon(repo, t) {
  if (repo.account.kind === 'company') return div().relative().w(10).h(10).flex_none().tooltip(`회사 조직 ${repo.account.name}`)
    .child(div().absolute().left(0).top(0).w(6).h(10).bg(t.muted))
    .child(div().absolute().left(6).top(3).w(4).h(7).bg(t.dim));
  return v_flex().w(10).h(10).flex_none().items_center().tooltip(repo.account.name)
    .child(div().size(4).rounded(2).bg(t.muted)).child(div().w(8).h(5).mt(1).rounded(2).bg(t.muted));
}

function lockIcon(t) {
  return div().relative().w(7).h(9).flex_none().tooltip('비공개 레포').accessibility_label('비공개 레포')
    .child(div().absolute().left(1).top(0).w(5).h(5).border(1).border_color(t.dim).rounded(2))
    .child(div().absolute().left(0).bottom(0).w(7).h(5).bg(t.dim));
}

export function repoFlowRow(repo, t) {
  const commit = [repo.commit.issue, repo.commit.title, repo.commit.sha].filter(Boolean).join(' · ');
  const row = h_flex().id(`repo-flow-repository-${repo.id}`).h(G.row).w_full().min_w(0).flex_none().px(7).gap(5).items_center().rounded(4).bg(t.surface)
    .child(ownerIcon(repo, t));
  const title = h_flex().min_w(0).flex_1().gap(4).items_center()
    .child(text(repo.name, t.foreground, 11).font_bold().max_w(68).flex_1().tooltip([repo.namespace, repo.name].filter(Boolean).join('/')));
  if (repo.private) title.child(lockIcon(t));
  // The producer supplies the issue association. Names and folder bindings do
  // not establish the origin of a commit.
  if (repo.commit.sha && !repo.commit.issue) title.child(text('?', t.muted, 9).flex_none().tooltip('이슈 번호 없음 — 어느 작업에서 왔는지 모름'));
  title.child(text([repo.commit.issue, repo.commit.title].filter(Boolean).join(' · '), t.muted, 9).flex_1().tooltip(commit));
  row.child(title);
  return row.child(h_flex().w(G.stages).flex_none().gap(G.gap).items_center()
    .child(repoStageCell('PUSH', repo.push, t, {id: `${repo.id}-push`, width: G.push}))
    .child(repoStageCell('CI', repo.ci, t, {id: `${repo.id}-ci`, width: G.ci}))
    .child(repoStageCell('CD', repo.cd, t, {id: `${repo.id}-cd`, width: G.cd, fraction: repo.cd.fraction, pending: repo.cd.pending})
      .tooltip([stageTip('CD', repo.cd), repo.cd.total ? `${repo.cd.installed}/${repo.cd.total}` : '', ...repo.cd.targets.map(target => `${target.name || target.environment || '대상'}: ${stateLabels[target.state]}`)].filter(Boolean).join(' · '))));
}

export function repoCloudRow(cloud, t) {
  const row = h_flex().id(`repo-flow-cloud-${cloud.id}`).h(G.cloud).w_full().min_w(0).flex_none().px(7).gap(6).items_center()
    .child(div().relative().w(14).h(14).flex_none().tooltip('AWS').accessibility_label('AWS')
      .child(image('mods/sixfold-desk/repo-flow-aws.svg').absolute().left(-2).top(1).w(19).h(11).bg('#18222f')))
    .child(text(cloud.name, t.foreground, 11).font_bold().flex_1());
  const targets = cloud.repositories.flatMap(repo => repo.cd.targets.filter(item => item.environment).map(target => ({repo, target})));
  const details = targets.map(({repo, target}) => `${repo.name} · ${target.environment} · ${stateLabels[target.state]}`).join('\n');
  row.tooltip(details);
  for (const {repo, target} of targets.slice(0, 2)) {
    const title = `${repo.name} · ${target.environment} · ${stateLabels[target.state]}${target.sha ? ` · ${target.sha.slice(0, 7)}` : ''}`;
    const chip = text(target.environment, tone(target.state, t), 8).id(`repo-flow-environment-${repo.id}-${target.id}`).flex_1().max_w(48).px(4).h(13)
      .tooltip(title).accessibility_label(title).border(1).border_color(tone(target.state, t));
    if (['waiting', 'offline'].includes(target.state)) chip.border_dashed();
    row.child(chip);
  }
  if (targets.length > 2) row.child(text(`+${targets.length - 2}`, t.muted, 9).flex_none().tooltip(details));
  return row;
}

export function repoComputerChips(activity, computer, t) {
  const installs = repoComputerInstalls(repoFlowModel(activity), computer).filter(target => !['unknown', 'none'].includes(target.state));
  if (!installs.length) return null;
  const chips = h_flex().id(`repo-flow-installs-${computer}`).min_w(0).gap(4).items_center();
  for (const target of installs.slice(0, 1)) {
    const summary = target.state === 'succeeded' ? [target.repoName, target.sha.slice(0, 7), '✓'].filter(Boolean).join(' ') : `${target.repoName} · ${stateLabels[target.state]}`;
    const title = [summary, target.detail].filter(Boolean).join(' · ');
    const chip = text(summary, tone(target.state, t), 9).id(`repo-flow-install-${target.repository}-${target.id}`).h(14).px(4).max_w(142).flex_1()
      .tooltip(title).accessibility_label(title).border(1).border_color(tone(target.state, t));
    if (['waiting', 'offline'].includes(target.state)) chip.border_dashed();
    chips.child(chip);
  }
  if (installs.length > 1) chips.child(text(`+${installs.length - 1}`, t.muted, 9).flex_none().tooltip(installs.map(target => `${target.repoName} · ${stateLabels[target.state]} · ${target.sha.slice(0, 7)}`).join('\n')));
  return chips;
}

export function repoFlowHeight(activity, expanded = false) {
  const model = repoFlowModel(activity), rows = repoFlowRows(model, expanded);
  return model.repositories.length ? model.clouds.length * G.cloud + G.heading + rows.repositories.length * G.row + (rows.quiet ? G.heading : 0) : 0;
}

// Mount directly after COMPUTERS and before SPACES. PC chips belong in the
// existing computer rows via repoComputerChips; this section never duplicates
// those rows or changes selection/focus.
export function renderRepoFlow(activity, t, {expanded = false, onToggle} = {}) {
  const model = repoFlowModel(activity);
  if (!model.repositories.length) return null;
  const rows = repoFlowRows(model, expanded), section = v_flex().id('repo-flow').w_full().min_w(0).flex_none();
  for (const cloud of model.clouds) section.child(repoCloudRow(cloud, t));
  section.child(h_flex().h(G.heading).items_center().child(text('REPOS', t.dim, 10).font_bold()));
  for (const repo of rows.repositories) section.child(repoFlowRow(repo, t));
  if (rows.quiet) section.child(text(expanded ? '접기' : `+${rows.hidden} · 이번 주 조용한 레포 (펼치기)`, t.dim, 9)
    .id('repo-flow-toggle').h(G.heading).cursor_pointer().on_click((event, cx) => {cx.stop_propagation(); onToggle?.(event, cx);}));
  return section;
}

export function mountRepoFlow(view, activity, t, cx) {
  return renderRepoFlow(activity, t, {expanded: view.repoFlowExpanded === true,
    onToggle: () => {view.repoFlowExpanded = !view.repoFlowExpanded; cx.notify();}});
}
