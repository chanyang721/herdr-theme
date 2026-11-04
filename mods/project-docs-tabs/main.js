import { View, div, image } from 'gpui-kit';
import { v_flex, h_flex, TextView, InputState, Input } from 'gpui-base';
import { props, appHome, readTextFile, exec, watchFolder, theme, settings, shared, setShared, spaces, panes } from 'herdr';
import { stageMarkdown } from './vendor/markdown.js';
import { dirname, resolveLink } from './vendor/paths.js';
import { mermaidFences, applyDiagrams } from './mermaid.js';
import { treeSections, kindCounts, shortDate } from './tree.js';

const LIMIT = 400000;
const STATE = 'sixfold.docs.selection.v1';
// scripts/open_doc_tab.py writes the latest open request; each space handles it once.
const REQUEST = 'project-docs-open.json';
const OPENED = 'sixfold.docs.opened.v1';
// Which tree sections each space keeps open, as the person last left them.
const TREE = 'sixfold.docs.tree.v1';
// Below this pane width the tree sits above the document instead of beside it.
const SIDE_BY_SIDE = 760;
const HARNESS_TAG = '하네스 생성물 · 읽기 전용';
const isHtml = path => /\.html?$/i.test(path);
const readable = path => /\.md$/i.test(path) || isHtml(path);
// Puts the file itself (as Finder Cmd+C does) or its UTF-8 text on the general pasteboard.
const MAC_COPY = String.raw`
ObjC.import('AppKit');
function run(args) {
  var path = args[0], board = $.NSPasteboard.generalPasteboard, text;
  if (!$.NSFileManager.defaultManager.isReadableFileAtPath($(path))) throw new Error('파일을 읽을 수 없습니다.');
  if (args[1] === 'text') {
    text = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    if (text.isNil()) throw new Error('UTF-8 본문을 읽을 수 없습니다.');
  }
  board.clearContents;
  var ok = text ? board.setStringForType(text, $.NSPasteboardTypeString) : board.writeObjects($([$.NSURL.fileURLWithPath($(path))]));
  if (!ok) throw new Error('클립보드에 넣지 못했습니다.');
  return 'ok';
}`;
// Finds the default web browser (the https handler), so HTML opens there even when
// .html files are set to open in an editor.
const MAC_BROWSER = String.raw`
ObjC.import('AppKit');
function run() {
  var app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com'));
  return app.isNil() ? '' : app.path.js;
}`;
// Same steps as render_html.py, so a pane resize re-renders only at 40px steps; rounding
// down keeps the picture at 1:1 instead of shrinking it a little.
export const htmlWidth = width => Math.min(2000, Math.max(320, Math.floor(width / 40) * 40));
export default class ProjectDocuments extends View {
  init(_props, cx) {
    const p = props() || {};
    this.spaceId = p.spaceId;
    this.script = p.resolverScript || `${appHome()}/data/sixfold/doc-tabs/resolve_doc_pins.py`;
    this.config = p.pinsConfig || `${appHome()}/data/sixfold/project-docs-pins.json`;
    this.mermaidScript = p.mermaidScript || `${appHome()}/data/sixfold/doc-tabs/render_mermaid.py`;
    this.htmlScript = p.htmlScript || `${appHome()}/data/sixfold/doc-tabs/render_html.py`;
    this.documents = []; this.watchers = new Map(); this.generation = 0;
    this.selected = shared(STATE)?.[this.spaceId]; this.width = 800; this.paneWidth = 1200;
    this.kinds = []; this.harness = null; this.kindFilter = null; this.showArchive = false; this.treeHidden = false;
    this.families = new Set(); this.query = '';
    // Retained input state is made here, never while rendering.
    this.search = InputState?.new ? InputState.new({ placeholder: '이름·종류 검색' }) : null;
    this.search?.on('change', (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.search?.on('submit', (_e, cx) => { const first = this.visibleRows()[0]; if (first) this.choose(first.aliasOf || first.id, cx); });
    // A 열람 tab's id carries its path, so it survives a reload of this mod.
    if (this.selected?.startsWith('opened-')) this.reveal(this.selected.slice('opened-'.length));
    this.refresh(cx);
    cx.timer.every(5000, cx => this.refresh(cx));
  }

  invoke(args = []) { return exec('python3', [this.script, '--config', this.config, '--space', this.spaceId, ...args]); }

  refresh(cx) {
    if (!this.spaceId || this.closed) return;
    if (this.refreshing) { this.refreshPending = true; return; }
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        const result = await this.invoke();
        if (this.closed) return;
        if (result.code !== 0) throw Error(result.stderr.trim() || result.stdout.trim() || '문서 목록 확인 실패');
        const data = JSON.parse(result.stdout);
        if (!Array.isArray(data.documents) || data.spaceId !== this.spaceId) throw Error('문서 목록 형식을 확인하세요.');
        this.documents = data.documents.slice();
        this.kinds = Array.isArray(data.kinds) ? data.kinds : []; this.harness = data.harness || null; this.recentDays = data.recentDays || 7;
        this.warnings = data.warnings || []; this.listError = null;
        if (this.linked) {
          const pinned = this.documents.find(d => d.path === this.linked.path);
          if (pinned) {
            if (this.selected === this.linked.id) this.selected = pinned.id;
            this.linked = null;
          } else this.documents.push(this.linked);
        }
        const saved = await readTextFile(`${dirname(this.config)}/${REQUEST}`).then(text => text ? JSON.parse(text) : null).catch(() => null);
        if (this.closed) return;
        // Version 2 keeps one request per space; version 1 held only the latest one.
        const request = saved?.requests ? saved.requests[this.spaceId] : saved?.spaceId === this.spaceId ? saved : null;
        if (typeof request?.path === 'string' && request.at > (shared(OPENED)?.[this.spaceId] ?? 0)) {
          setShared(OPENED, { ...(shared(OPENED) || {}), [this.spaceId]: request.at });
          this.reveal(request.path);
        }
        this.checkedAt = data.checkedAt;
        if (!this.documents.some(d => d.id === this.selected)) this.selected = this.documents.find(d => !d.aliasOf && d.state !== 'archived')?.id;
        if (this.selected && shared(STATE)?.[this.spaceId] !== this.selected) {
          setShared(STATE, { ...(shared(STATE) || {}), [this.spaceId]: this.selected });
        }
        this.watch([dirname(this.config), ...(data.watchRoots || [])], cx);
        this.load(cx);
      } catch (error) { if (!this.closed) this.listError = String(error.message || error); }
      finally {
        this.refreshing = false;
        if (!this.closed) {
          cx.notify();
          if (this.refreshPending) { this.refreshPending = false; this.refresh(cx); }
        }
      }
    });
  }

  watch(roots, cx) {
    for (const root of new Set(roots)) {
      if (this.watchers.has(root)) continue;
      const token = {}; this.watchers.set(root, token);
      cx.spawn(async cx => {
        try {
          while (!this.closed && this.watchers.get(root) === token) {
            const changed = await watchFolder(root);
            if (this.closed || this.watchers.get(root) !== token) return;
            // Ignore our installer lock and unrelated generated data in this
            // folder; otherwise a refresh can trigger its own next refresh.
            if (root === dirname(this.config) && !changed.some(path => path === root || path.endsWith('/' + this.config.split('/').pop()) || path.endsWith('/' + REQUEST))) continue;
            this.refresh(cx);
          }
        } catch { this.watchers.delete(root); }
      });
    }
  }

  choose(id, cx) {
    id = this.documents.find(d => d.id === id)?.aliasOf || id;
    this.selected = id; this.copied = null;
    setShared(STATE, { ...(shared(STATE) || {}), [this.spaceId]: id });
    this.load(cx); this.refresh(cx); cx.notify();
  }

  load(cx) {
    const doc = this.documents.find(d => d.id === this.selected);
    const key = doc ? (!doc.path && this.lastId === doc.id ? this.bodyKey : `${doc.id}:${doc.path}`) : null;
    if (this.bodyKey !== key) {
      this.bodyKey = key; this.blocks = null; this.bodyText = null; this.bodyError = null; this.html = null;
      this.lastSuccess = null; this.newVersion = Boolean(this.lastPath && doc?.path && this.lastPath !== doc.path && this.lastId === doc.id);
    }
    const generation = ++this.generation;
    this.loading = false;
    if (!doc || doc.status !== 'ok') { this.bodyError = doc?.error || doc?.status || null; return; }
    this.lastPath = doc.path; this.lastId = doc.id;
    this.watch([dirname(doc.path)], cx);
    if (!readable(doc.path)) { this.blocks = null; this.bodyError = null; return; }
    this.loading = true;
    cx.spawn(async cx => {
      const current = () => !this.closed && this.generation === generation && this.bodyKey === key;
      try {
        const text = await readTextFile(doc.path);
        if (!current()) return;
        if (text === null) throw Error('파일을 읽을 수 없습니다.');
        if (text.includes('\0')) throw Error('텍스트 문서가 아닙니다.');
        const look = `${settings()?.dark ? 'dark' : 'light'}:${theme().canvas}`;
        if (isHtml(doc.path)) {
          // Rendered at the pane's own width so text keeps its size instead of being scaled down.
          const width = htmlWidth(this.width - 40);
          if (text !== this.bodyText || look !== this.diagramLook || width !== this.html?.width) {
            const html = await this.page(doc.path, look, width);
            if (!current()) return;
            this.bodyText = text; this.diagramLook = look; this.blocks = html.blocks; this.html = html; this.imageWarning = null; this.truncated = false;
          }
          this.bodyError = null; this.lastSuccess = Date.now();
          return;
        }
        // Rendered diagrams are cached by code and look, so only file images force a restage.
        if (text !== this.bodyText || look !== this.diagramLook || this.blocks?.some(block => block.media && !block.diagram) || this.imageWarning) {
          const body = text.slice(0, LIMIT);
          const staged = await stageMarkdown(body, { file: doc.path, root: dirname(doc.path), on: null });
          if (!current()) return;
          const diagrams = await this.diagrams(body, doc.path, look);
          if (!current()) return;
          this.bodyText = text; this.diagramLook = look; this.blocks = applyDiagrams(staged.blocks, diagrams); this.imageWarning = staged.unavailable;
          this.watch(staged.files.map(dirname), cx);
          this.truncated = text.length > LIMIT;
        }
        this.bodyError = null; this.lastSuccess = Date.now();
      } catch (error) { if (current()) this.bodyError = String(error.message || error); }
      finally { if (current()) { this.loading = false; cx.notify(); } }
    });
  }

  async diagrams(text, path, look) {
    const result = new Map();
    this.diagramError = null;
    if (!mermaidFences(text).length) return result;
    try {
      const [mode, background] = look.split(':');
      const run = await exec('python3', [this.mermaidScript, '--doc', path, '--theme', mode, '--background', /^#[0-9a-f]{6}$/i.test(background) ? background : '#ffffff']);
      const data = JSON.parse(run.stdout || '{}');
      if (run.code !== 0 || data.error) throw Error(data.error || run.stderr.trim() || 'Mermaid 렌더링 실패');
      const failed = [];
      for (const d of data.diagrams || []) d.path ? result.set(d.code, { path: d.path, width: d.width, height: d.height }) : failed.push(d.error);
      if (failed.length) this.diagramError = `Mermaid ${failed.length}개는 코드로 표시: ${failed[0]}`;
    } catch (error) { this.diagramError = String(error.message || error); }
    return result;
  }

  // HTML reports are drawn by WebKit as the browser shows them, then laid out as image tiles.
  async page(path, look, width) {
    this.diagramError = null;
    const run = await exec('python3', [this.htmlScript, '--doc', path, '--theme', look.split(':')[0], '--width', String(width)]);
    let data = {};
    try { data = JSON.parse(run.stdout || '{}'); } catch {}
    if (run.code !== 0 || !Array.isArray(data.pages)) throw Error(data.error || run.stderr.trim() || 'HTML 렌더링 실패');
    return { blocks: data.pages.map(media => ({ media, diagram: true })), width,
      interactive: Array.isArray(data.interactive) ? data.interactive : [], truncated: Boolean(data.truncated) };
  }

  // Waits for the pane to stop resizing before drawing the HTML again at the new width.
  resized(cx) {
    const doc = this.documents.find(d => d.id === this.selected);
    if (!doc?.path || !isHtml(doc.path) || !this.html || htmlWidth(this.width - 40) === this.html.width) return;
    const token = this.resizeToken = {};
    cx.timer.after(400, cx => { if (!this.closed && this.resizeToken === token) this.load(cx); });
  }

  browser(path, cx) {
    cx.spawn(async cx => {
      try {
        const found = await exec('osascript', ['-l', 'JavaScript', '-e', MAC_BROWSER]);
        const app = found.code === 0 ? found.stdout.trim() : '';
        const result = await exec('open', app ? ['-a', app, path] : [path]);
        if (result.code !== 0) throw Error(result.stderr.trim() || '브라우저를 열지 못했습니다.');
        this.actionError = null;
      } catch (error) { this.actionError = `브라우저 열기 실패 · ${String(error.message || error)}`; }
      cx.notify();
    });
  }

  action(args, cx) {
    cx.spawn(async cx => {
      try {
        const result = await this.invoke(args);
        if (result.code !== 0) throw Error(result.stderr.trim() || result.stdout.trim());
        this.actionError = null; this.refresh(cx);
      } catch (error) { this.actionError = String(error.message || error); }
      cx.notify();
    });
  }

  external(command, args, cx) {
    cx.spawn(async cx => {
      try {
        const result = await exec(command, args);
        if (result.code !== 0) throw Error(result.stderr.trim() || '외부 앱을 열지 못했습니다.');
        this.actionError = null;
      } catch (error) { this.actionError = String(error.message || error); }
      cx.notify();
    });
  }

  copy(path, mode, cx) {
    cx.spawn(async cx => {
      try {
        const result = await exec('osascript', ['-l', 'JavaScript', '-e', MAC_COPY, path, mode]);
        if (result.code !== 0) throw Error(result.stderr.trim().replace(/^.*Error: /, '').replace(/ \(-?\d+\)$/, '') || '복사하지 못했습니다.');
        this.actionError = null; this.copied = `${mode === 'text' ? '본문' : '파일'} 복사됨 · ${path.split('/').pop()}`;
      } catch (error) { this.copied = null; this.actionError = `복사 실패 · ${String(error.message || error)}`; }
      cx.notify();
    });
  }

  // Close a 열람 row. Listed documents stay in the tree; pinned ones change with 고정 해제.
  dismiss(id, cx) {
    const doc = this.documents.find(d => d.id === id);
    if (!doc?.opened) return;
    this.linked = null;
    this.documents = this.documents.filter(d => d.id !== id);
    if (this.selected === id) this.choose(this.documents.find(d => !d.aliasOf && d.state !== 'archived')?.id, cx);
    else cx.notify();
  }

  treeOptions() {
    return { kinds: this.kinds, harness: this.harness, query: this.query, kind: this.kindFilter, archive: this.showArchive,
      open: shared(TREE)?.[this.spaceId] || {}, families: this.families, selected: this.selected };
  }

  // Documents in tree order, for Enter in the search box.
  visibleRows() {
    return treeSections(this.documents, this.treeOptions()).flatMap(s => s.rows).filter(r => r.doc).map(r => r.doc);
  }

  toggleSection(key, expanded, cx) {
    const all = shared(TREE) || {};
    setShared(TREE, { ...all, [this.spaceId]: { ...(all[this.spaceId] || {}), [key]: !expanded } });
    cx.notify();
  }

  toggleFamily(id, cx) {
    if (this.families.has(id)) this.families.delete(id); else this.families.add(id);
    cx.notify();
  }

  // Select a listed document, or show an unlisted one as a temporary 열람 tab.
  reveal(path) {
    const existing = this.documents.find(d => d.path === path);
    if (existing) { this.selected = existing.id; return; }
    this.linked = { id: `opened-${path}`, path, name: path.split('/').pop(),
      label: path.split('/').pop(), kind: 'file', status: 'ok', pinned: false, opened: true };
    this.documents = this.documents.filter(d => !d.opened).concat(this.linked);
    this.selected = this.linked.id;
  }

  follow(file, url, cx) {
    try {
      const link = resolveLink(file, url);
      if (link.url) cx.open_url(link.url);
      else if (link.file && readable(link.file)) {
        this.reveal(link.file);
        this.choose(this.selected, cx);
      } else if (link.file) this.external('open', [link.file], cx);
    } catch (error) { this.actionError = String(error.message || error); cx.notify(); }
  }

  renderTree(t, button) {
    const sections = treeSections(this.documents, this.treeOptions());
    const today = new Date();
    const chip = (id, label, on, action) => button(id, label, action).px(8).py(3).text_size(11)
      .bg(on ? t.selected : t.chrome).border(1).border_color(on ? t.accent : t.border);
    const counts = kindCounts(this.documents, this.kinds);
    const archived = this.documents.filter(d => d.state === 'archived').length;
    const row = r => {
      if (r.heading) return div().pl(18).pt(4).pb(1).flex_none().text_size(11).text_color(t.muted).truncate().child(r.heading);
      const d = r.doc, current = d.id === this.selected || (d.aliasOf && d.aliasOf === this.selected);
      const previous = d.state === 'previous' || d.state === 'archived';
      const kind = this.kinds.find(k => k.id === d.kind)?.label;
      let line = h_flex().id(`doc-${d.id}`).flex_none().min_w(0).h(26).pl(6 + r.depth * 16).pr(4).gap(6).items_center().rounded(4)
        .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.choose(d.id, cx))
        .border_l(2).border_color(current ? t.accent : t.canvas).bg(current ? t.selected : t.canvas)
        .tooltip([d.name || d.label, d.folder, d.path].filter(Boolean).join('\n'))
        .child(div().w(8).flex_none().text_size(9).text_color(t.accent).child(d.recent && !previous ? '●' : ''))
        .child(div().flex_1().min_w(0).truncate().text_color(previous ? t.muted : t.foreground)
          .when(current, el => el.font_semibold()).child(`${d.pinned ? '◆ ' : d.opened ? '열람 · ' : ''}${d.label}`))
        .when(Boolean(d.pinned && kind), el => el.child(div().flex_none().text_size(10).text_color(t.muted).child(kind)))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(shortDate(d.date, today)));
      if (r.versions) line = line.child(button(`doc-versions-${d.id}`, `${r.expanded ? '▾' : '▸'} 이전 ${r.versions}`,
        cx => this.toggleFamily(d.id, cx)).px(5).py(1).text_size(10).text_color(t.muted));
      if (d.opened) line = line.child(button(`doc-close-${d.id}`, '×', cx => this.dismiss(d.id, cx)).px(5).py(1).text_color(t.muted));
      return line;
    };
    return v_flex().id('docs-tree').min_w(0).min_h(0).gap(4)
      .child(h_flex().flex_none().gap(6).items_center().px(6)
        .when(Boolean(this.search), el => el.child(div().flex_1().min_w(0).child(Input.new(this.search).w_full().h(28).text_size(12))))
        .child(button('docs-query-clear', '지우기', cx => { this.search?.set_value(''); this.query = ''; cx.notify(); }).text_size(11).text_color(t.muted)))
      .child(h_flex().id('docs-kinds').flex_none().flex_wrap().gap(4).px(6)
        .child(chip('docs-kind-all', '전체', !this.kindFilter, cx => { this.kindFilter = null; cx.notify(); }))
        .children(counts.map(k => chip(`docs-kind-${k.id}`, `${k.label} ${k.count}`, this.kindFilter === k.id,
          cx => { this.kindFilter = this.kindFilter === k.id ? null : k.id; cx.notify(); })))
        .when(archived > 0, el => el.child(chip('docs-archive', `보관 ${archived}`, this.showArchive,
          cx => { this.showArchive = !this.showArchive; cx.notify(); }))))
      .child(v_flex().id('docs-tree-rows').flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8).gap(1)
        .when(!sections.length, el => el.child(div().px(8).py(6).text_size(12).text_color(t.muted)
          .child(this.query ? '검색과 맞는 문서가 없습니다.' : '표시할 문서가 없습니다.')))
        .children(sections.map(section => v_flex().flex_none().min_w(0)
          .child(h_flex().id(`docs-section-${section.key}`).flex_none().h(26).px(6).gap(6).items_center().rounded(4)
            .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleSection(section.key, section.expanded, cx))
            .child(div().w(10).flex_none().text_size(10).text_color(t.muted).child(section.expanded ? '▾' : '▸'))
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).text_color(section.harness ? t.accent : t.foreground).child(section.label))
            .when(section.recent && !section.expanded, el => el.child(div().flex_none().text_size(9).text_color(t.accent).child('●')))
            .child(div().flex_none().px(6).rounded(8).bg(t.chrome).text_size(10).text_color(t.muted).child(String(section.count))))
          .children(section.rows.map(row)))));
  }

  render(cx) {
    const active = spaces().some(s => s.id === this.spaceId && s.active) && panes().some(p => p.mod === 'project-docs-tabs' && p.tab === spaces().find(s => s.id === this.spaceId)?.tabs.find(t => t.active)?.id);
    if (active && !this.active) this.refresh(cx);
    this.active = active;
    const t = theme(), doc = this.documents.find(d => d.id === this.selected);
    const button = (id, label, action) => div().id(id).px(10).py(6).flex_none().rounded(5).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    const notice = text => div().px(16).py(6).flex_none().text_size(12).text_color(t.muted).child(text);
    const listed = this.documents.filter(d => !d.aliasOf && !d.harness && d.state !== 'previous' && d.state !== 'archived').length;
    const side = this.paneWidth >= SIDE_BY_SIDE;
    let root = v_flex().id('project-documents').size_full().min_w(0).min_h(0).overflow_hidden().bg(t.canvas).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(this.paneWidth - size.width) > 1) { this.paneWidth = size.width; cx.notify(); } })
      .child(h_flex().h(44).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(button('docs-tree-toggle', this.treeHidden ? '☰ 목록' : '◧ 목록', cx => { this.treeHidden = !this.treeHidden; cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`프로젝트 문서 · ${listed}개 · 읽기 전용`))
        .child(button('docs-refresh', '새로 고침', cx => this.refresh(cx)))
        .child(button('docs-settings', '분류 규칙 편집', cx => this.external('code', ['--reuse-window', this.config], cx))))
      .when(Boolean(this.listError), el => el.child(notice(`목록 확인 실패 · 마지막 목록 유지: ${this.listError}`)))
      .when(Boolean(this.warnings?.length), el => el.child(notice(`조회 주의: ${this.warnings.join(', ')}`)))
      .when(Boolean(this.actionError), el => el.child(notice(this.actionError)))
      .when(Boolean(this.copied), el => el.child(notice(this.copied)));
    const tree = this.treeHidden ? null : this.renderTree(t, button);
    const viewer = this.renderViewer(t, doc, button, notice);
    const body = side
      ? h_flex().flex_1().min_h(0).min_w(0).items_start()
        .when(Boolean(tree), el => el.child(tree.w(320).flex_none().h_full().pt(8).border_r(1).border_color(t.border)))
        .child(viewer.flex_1().min_w(0).h_full())
      : v_flex().flex_1().min_h(0).min_w(0)
        .when(Boolean(tree), el => el.child(tree.max_h(280).flex_none().pt(8).border_b(1).border_color(t.border)))
        .child(viewer.flex_1().min_h(0));
    return root.child(body);
  }

  renderViewer(t, doc, button, notice) {
    let root = v_flex().id('docs-viewer').min_w(0).min_h(0).overflow_hidden();
    if (!doc) return root.child(notice(this.refreshing ? '문서 목록 확인 중…' : '문서가 없습니다. 분류 규칙 편집에서 문서 폴더나 고정 문서를 추가하세요.'));
    const kind = this.kinds.find(k => k.id === doc.kind)?.label;
    const state = doc.state === 'previous' ? '이전 버전' : doc.state === 'archived' ? '보관' : doc.harness ? HARNESS_TAG : null;
    root = root.child(h_flex().flex_none().px(8).pt(4).gap(4).items_center()
      .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(doc.path || doc.name || '').child(doc.name || doc.label))
      .when(Boolean(doc.path), el => el.child(button('docs-open', '기본 앱', cx => this.external('open', [doc.path], cx)))
        .child(button('docs-edit', 'VS Code', cx => this.external('code', ['--reuse-window', doc.path], cx)))
        .child(button('docs-copy-file', '파일 복사', cx => this.copy(doc.path, 'file', cx)))
        .when(/\.md$/i.test(doc.path), el => el.child(button('docs-copy-text', '본문 복사', cx => this.copy(doc.path, 'text', cx)))))
      .when(!doc.harness, el => el.child(button('docs-pin', doc.pinned ? '고정 해제' : '고정', cx => this.action(doc.pinned ? ['--unpin', doc.id] : ['--pin', doc.path], cx)))))
      .child(notice([kind, state, doc.date, doc.path || doc.error || '경로 확인 필요'].filter(Boolean).join(' · ')))
      .child(notice(`${this.newVersion ? '새 날짜판 · ' : ''}${this.lastSuccess ? `본문 확인 ${new Date(this.lastSuccess).toLocaleTimeString()}` : '본문 확인 전'}${this.truncated ? ' · 400,000자까지 표시' : ''}`))
      .when(Boolean(this.bodyError), el => el.child(notice(`확인 실패 · ${this.bodyError}${this.blocks ? ' · 마지막 성공 본문 표시' : ''}`)))
      .when(Boolean(this.imageWarning), el => el.child(notice('일부 이미지를 읽을 수 없습니다.')))
      .when(Boolean(this.diagramError), el => el.child(notice(this.diagramError)));
    if (doc.path && !readable(doc.path)) return root.child(notice('PDF·Word·Excel 문서는 기본 앱으로 여세요.'));
    if (doc.path && isHtml(doc.path)) {
      if (this.html?.interactive.length) root = root.child(h_flex().id('docs-html-interactive').flex_none().mx(8).my(4).px(12).py(8).gap(8).items_center()
        .rounded(6).border(1).border_color(t.border).bg(t.selected)
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().child('이 문서는 클릭·팝업이 있어 브라우저에서 여세요'))
          .child(div().text_size(12).text_color(t.muted).truncate().child(`여기서는 그림으로만 표시 · ${this.html.interactive.join(', ')}`)))
        .child(button('docs-browser', '브라우저로 열기', cx => this.browser(doc.path, cx)).font_semibold().border(1).border_color(t.border).bg(t.chrome)));
      else root = root.child(notice('HTML은 브라우저 화면 그대로 그림으로 표시 · 글자 복사와 링크는 기본 앱에서'));
      if (this.html?.truncated) root = root.child(notice('긴 문서라 앞부분 40,000px까지 표시 · 전체는 브라우저에서'));
    }
    if (!this.blocks) return root.child(notice(this.loading ? '문서 읽는 중…' : '본문을 표시할 수 없습니다.'));
    // HTML tiles are one page cut in slices, so they sit edge to edge without a gap.
    const tiles = Boolean(this.html);
    return root.child(v_flex().id(`docs-body-${this.bodyKey}`).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(20).gap(tiles ? 0 : 12)
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; this.resized(cx); cx.notify(); } })
      .children(this.blocks.map((block, index) => block.media
        ? image(block.media.path).w(Math.min(block.media.width, Math.max(1, this.width - 40))).h(Math.min(block.media.width, Math.max(1, this.width - 40)) * block.media.height / block.media.width).flex_none()
        : TextView.markdown(`docs-markdown-${this.bodyKey}-${index}`, block.text).selectable(true).scrollable(false).w_full().flex_none().text_size(14).text_color(t.foreground)
          .on_link_click((url, cx) => this.follow(doc.path, url, cx)))));
  }

  close() { this.closed = true; ++this.generation; this.watchers.clear(); }
}
