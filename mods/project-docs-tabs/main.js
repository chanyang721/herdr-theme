import { View, div, image } from 'gpui-kit';
import { v_flex, h_flex, TextView } from 'gpui-base';
import { props, appHome, readTextFile, exec, watchFolder, theme, settings, shared, setShared, spaces, panes } from 'herdr';
import { stageMarkdown } from './vendor/markdown.js';
import { dirname, resolveLink } from './vendor/paths.js';
import { mermaidFences, applyDiagrams } from './mermaid.js';

const LIMIT = 400000;
const STATE = 'sixfold.docs.selection.v1';
// scripts/open_doc_tab.py writes the latest open request; each space handles it once.
const REQUEST = 'project-docs-open.json';
const OPENED = 'sixfold.docs.opened.v1';
// Recent documents closed per space, by id, with the version closed; a newer one comes back.
const CLOSED = 'sixfold.docs.closed.v1';
const isHtml = path => /\.html?$/i.test(path);
const readable = path => /\.md$/i.test(path) || isHtml(path);
export default class ProjectDocuments extends View {
  init(_props, cx) {
    const p = props() || {};
    this.spaceId = p.spaceId;
    this.script = p.resolverScript || `${appHome()}/data/sixfold/doc-tabs/resolve_doc_pins.py`;
    this.config = p.pinsConfig || `${appHome()}/data/sixfold/project-docs-pins.json`;
    this.mermaidScript = p.mermaidScript || `${appHome()}/data/sixfold/doc-tabs/render_mermaid.py`;
    this.htmlScript = p.htmlScript || `${appHome()}/data/sixfold/doc-tabs/render_html.py`;
    this.documents = []; this.watchers = new Map(); this.generation = 0;
    this.selected = shared(STATE)?.[this.spaceId]; this.width = 800;
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
        const closed = shared(CLOSED)?.[this.spaceId] || {};
        this.documents = data.documents.filter(d => d.pinned || !(d.id in closed) || (d.mtime ?? 0) > closed[d.id]);
        this.warnings = data.warnings || []; this.listError = null;
        if (this.linked) {
          const pinned = this.documents.find(d => d.path === this.linked.path);
          if (pinned) {
            if (this.selected === this.linked.id) this.selected = pinned.id;
            this.linked = null;
          } else this.documents.push(this.linked);
        }
        const request = await readTextFile(`${dirname(this.config)}/${REQUEST}`).then(text => text ? JSON.parse(text) : null).catch(() => null);
        if (this.closed) return;
        if (request?.spaceId === this.spaceId && typeof request.path === 'string' && request.at > (shared(OPENED)?.[this.spaceId] ?? 0)) {
          setShared(OPENED, { ...(shared(OPENED) || {}), [this.spaceId]: request.at });
          this.reveal(request.path);
        }
        this.checkedAt = data.checkedAt;
        if (!this.documents.some(d => d.id === this.selected)) this.selected = this.documents[0]?.id;
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
    this.selected = id;
    setShared(STATE, { ...(shared(STATE) || {}), [this.spaceId]: id });
    this.load(cx); this.refresh(cx); cx.notify();
  }

  load(cx) {
    const doc = this.documents.find(d => d.id === this.selected);
    const key = doc ? (!doc.path && this.lastId === doc.id ? this.bodyKey : `${doc.id}:${doc.path}`) : null;
    if (this.bodyKey !== key) {
      this.bodyKey = key; this.blocks = null; this.bodyText = null; this.bodyError = null;
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
          if (text !== this.bodyText || look !== this.diagramLook) {
            const pages = await this.page(doc.path, look);
            if (!current()) return;
            this.bodyText = text; this.diagramLook = look; this.blocks = pages; this.imageWarning = null; this.truncated = false;
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
  async page(path, look) {
    this.diagramError = null;
    const run = await exec('python3', [this.htmlScript, '--doc', path, '--theme', look.split(':')[0]]);
    let data = {};
    try { data = JSON.parse(run.stdout || '{}'); } catch {}
    if (run.code !== 0 || !Array.isArray(data.pages)) throw Error(data.error || run.stderr.trim() || 'HTML 렌더링 실패');
    return data.pages.map(media => ({ media, diagram: true }));
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

  // Close a 열람 or 최근 tab; pinned ones are removed with 고정 해제.
  dismiss(id, cx) {
    const doc = this.documents.find(d => d.id === id);
    if (!doc || doc.pinned) return;
    if (doc.opened) this.linked = null;
    else {
      const all = shared(CLOSED) || {};
      setShared(CLOSED, { ...all, [this.spaceId]: { ...(all[this.spaceId] || {}), [id]: doc.mtime ?? Date.now() } });
    }
    this.documents = this.documents.filter(d => d.id !== id);
    if (this.selected === id) this.choose(this.documents[0]?.id, cx);
    else cx.notify();
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

  render(cx) {
    const active = spaces().some(s => s.id === this.spaceId && s.active) && panes().some(p => p.mod === 'project-docs-tabs' && p.tab === spaces().find(s => s.id === this.spaceId)?.tabs.find(t => t.active)?.id);
    if (active && !this.active) this.refresh(cx);
    this.active = active;
    const t = theme(), doc = this.documents.find(d => d.id === this.selected);
    const button = (id, label, action) => div().id(id).px(10).py(6).flex_none().rounded(5).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    const notice = text => div().px(16).py(6).flex_none().text_size(12).text_color(t.muted).child(text);
    let root = v_flex().id('project-documents').size_full().min_w(0).min_h(0).overflow_hidden().bg(t.canvas).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child('프로젝트 문서 · 읽기 전용'))
        .child(button('docs-refresh', '새로 고침', cx => this.refresh(cx)))
        .child(button('docs-settings', '고정 규칙 편집', cx => this.external('code', ['--reuse-window', this.config], cx))))
      .child(h_flex().id('docs-tabbar').h(this.documents.length > 4 ? 90 : 48).flex_none().flex_wrap().gap(4).p(8).overflow_y_scrollbar()
        .children(this.documents.map(d => {
          const tab = button(`doc-${d.id}`, `${d.pinned ? '◆' : d.opened ? '열람' : '최근'} ${d.label}`, cx => this.choose(d.id, cx))
            .max_w(300).truncate().bg(d.id === this.selected ? t.selected : t.chrome);
          return d.pinned ? tab : h_flex().flex_none().items_center().rounded(5).bg(d.id === this.selected ? t.selected : t.chrome)
            .child(tab.pr(4)).child(button(`doc-close-${d.id}`, '×', cx => this.dismiss(d.id, cx)).px(6).text_color(t.muted));
        })))
      .when(Boolean(this.listError), el => el.child(notice(`목록 확인 실패 · 마지막 목록 유지: ${this.listError}`)))
      .when(Boolean(this.warnings?.length), el => el.child(notice(`조회 주의: ${this.warnings.join(', ')}`)))
      .when(Boolean(this.actionError), el => el.child(notice(this.actionError)));
    if (!doc) return root.child(notice(this.refreshing ? '문서 목록 확인 중…' : '고정 문서가 없습니다. 고정 규칙 편집에서 문서를 추가하세요.'));
    root = root.child(h_flex().flex_none().px(8).gap(4).items_center()
      .child(div().flex_1().min_w(0).truncate().child(doc.name || doc.label))
      .when(Boolean(doc.path), el => el.child(button('docs-open', '기본 앱', cx => this.external('open', [doc.path], cx)))
        .child(button('docs-edit', 'VS Code', cx => this.external('code', ['--reuse-window', doc.path], cx))))
      .child(button('docs-pin', doc.pinned ? '고정 해제' : '고정', cx => this.action(doc.pinned ? ['--unpin', doc.id] : ['--pin', doc.path], cx))))
      .child(notice(doc.path || doc.error || '경로 확인 필요'))
      .child(notice(`${this.newVersion ? '새 날짜판 · ' : ''}${this.lastSuccess ? `본문 확인 ${new Date(this.lastSuccess).toLocaleTimeString()}` : '본문 확인 전'}${this.truncated ? ' · 400,000자까지 표시' : ''}`))
      .when(Boolean(this.bodyError), el => el.child(notice(`확인 실패 · ${this.bodyError}${this.blocks ? ' · 마지막 성공 본문 표시' : ''}`)))
      .when(Boolean(this.imageWarning), el => el.child(notice('일부 이미지를 읽을 수 없습니다.')))
      .when(Boolean(this.diagramError), el => el.child(notice(this.diagramError)));
    if (doc.path && !readable(doc.path)) return root.child(notice('PDF·Word·Excel 문서는 기본 앱으로 여세요.'));
    if (doc.path && isHtml(doc.path)) root = root.child(notice('HTML은 브라우저 화면 그대로 표시 · 글자 복사와 링크는 기본 앱에서'));
    if (!this.blocks) return root.child(notice(this.loading ? '문서 읽는 중…' : '본문을 표시할 수 없습니다.'));
    return root.child(v_flex().id(`docs-body-${this.bodyKey}`).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(20).gap(12)
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .children(this.blocks.map((block, index) => block.media
        ? image(block.media.path).w(Math.min(block.media.width, Math.max(1, this.width - 40))).h(Math.min(block.media.width, Math.max(1, this.width - 40)) * block.media.height / block.media.width).flex_none()
        : TextView.markdown(`docs-markdown-${this.bodyKey}-${index}`, block.text).selectable(true).scrollable(false).w_full().flex_none().text_size(14).text_color(t.foreground)
          .on_link_click((url, cx) => this.follow(doc.path, url, cx)))));
  }

  close() { this.closed = true; ++this.generation; this.watchers.clear(); }
}
