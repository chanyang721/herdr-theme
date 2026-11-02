import { View, div, image } from 'gpui-kit';
import { v_flex, h_flex, TextView } from 'gpui-base';
import { props, appHome, readTextFile, exec, watchFolder, theme, shared, setShared, spaces, panes } from 'herdr';
import { stageMarkdown } from './vendor/markdown.js';
import { dirname, resolveLink } from './vendor/paths.js';

const LIMIT = 400000;
const STATE = 'sixfold.docs.selection.v1';
export default class ProjectDocuments extends View {
  init(_props, cx) {
    const p = props() || {};
    this.spaceId = p.spaceId;
    this.script = p.resolverScript || `${appHome()}/data/sixfold/doc-tabs/resolve_doc_pins.py`;
    this.config = p.pinsConfig || `${appHome()}/data/sixfold/project-docs-pins.json`;
    this.documents = []; this.watchers = new Map(); this.generation = 0;
    this.selected = shared(STATE)?.[this.spaceId]; this.width = 800;
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
        this.documents = data.documents; this.warnings = data.warnings || []; this.listError = null;
        if (this.linked) {
          const pinned = this.documents.find(d => d.path === this.linked.path);
          if (pinned) {
            if (this.selected === this.linked.id) this.selected = pinned.id;
            this.linked = null;
          } else this.documents.push(this.linked);
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
            if (root === dirname(this.config) && !changed.some(path => path === root || path.endsWith('/' + this.config.split('/').pop()))) continue;
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
    if (!doc.path.toLowerCase().endsWith('.md')) { this.blocks = null; this.bodyError = null; return; }
    this.loading = true;
    cx.spawn(async cx => {
      const current = () => !this.closed && this.generation === generation && this.bodyKey === key;
      try {
        const text = await readTextFile(doc.path);
        if (!current()) return;
        if (text === null) throw Error('파일을 읽을 수 없습니다.');
        if (text.includes('\0')) throw Error('텍스트 문서가 아닙니다.');
        if (text !== this.bodyText || this.blocks?.some(block => block.media) || this.imageWarning) {
          const staged = await stageMarkdown(text.slice(0, LIMIT), { file: doc.path, root: dirname(doc.path), on: null });
          if (!current()) return;
          this.bodyText = text; this.blocks = staged.blocks; this.imageWarning = staged.unavailable;
          this.watch(staged.files.map(dirname), cx);
          this.truncated = text.length > LIMIT;
        }
        this.bodyError = null; this.lastSuccess = Date.now();
      } catch (error) { if (current()) this.bodyError = String(error.message || error); }
      finally { if (current()) { this.loading = false; cx.notify(); } }
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

  follow(file, url, cx) {
    try {
      const link = resolveLink(file, url);
      if (link.url) cx.open_url(link.url);
      else if (link.file?.toLowerCase().endsWith('.md')) {
        const existing = this.documents.find(d => d.path === link.file);
        if (existing) { this.choose(existing.id, cx); return; }
        this.linked = { id: `opened-${link.file}`, path: link.file, name: link.file.split('/').pop(),
          label: link.file.split('/').pop(), kind: 'file', status: 'ok', pinned: false, opened: true };
        this.documents = this.documents.filter(d => !d.opened).concat(this.linked);
        this.choose(this.linked.id, cx);
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
        .children(this.documents.map(d => button(`doc-${d.id}`, `${d.pinned ? '◆' : d.opened ? '열람' : '최근'} ${d.label}`, cx => this.choose(d.id, cx))
          .max_w(300).truncate().bg(d.id === this.selected ? t.selected : t.chrome))))
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
      .when(Boolean(this.imageWarning), el => el.child(notice('일부 이미지를 읽을 수 없습니다.')));
    if (doc.path && !doc.path.toLowerCase().endsWith('.md')) return root.child(notice('PDF·Word·Excel 문서는 기본 앱으로 여세요.'));
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
