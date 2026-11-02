import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { agents, panes, spaces, terminals, focused, props, theme, run, shared, setShared, setAgentOrder, nextCommand, exec, hc, window, readTextFile, writeTextFile, appHome } from 'herdr';
import { WORDS, counts, attention, title, cycle, priority } from './model.js';

const marks = { blocked: '!', done: '✓', working: '●', idle: '○' };

export default class SixfoldDesk extends View {
  init(_props, cx) {
    this.dragSpace = null;
    this.overSpace = null;
    this.pings = {};
    this.messageEvents = [];
    this.seenMessages = new Set();
    this.flashUntil = 0;
    if (props()?.role !== 'sidebar') return;
    const refresh = cx => cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${appHome()}/data/sixfold/messages.json`);
        const events = text ? JSON.parse(text).events ?? [] : [];
        if (events.at(-1)?.id !== this.messageEvents.at(-1)?.id) {
          this.messageEvents = events;
          this.flashUntil = Date.now()+2400;
          cx.notify();
        } else if (this.flashUntil && Date.now()>this.flashUntil) {
          this.flashUntil=0;cx.notify();
        }
      } catch { /* A partial or absent optional log does not affect terminals. */ }
    });
    refresh(cx);
    cx.timer.every(1000, refresh);
    // Optional voice integration is opt-in and runs only from this one sidebar.
    // Focus is sampled by a timer, never changed by rendering background rows.
    let voiceBusy=false, voiceActionBusy=false, voiceKey=null;
    cx.timer.every(500,cx=>{
      if(voiceBusy)return;
      voiceBusy=true;
      cx.spawn(async cx=>{
        try {
          const config=JSON.parse(await readTextFile(`${appHome()}/data/sixfold/voice-integration.json`) || 'null');
          if(!config?.script)return;
          const f=focused(), facts=terminals(), current=facts.find(x=>x.address===f?.terminal);
          const state={at:Date.now(),active:window().active,terminal:f?.terminal,
            source:current?.labels?.['sixfold.source-pane'],
            panes:agents().filter(a=>!facts.find(x=>x.address===a.address)?.labels?.['sixfold.source-pane'])
              .filter(a=>['claude','codex'].includes(a.program?.key))
              .map(a=>({pane_id:`app:${a.address}`,agent:a.program.key,agent_status:a.status}))};
          const path=`${appHome()}/data/sixfold/voice-focus.json`;
          const old=await readTextFile(path);
          await writeTextFile(path,JSON.stringify(state),old);
          const key=JSON.stringify([state.active,state.terminal,state.source]);
          if(key!==voiceKey && !voiceActionBusy){
            voiceKey=key;voiceActionBusy=true;
            // Keep publishing focus while a voice connection starts. The helper
            // rechecks that heartbeat before sending any microphone controls.
            cx.spawn(async cx=>{
              try {
                await exec('python3',[config.script,'--app-focus']);
              } finally {voiceActionBusy=false;}
            });
          }
        } catch { /* Optional integration failure must not disrupt terminals. */ }
        finally {voiceBusy=false;}
      });
    });
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

  ping(address, cx) {
    if (this.pings[address] === '…') return;
    this.pings[address] = '…';
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await hc(['send', address,
          '[Herdr Theme ping] 연결 확인입니다. 다른 작업은 하지 말고 PONG이라고만 답하세요.']);
        this.pings[address] = result.code === 0 ? '↑' : '!';
      } catch { this.pings[address] = '!'; }
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
    const events = (this.messageEvents ?? []).filter(e=>facts.some(x=>x.address===e.source)&&facts.some(x=>x.address===e.target));
    for (const event of events) if (event.target===f?.terminal) this.seenMessages.add(event.id);
    const unseen = address => events.filter(e=>e.target===address&&!this.seenMessages.has(e.id)).length;
    const last = events.at(-1);
    const moving = Boolean(last && last.at+2400>Date.now() && shared('sixfold.motion')!==false);
    const endpoint = address => moving && (last.source===address || last.target===address);
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
        .child(div().flex_1().text_size(12).font_bold().child('HERDR THEME / WORKSPACE'))
        .child(this.button('sf-blocked', `! ${w.blocked}`, () => run('sixfold-desk.next-blocked'), t))
        .child(this.button('sf-done', `✓ ${w.done}`, () => run('sixfold-desk.next-done'), t))
        .child(this.button('sf-zoom', w.zoom, () => run('pane.zoom'), t))
        .child(this.button('sf-motion', shared('sixfold.motion')===false?'Motion off':'Motion on',()=>setShared('sixfold.motion',shared('sixfold.motion')===false),t))
        .child(this.button('sf-review', w.review, () => { run('layout.select', {stack:'panel-body',child:'changes'}); run('layout.toggle',{id:'panel'}); }, t))
        .child(this.button('sf-files', w.files, () => { run('layout.select', {stack:'panel-body',child:'files'}); run('layout.toggle',{id:'panel'}); }, t));
    }
    // Reading a background workspace must never change another client's focus.
    setAgentOrder(list.map(a => a.address));
    const icon = (p, program) => {
      const key=program?.key;
      const active=p.status==='working' || endpoint(p.terminal);
      const custom=['claude','codex'].includes(key);
      const color=active ? (key==='claude'?'#f5b56c':t.accent) : t.dim;
      const glyph=custom ? svg(`mods/sixfold-desk/icons/${key}.svg`).size(14).text_color(color)
        : program?.icon ? (program.tint ? svg(program.icon).size(14).text_color(color) : image(program.icon).w(14).h(14)) : div().size(14);
      return div().relative().size(16).flex_none()
        .child(glyph.absolute().left(1).top(0)
          .when(active && shared('sixfold.motion')!==false,e=>e.loop('top',{from:0,to:2,period:900})));
    };
    const section = text => div().px(12).pt(13).pb(6).text_size(10).font_bold().text_color(t.dim).child(text);
    const groups=workspaceList.map(s=>({s,members:priority(s.tabs.flatMap(tab=>all.filter(p=>p.tab===tab.id)))}));
    const positions={};let offset=0;
    for(const {members} of groups){
      members.forEach((p,i)=>{positions[p.terminal]=offset+50+i*30;});
      offset+=43+members.length*30;
    }
    const spaceRows=groups.map(({s,members})=>v_flex().id(`sf-space-${s.id}`).ml(7).mr(29).mb(9).gap(2).flex_none()
      .child(h_flex().h(34).flex_none().px(8).items_center().gap(5).rounded(5).bg(s.active?t.selected:t.surface).text_size(12).font_bold()
        .when(this.dragSpace===s.id && this.overSpace!==s.id,e=>e.opacity(0.5))
        .when(this.dragSpace && this.overSpace===s.id && this.dragSpace!==s.id,e=>e.border(1).border_color(t.accent))
        .tooltip(this.lang()==='ko'?'드래그하여 순서 변경':'Drag to reorder')
        .on_mouse_down('left',()=>{this.dragSpace=s.id;this.overSpace=s.id;})
        .on_mouse_move((_event,cx)=>{
          const source=spaces().find(x=>x.id===this.dragSpace);
          if(source && (source.machine??null)===(s.machine??null) && this.overSpace!==s.id){this.overSpace=s.id;cx.notify();}
        })
        .on_mouse_up('left',(_event,cx)=>{
          const source=this.dragSpace, over=this.overSpace;
          this.dragSpace=null;this.overSpace=null;
          if(source && source!==s.id && over===s.id)run('space.move',{id:source,index:spaces().findIndex(x=>x.id===s.id)+1});
          else if(source===s.id)run('space.select',{id:s.id});
          cx.notify();
        })
        .child(div().flex_1().min_w(0).truncate().child(s.name))
        .child(div().text_size(10).text_color(t.muted).child(String(members.length))))
      .children(members.map(p=>{
        const tab=s.tabs.find(tab=>tab.id===p.tab);
        return h_flex().id(`sf-member-${p.pane}`).h(28).flex_none().px(7).gap(6).items_center().rounded(4).bg(p.focused?t.selected:t.chrome)
          .when(endpoint(p.terminal),e=>e.border(1).border_color(t.accent))
          .tooltip(`${s.name} / ${tab.name} / ${title(p)}`)
          .hover(h=>h.bg(t.hover)).on_click(()=>{run('tab.select',{id:tab.id});run('pane.focus',{pane:p.pane});})
          .child(icon(p,list.find(a=>a.address===p.terminal)?.program ?? p.program))
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(title(p)))
          .when(unseen(p.terminal)>0,e=>e.child(div().px(4).rounded(3).bg(t.accent).text_color(t.background).text_size(10).child(String(unseen(p.terminal)))))
          .child(this.badge(p.status,'',t))
          .child(div().id(`sf-ping-${p.terminal}`).px(4).py(2).rounded(3).text_size(10).text_color(t.accent)
            .hover(h=>h.bg(t.hover))
            .tooltip(this.lang()==='ko'?'핑 보내기 · ↑ 전송됨, ! 실패 (응답 확인과 별개)':'Send ping · ↑ sent, ! failed (not an acknowledgment)')
            .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
            .on_mouse_up('left',(_e,cx)=>cx.stop_propagation())
            .on_click((_e,cx)=>{cx.stop_propagation();this.ping(p.terminal,cx);})
            .child(this.pings[p.terminal]??'Ping'));
      })));
    const workspaceTree=v_flex().relative().flex_none().children(spaceRows)
      .when(Boolean(last && positions[last.source]!==undefined && positions[last.target]!==undefined && last.source!==last.target),el=>{
        const from=positions[last.source],to=positions[last.target],top=Math.min(from,to),height=Math.abs(to-from);
        return el.child(div().absolute().right(8).top(top).w(19).h(height+1)
          .child(div().absolute().right(0).top(0).w(2).h(height).bg(moving?t.accent:t.border))
          .child(div().absolute().right(0).top(0).w(19).h(2).bg(moving?t.accent:t.border))
          .child(div().absolute().right(0).bottom(0).w(19).h(2).bg(moving?t.accent:t.border))
          .child(div().absolute().left(-3).top(to===top?-6:height-6).text_size(13).text_color(t.accent).child('‹'))
          .when(moving,p=>p.child(div().absolute().right(-2).top(from-top-2).size(6).rounded(3).bg(t.accent)
            .loop('top',{from:from-top-2,to:to-top-2,period:1100}))));
      });
    const rows = attention(list).map(a =>
      v_flex().id(`sf-attention-${a.address}`).mx(7).mb(5).p(9).gap(4).rounded(6)
        .bg(t.surface).border(1).border_color(a.status === 'blocked' ? t.blocked : t.border)
        .hover(s => s.bg(t.hover)).on_click(() => run('agent.focus', {terminal:a.address}))
        .child(this.badge(a.status, `${w[a.status]} · ${a.program.name}`, t))
        .child(div().text_size(12).text_color(t.foreground).child(a.title || a.tab_name))
        .child(div().truncate().text_size(10).text_color(t.muted).child(`${a.space_name} / ${a.tab_name}`)));
    return v_flex().id('sixfold-sidebar').size_full().bg(t.chrome).text_color(t.foreground)
      .on_mouse_up('left',(_e,cx)=>{
        if(this.dragSpace){this.dragSpace=null;this.overSpace=null;cx.notify();}
      })
      .child(h_flex().h(48).flex_none().pl(76).pr(8).items_center().gap(4)
        .child(div().flex_1().font_bold().text_size(14).child('Herdr Theme'))
        .child(this.button('sf-language',w.language,()=>run('sixfold-desk.language'),t)))
      .child(h_flex().px(12).py(9).gap(12).flex_none().children(['blocked','done','working'].map(s => this.badge(s,String(total[s]),t))))
      .child(v_flex().id('sf-scroll').flex_1().min_h(0).overflow_y_scrollbar().mode('always')
        .child(section(w.spaces)).child(workspaceTree)
        .child(section(w.attention))
        .children(rows.length ? rows : [div().px(12).pb(8).text_size(11).text_color(t.muted).child(w.empty)])
        )
      .when(Boolean(last), e=>{
        const label=address=>{
          const p=all.find(p=>p.terminal===address);
          const s=workspaceList.find(s=>s.tabs.some(tab=>tab.id===p?.tab));
          return p?`${s?.name??''} / ${title(p)}`:address;
        };
        return e.child(v_flex().h(94).flex_none().px(12).py(8).gap(5).bg(t.surface).border_t(1).border_color(t.border)
          .child(div().text_size(9).text_color(t.dim).child('MESSAGE FLOW'))
          .child(div().truncate().text_size(10).text_color(t.foreground).child(label(last.source)))
          .child(div().relative().h(8).w(180)
            .child(div().absolute().left(0).top(3).h(2).w(180).bg(t.border))
            .child(div().absolute().left(174).top(0).text_size(9).text_color(t.accent).child('›'))
            .when(moving,h=>h.child(div().absolute().top(1).left(0).size(6).rounded(3).bg(t.accent).loop('left',{from:0,to:170,period:700}))))
          .child(div().truncate().text_size(10).text_color(t.accent).child(label(last.target))));
      })
      .child(h_flex().h(38).flex_none().px(7).items_center()
        .child(this.button('sf-settings',w.settings,()=>run('app.settings'),t))
        .child(div().flex_1())
        .child(this.button('sf-new-space','+ Space',()=>run('space.new'),t)));
  }
}
