import { View, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { agents, panes, spaces, terminals, focused, props, theme, run, shared, setShared, setAgentOrder, nextCommand, exec, window } from 'herdr';
import { WORDS, counts, attention, title, cycle } from './model.js';

const marks = { blocked: '!', done: '✓', working: '●', idle: '○' };

export default class SixfoldDesk extends View {
  init(_props, cx) {
    this.focusKey = null;
    this.bridgeError = false;
    if (props()?.role !== 'sidebar') return;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const f = focused();
        const current = panes().filter(p => p.tab === f?.tab);
        if (command === 'next-pane' || command === 'prev-pane') {
          const p = cycle(current, f?.pane, command === 'next-pane' ? 1 : -1);
          if (p) run('pane.focus', { pane: p.pane });
        } else if (command.startsWith('pane-')) {
          const p = current[Number(command.slice(5)) - 1];
          if (p) run('pane.focus', { pane: p.pane });
        } else if (command === 'next-blocked' || command === 'next-done') {
          const state = command === 'next-blocked' ? 'blocked' : 'done';
          const list = agents().filter(a => a.status === state);
          const index = list.findIndex(a => a.address === f?.terminal);
          const a = list[(index + 1) % list.length];
          if (a) run('agent.focus', { terminal: a.address });
        } else if (command === 'language') {
          setShared('sixfold.language', this.lang() === 'ko' ? 'en' : 'ko');
        }
        cx.notify();
      }
    });
  }

  lang() { return shared('sixfold.language') === 'en' ? 'en' : 'ko'; }

  button(id, text, action, t) {
    return div().id(id).px(8).py(4).rounded(5).text_size(11).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(text);
  }

  badge(status, text, t) {
    return h_flex().gap(5).items_center().text_size(11).text_color(t[status] ?? t.muted)
      .child(div().font_bold().child(marks[status] ?? '·')).child(text);
  }

  bridgeFocus(cx) {
    const f = focused();
    if (!f?.terminal) return;
    const terminal = terminals().find(p => p.address === f.terminal);
    const source = terminal?.labels?.['sixfold.source-pane'];
    const session = terminal?.labels?.['sixfold.source-session'];
    if (!source || !session) { this.focusKey = null; return; }
    const key = `${f.terminal}/${source}`;
    if (this.focusKey === key) return;
    this.focusKey = key;
    cx.spawn(async cx => {
      try {
        const r = await exec('herdr', ['--session', session, 'agent', 'focus', source]);
        this.bridgeError = r.code !== 0;
      } catch { this.bridgeError = true; }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const w = WORDS[this.lang()];
    const role = props()?.role;
    const f = focused();
    const facts = terminals();
    const onlySpace = props()?.onlySpace;
    const workspaceList = spaces().filter(s=>!onlySpace || s.id===onlySpace);
    const tabIds = new Set(workspaceList.flatMap(s=>s.tabs.map(tab=>tab.id)));
    const all = panes().filter(p=>!onlySpace || tabIds.has(p.tab)).map(p => ({...p, title: facts.find(x=>x.address===p.terminal)?.labels?.['sixfold.title'] || p.title}));
    const list = agents().filter(a=>!onlySpace || a.space===onlySpace);
    const local = all.filter(p => p.tab === f?.tab);
    const total = counts(list);
    if (role === 'pane') {
      const p = all.find(p => p.pane === props()?.pane);
      if (!p) return div();
      const index = all.filter(x => x.tab === p.tab).findIndex(x => x.pane === p.pane) + 1;
      return h_flex().id(`sixfold-head-${p.pane}`).size_full().items_center().gap(7).px(9)
        .bg(p.focused ? t.selected : t.chrome).text_size(11.5)
        .on_click(() => run('pane.focus', { pane: p.pane }))
        .child(div().flex_none().font_bold().text_color(p.focused ? t.accent : t.dim).child(String(index).padStart(2, '0')))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(title(p)))
        .child(this.badge(p.status, p.status ? w[p.status] : '', t));
    }
    if (role === 'footer') {
      const p = all.find(p => p.pane === f?.pane);
      const linked = terminals().find(x => x.address === f?.terminal)?.labels?.['sixfold.source-pane'];
      return h_flex().size_full().items_center().gap(10).px(12).bg(t.chrome).border_t(1).border_color(t.border)
        .text_size(11).text_color(t.muted)
        .child(div().font_bold().text_color(t.accent).child(w.input))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p ? title(p) : w.noFocus))
        .when(Boolean(linked), e=>e.child(div().text_color(t.accent).child(w.bridge)))
        .child(div().child(`${local.length} panes · ⌘[ / ⌘] · ⌘⇧↵`));
    }
    if (role === 'toolbar') {
      return h_flex().size_full().items_center().gap(3).px(10).bg(t.chrome).text_color(t.foreground)
        .child(div().flex_1().text_size(12).font_bold().child('SIXFOLD / WORKSPACE'))
        .child(this.button('sf-blocked', `! ${w.blocked}`, () => run('sixfold-desk.next-blocked'), t))
        .child(this.button('sf-done', `✓ ${w.done}`, () => run('sixfold-desk.next-done'), t))
        .child(this.button('sf-zoom', w.zoom, () => run('pane.zoom'), t))
        .child(this.button('sf-review', w.review, () => { run('layout.select', {stack:'panel-body',child:'changes'}); run('layout.toggle',{id:'panel'}); }, t))
        .child(this.button('sf-files', w.files, () => { run('layout.select', {stack:'panel-body',child:'files'}); run('layout.toggle',{id:'panel'}); }, t));
    }
    // Live TUI connections route actual terminal focus in the bridge process.
    // Rendering a background layout must never move another client's focus.
    setAgentOrder(list.map(a => a.address));
    const section = text => div().px(12).pt(13).pb(6).text_size(10).font_bold().text_color(t.dim).child(text);
    const spaceRows = workspaceList.map(s=>v_flex().id(`sf-space-${s.id}`).mx(7).mb(9).gap(2)
      .child(h_flex().p(8).gap(5).rounded(5).bg(s.active?t.selected:t.surface).text_size(12).font_bold()
        .on_click(()=>run('space.select',{id:s.id}))
        .child(div().flex_1().min_w(0).truncate().child(s.name))
        .child(div().text_size(10).text_color(t.muted).child(String(s.tabs.reduce((n,tab)=>n+tab.panes,0)))))
      .children(s.tabs.flatMap(tab=>all.filter(p=>p.tab===tab.id).map((p,i)=>h_flex().id(`sf-member-${p.pane}`)
        .px(7).py(6).gap(6).items_center().rounded(4).bg(p.focused?t.selected:t.chrome)
        .tooltip(`${s.name} / ${tab.name} / ${title(p)}`)
        .hover(h=>h.bg(t.hover)).on_click(()=>{run('tab.select',{id:tab.id});run('pane.focus',{pane:p.pane});})
        .child(div().w(16).flex_none().text_size(10).font_bold().text_color(p.focused?t.accent:t.dim).child(String(i+1).padStart(2,'0')))
        .child(div().flex_1().min_w(0).truncate().text_size(11).child(title(p)))
        .child(this.badge(p.status,'',t))))));
    const rows = attention(list).map(a =>
      v_flex().id(`sf-attention-${a.address}`).mx(7).mb(5).p(9).gap(4).rounded(6)
        .bg(t.surface).border(1).border_color(a.status === 'blocked' ? t.blocked : t.border)
        .hover(s => s.bg(t.hover)).on_click(() => run('agent.focus', {terminal:a.address}))
        .child(this.badge(a.status, `${w[a.status]} · ${a.program.name}`, t))
        .child(div().text_size(12).text_color(t.foreground).child(a.title || a.tab_name))
        .child(div().truncate().text_size(10).text_color(t.muted).child(`${a.space_name} / ${a.tab_name}`)));
    return v_flex().id('sixfold-sidebar').size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(48).flex_none().pl(76).pr(8).items_center().gap(4)
        .child(div().flex_1().font_bold().text_size(14).child('Sixfold'))
        .child(this.button('sf-language',w.language,()=>run('sixfold-desk.language'),t)))
      .child(h_flex().px(12).py(9).gap(12).flex_none().children(['blocked','done','working'].map(s => this.badge(s,String(total[s]),t))))
      .child(v_flex().id('sf-scroll').flex_1().min_h(0).overflow_y_scrollbar().mode('always')
        .child(section(w.spaces)).children(spaceRows)
        .child(section(w.attention))
        .children(rows.length ? rows : [div().px(12).pb(8).text_size(11).text_color(t.muted).child(w.empty)])
        )
      .when(this.bridgeError, e=>e.child(div().p(8).text_color(t.blocked).text_size(11).child('TUI focus link failed')))
      .child(h_flex().h(38).flex_none().px(7).items_center()
        .child(this.button('sf-settings',w.settings,()=>run('app.settings'),t))
        .child(div().flex_1())
        .child(this.button('sf-new-space','+ Space',()=>run('space.new'),t)));
  }
}
