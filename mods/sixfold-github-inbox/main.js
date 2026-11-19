import { View, div, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { theme, props, shared, openOverlay, closeOverlay } from 'herdr';
import { githubKind, githubLine, githubRef, githubTone, githubLink, spacesOf, workCount, sections, collectLine } from './model.js';

// GitHub inbox ('전체 보기' of a card's GitHub tab). It reads only what the sidebar already published
// (shared sixfold.githubItems / githubSpaces / githubHealth, from data/sixfold/github-alerts.json): no file
// reads, no timer; a new collection re-renders it through shared(). Read only: the one action is opening a
// pull request or issue on github.com in the default browser.
export default class GithubInbox extends View {
  init(_props, cx) {
    this.space = props()?.project ?? null;
    this.workOnly = true;
    if (props()?.overlay && !props()?.window && !props()?.project) {
      openOverlay({mod: 'sixfold-github-inbox', kind: 'window', key: 'github-inbox', keep: true, width: 900, height: 720, props: {window: true}});
      closeOverlay(props().overlay);
    }
  }
  render() {
    const t = theme(), items = shared('sixfold.githubItems') ?? [], health = shared('sixfold.githubHealth') ?? {};
    const spaces = spacesOf(shared('sixfold.githubSpaces'), items);
    const button = (id, label, selected, action) => div().id(id).px(11).py(6).rounded(5).text_size(13).font_semibold()
      .bg(selected ? t.selected : t.surface).text_color(selected ? t.accent : t.muted).hover(s => s.bg(t.hover)).cursor_pointer().on_click(action).child(label);
    const groups = sections(items, {space: this.space, workOnly: this.workOnly});
    const shown = groups.reduce((n, g) => n + g.items.length, 0);
    const row = item => {
      const open = githubLink(item.url);
      return v_flex().id(`sf-github-item-${item.id}`).p(12).gap(4).rounded(7).bg(t.surface).border(1).border_color(item.unread ? githubTone(item, t) : t.border)
        .when(open, e => e.cursor_pointer().hover(s => s.bg(t.hover)).tooltip('누르면 GitHub에서 엽니다')
          .on_click((_e, cx) => cx.open_url(item.url)))
        .child(h_flex().gap(8).items_center()
          .child(div().px(8).py(2).rounded(4).text_size(12).font_bold()
            .bg(item.unread ? githubTone(item, t) : t.chrome).text_color(item.unread ? t.accent_foreground : t.muted).child(githubKind(item).label))
          .child(div().font_bold().text_size(13).child(githubRef(item)))
          .child(div().text_size(12).text_color(t.muted).child(item.workspace || ''))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.muted).child(String(item.at || '').slice(0, 16).replace('T', ' '))))
        .child(div().text_size(15).font_bold().child(item.title || '제목 없음'))
        .child(div().text_size(12).text_color(item.unread && item.kind === 'pr' ? (t.blocked || t.accent) : t.muted).child(githubLine(item)));
    };
    return v_flex().id('sf-github').size_full().p(20).gap(12).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(image('mods/sixfold-desk/icons/github.svg').size(24))
        .child(div().flex_1().font_bold().text_size(21).child(this.space ? `${this.space} · GitHub` : 'GitHub'))
        .child(div().px(10).py(5).rounded(5).bg(t.selected).text_color(t.accent).font_bold().text_size(15).child(`손볼 일 ${workCount(items, this.space)}`))
        .child(button('sf-github-close', '닫기', false, () => closeOverlay(props()?.overlay))))
      .child(div().text_size(12).text_color(health.state === 'error' ? t.blocked : t.muted).child(collectLine(health)))
      .child(h_flex().gap(7).items_center().flex_wrap()
        .child(button('sf-github-all-spaces', '전체 공간', !this.space, (_e, cx) => { this.space = null; cx.notify(); }))
        .children(spaces.map(space => button(`sf-github-space-${space}`, `${space} · ${workCount(items, space)}`, this.space === space,
          (_e, cx) => { this.space = space; cx.notify(); })))
        .child(div().flex_1())
        .child(button('sf-github-work', this.workOnly ? '손볼 일만' : '전체 PR 포함', this.workOnly, (_e, cx) => { this.workOnly = !this.workOnly; cx.notify(); })))
      .child(v_flex().id('sf-github-scroll').flex_1().min_h(0).overflow_y_scroll().gap(14)
        .when(shown === 0, e => e.child(div().p(20).text_size(15).text_color(t.muted).child('이 조건에 해당하는 GitHub 항목이 없습니다.')))
        .children(groups.filter(g => g.items.length).map(g => v_flex().id(`sf-github-section-${g.kind}`).gap(6)
          .child(div().text_size(12).font_bold().text_color(t.muted).child(`${g.title} · ${g.items.length}`))
          .children(g.items.map(row)))))
      .child(div().text_size(11).text_color(t.dim).child('읽기 전용입니다. GitHub에는 아무것도 쓰지 않고, 항목을 누르면 브라우저에서 엽니다.'));
  }
}
