import { View, div, image } from 'gpui-kit';
import { h_flex, v_flex, InputState, Input } from 'gpui-base';
import { theme, props, appHome, readTextFile, writeTextFile, openOverlay, closeOverlay, exec, spaces } from 'herdr';
import { categoryLabel, linearLink, visibleItems, spacesOf, issueLine, buildRequest, resultLabel, changeLines, placeItems, readAllTargets, collectLine } from './model.js';

// Linear inbox. Reads data/sixfold/linear-alerts.json (written by a local collector).
// Writes never happen here: a pressed button leaves one request file that the
// collector runs once, and the result comes back under linear-actions/results/.
export default class LinearInbox extends View {
  init(_props, cx) {
    this.items = []; this.statuses = {}; this.health = {}; this.writes = [];
    this.space = props()?.project ?? null; this.unreadOnly = true;
    this.expanded = new Set(); this.stateOpen = null; this.confirm = null;
    this.pending = new Map(); this.results = new Map(); this.error = '';
    this.commentInputs = new Map();
    if (props()?.overlay && !props()?.window && !props()?.project) {
      openOverlay({mod:'sixfold-linear-inbox',kind:'window',key:'linear-inbox',keep:true,width:980,height:760,props:{window:true}});
      closeOverlay(props().overlay);
    }
    let busy = false, previous;
    const data = `${appHome()}/data/sixfold`;
    const refresh = cx => {
      if (busy) return;
      busy = true;
      cx.spawn(async cx => {
        try {
          const text = await readTextFile(`${data}/linear-alerts.json`).catch(() => '{"items":[]}');
          const health = await readTextFile(`${data}/linear-live-health.json`).catch(() => '{}');
          let changed = false;
          for (const [key, id] of this.pending) {
            const result = await readTextFile(`${data}/linear-actions/results/${id}.json`).catch(() => null);
            if (result) { this.results.set(key, JSON.parse(result)); this.pending.delete(key); changed = true; }
          }
          const snapshot = text + '\u0000' + health;
          if (snapshot !== previous) {
            const feed = JSON.parse(text || '{}');
            this.items = placeItems(feed.items ?? [], (spaces() ?? []).map(s => s.name)); this.statuses = feed.statuses ?? {};
            // Writes the local collector accepts on this computer; others stay hidden.
            this.writes = Array.isArray(feed.writes) ? feed.writes : [];
            this.health = JSON.parse(health || '{}');
            previous = snapshot; changed = true;
          }
          // A read mark Linear accepted is shown read now, before the collector's next list.
          for (const [key, result] of this.results) {
            if (key.startsWith('read:') && result?.ok === true && result.unread === undefined)
              { this.items = this.items.map(i => i.id === key.slice(5) && !i.read ? {...i, read: true} : i); }
          }
          if (changed) cx.notify();
        } catch { /* Keep the last valid snapshot through collector writes. */ }
        finally { busy = false; }
      });
    };
    refresh(cx); cx.timer.every(2000, refresh);
  }
  input(item) {
    if (!this.commentInputs.has(item.id)) {
      this.commentInputs.set(item.id, InputState.new({placeholder: `${item.issue}에 남길 댓글`}));
    }
    return this.commentInputs.get(item.id);
  }
  send(key, action, item, extra, cx) {
    cx.spawn(async cx => {
      try {
        const request = buildRequest(action, item, extra);
        const folder = `${appHome()}/data/sixfold/linear-actions`;
        await writeTextFile(`${folder}/${request.id}.json`, JSON.stringify(request), null);
        this.pending.set(key, request.id); this.results.delete(key); this.error = '';
      } catch (error) { this.error = `요청을 남기지 못했습니다: ${error?.message || error}`; }
      this.confirm = null; cx.notify();
    });
  }
  render() {
    const t = theme(), health = this.health || {};
    const shown = visibleItems(this.items, {space: this.space, unreadOnly: this.unreadOnly});
    const spaces = spacesOf(this.items), unread = visibleItems(this.items, {space: this.space, unreadOnly: true}).length;
    const button = (id, label, selected, action) => div().id(id).px(11).py(6).rounded(5).text_size(13).font_semibold()
      .bg(selected ? t.selected : t.surface).text_color(selected ? t.accent : t.muted).hover(s => s.bg(t.hover)).on_click(action).child(label);
    const feedback = key => this.pending.has(key) ? resultLabel(null) : this.results.has(key) ? resultLabel(this.results.get(key)) : '';
    return v_flex().id('sf-linear').size_full().p(20).gap(12).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(image('mods/sixfold-desk/icons/linear.svg').size(24))
        .child(div().flex_1().font_bold().text_size(21).child(this.space ? `${this.space} · Linear 알림` : 'Linear 알림'))
        .child(div().px(10).py(5).rounded(5).bg(t.selected).text_color(t.accent).font_bold().text_size(15).child(`미확인 ${unread}`))
        .child(button('sf-linear-close', '닫기', false, () => closeOverlay(props()?.overlay))))
      .child(div().text_size(12).text_color(health.state === 'error' ? t.blocked : t.muted)
        .child(collectLine(health)))
      .child(h_flex().gap(7).items_center()
        .child(button('sf-linear-all-spaces', '전체 공간', !this.space, (_e, cx) => { this.space = null; cx.notify(); }))
        .children(spaces.map(space => button(`sf-linear-space-${space}`, `${space} · ${visibleItems(this.items, {space, unreadOnly: true}).length}`,
          this.space === space, (_e, cx) => { this.space = space; cx.notify(); })))
        .child(div().flex_1())
        .when(readAllTargets(this.items, this.space, this.writes).some(i => !this.pending.has(`read:${i.id}`)), e => e.child(button('sf-linear-read-all', '모두 읽음', false, (_e, cx) => {
          for (const item of readAllTargets(this.items, this.space, this.writes))
            if (!this.pending.has(`read:${item.id}`)) this.send(`read:${item.id}`, item.local ? 'mark_seen' : 'mark_read', item, {origin: 'all'}, cx);
        })))
        .child(button('sf-linear-unread', this.unreadOnly ? '미확인만' : '읽은 알림 포함', this.unreadOnly, (_e, cx) => { this.unreadOnly = !this.unreadOnly; cx.notify(); })))
      .when(Boolean(this.error), e => e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id('sf-linear-scroll').flex_1().min_h(0).overflow_y_scroll().gap(12)
        .when(shown.length === 0, e => e.child(div().p(20).text_size(15).text_color(t.muted).child('이 조건에 해당하는 Linear 알림이 없습니다.')))
        .children(shown.map(item => {
          const open = this.expanded.has(item.id), states = this.statuses[item.team] ?? [];
          const stateKey = `state:${item.id}`, commentKey = `comment:${item.id}`, readKey = `read:${item.id}`;
          return v_flex().id(`sf-linear-item-${item.id}`).opacity(this.pending.has(readKey) ? 0.5 : 1).p(14).gap(8).rounded(7).bg(t.surface).border(1).border_color(item.read ? t.border : t.accent)
            .child(h_flex().gap(8).items_center()
              .child(div().px(8).py(3).rounded(4).bg(item.read ? t.chrome : t.selected).text_color(item.read ? t.muted : t.accent).text_size(12).font_bold()
                .child(item.read ? `✓ ${categoryLabel(item)}` : `● ${categoryLabel(item)}`))
              .child(div().font_bold().text_size(14).child(item.issue || '이슈 없음'))
              .child(div().text_size(12).text_color(t.muted).child(item.workspace || ''))
              .child(div().flex_1())
              .child(div().text_size(11).text_color(t.muted).child(item.at || '')))
            .child(div().text_size(16).font_bold().child(item.issue_title || item.title || '제목 없음'))
            .child(div().text_size(12).text_color(t.muted).child(item.subtitle || ''))
            .when(Boolean(issueLine(item)), e => e.child(div().text_size(13).child(issueLine(item))))
            .when(changeLines(item).length > 0, e => e.child(v_flex().gap(2).px(8).py(6).rounded(5).bg(t.chrome)
              .child(div().text_size(11).text_color(t.muted).child(`바뀐 내용${item.changed_at ? ` · ${item.changed_at.slice(5, 16).replace('T', ' ')}` : ''}`))
              .children(changeLines(item).map((change, i) => div().id(`sf-linear-change-${item.id}-${i}`).text_size(13).text_color(t.ansi4 || t.accent).child(change)))))
            .when(open, e => e.child(v_flex().gap(6).pt(6).border_t(1).border_color(t.border)
              .when(!(item.comments ?? []).length, e => e.child(div().text_size(12).text_color(t.muted).child('불러온 최근 댓글이 없습니다.')))
              .children((item.comments ?? []).map((c, i) => v_flex().id(`sf-linear-c-${item.id}-${i}`).gap(2)
                .child(div().text_size(11).text_color(t.muted).child(`${c.at || ''} · ${c.author || ''}`))
                .child(div().text_size(13).child(c.body || ''))))
              .when(Boolean(item.issue) && this.writes.includes('comment'), e => e.child(h_flex().gap(7).items_center()
                .child(Input.new(this.input(item)).flex_1().h(30).text_size(13).text_color(t.foreground))
                .child(button(`sf-linear-comment-${item.id}`, this.confirm === commentKey ? '다시 눌러 댓글 보내기' : '댓글 보내기', this.confirm === commentKey, (_e, cx) => {
                  if (this.confirm !== commentKey) { this.confirm = commentKey; cx.notify(); return; }
                  this.send(commentKey, 'comment', item, {body: this.input(item).value()}, cx);
                }))))
              .when(Boolean(feedback(commentKey)), e => e.child(div().text_size(12).text_color(t.muted).child(`댓글: ${feedback(commentKey)}`)))))
            .when(this.stateOpen === item.id, e => e.child(h_flex().gap(6).flex_wrap()
              .when(!states.length, e => e.child(div().text_size(12).text_color(t.muted).child('팀 상태 목록을 아직 읽지 못했습니다.')))
              .children(states.filter(s => s !== item.status).map(state => {
                const key = `${stateKey}:${state}`;
                return button(`sf-linear-state-${item.id}-${state}`, this.confirm === key ? `다시 눌러 '${state}'로 변경` : state, this.confirm === key, (_e, cx) => {
                  if (this.confirm !== key) { this.confirm = key; cx.notify(); return; }
                  this.send(stateKey, 'set_state', item, {state}, cx);
                });
              }))))
            .when(Boolean(feedback(stateKey)), e => e.child(div().text_size(12).text_color(t.muted).child(`상태 변경: ${feedback(stateKey)}`)))
            .when(Boolean(feedback(readKey)), e => e.child(div().text_size(12).text_color(t.muted).child(`읽음 처리: ${feedback(readKey)}`)))
            .child(h_flex().gap(7)
              // Opening the original confirms it: read in Linear (a linked-issue comment on this computer only).
              .when(linearLink(item.url), e => e.child(button(`sf-linear-open-${item.id}`, '원문 열기', false, (_e, cx) => {
                cx.spawn(async () => { await exec('open', [item.url]); });
                if (!item.read && !this.pending.has(readKey) && (item.local || this.writes.includes('mark_read')))
                  this.send(readKey, item.local ? 'mark_seen' : 'mark_read', item, {origin: 'opened'}, cx);
              })))
              .child(button(`sf-linear-expand-${item.id}`, open ? '접기' : '댓글·답글', open, (_e, cx) => { open ? this.expanded.delete(item.id) : this.expanded.add(item.id); cx.notify(); }))
              .when(Boolean(item.issue) && this.writes.includes('set_state'), e => e.child(button(`sf-linear-states-${item.id}`, '상태 변경', this.stateOpen === item.id, (_e, cx) => { this.stateOpen = this.stateOpen === item.id ? null : item.id; this.confirm = null; cx.notify(); })))
              .when(!item.local && !item.read && !this.pending.has(readKey) && this.writes.includes('mark_read'), e => e.child(button(`sf-linear-read-${item.id}`, '읽음 처리', true, (_e, cx) => this.send(readKey, 'mark_read', item, {}, cx))))
              // A comment read from a space's linked issue has no Linear notification: "확인" is kept on this computer only.
              .when(Boolean(item.local) && !item.read && !this.pending.has(readKey), e => e.child(button(`sf-linear-seen-${item.id}`, '확인', true, (_e, cx) => this.send(readKey, 'mark_seen', item, {}, cx)).tooltip('이 컴퓨터에서만 확인 표시 · Linear에는 쓰지 않음'))));
        })))
      .child(div().text_size(11).text_color(t.dim).child('Linear 쓰기는 버튼을 누를 때만, 이 컴퓨터에서 켠 작업만 반영됩니다. 실제 호출을 검증해 결과를 알려 줍니다.'));
  }
}
