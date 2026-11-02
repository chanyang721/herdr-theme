import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { agents, panes, spaces, terminals, focused, props, theme, run, shared, setShared, setAgentOrder, nextCommand, exec, window, readTextFile, writeTextFile, appHome } from 'herdr';
import { WORDS, counts, title, cycle, priority } from './model.js';

import { freshMessages, recentRoutes } from './flow.js';
import { watchAlerts, alertSection, visibleAlerts } from './alerts.js';

const marks = { blocked: '!', done: '✓', working: '●', idle: '○' };

export default class SixfoldDesk extends View {
  init(_props, cx) {
    this.dragSpace = null;
    this.overSpace = null;
    this.messageEvents = [];
    this.activeFlows = [];
    this.pendingFlows = [];
    this.queuedRoutes = [];
    this.routeScript = null;
    this.routeBusy = false;
    this.seenMessages = new Set();
    if (props()?.role !== 'sidebar') return;
    this.alerts = [];
    watchAlerts(this, cx);
    // File notifications start a small number of finite native transitions.
    // No frame-by-frame JavaScript animation or old-message replay on reload.
    this.previousEvents = null;
    this.messageSnapshot = null;
    this.refreshBusy = false;
    const refresh = cx => {
      if (this.refreshBusy) return;
      this.refreshBusy = true;
      cx.spawn(async cx => {
        try {
          const text = await readTextFile(`${appHome()}/data/sixfold/messages.json`) || '{"events":[]}';
          const routing = await readTextFile(`${appHome()}/data/sixfold/routing.json`).catch(()=>null) || 'null';
          const queue = await readTextFile(`${appHome()}/data/sixfold/routing-queue.json`).catch(()=>null) || '{"requests":[]}';
          const snapshot = JSON.stringify([text, routing, queue]);
          if (snapshot === this.messageSnapshot) return;
          const events = JSON.parse(text).events ?? [];
          const config = JSON.parse(routing);
          const requests = JSON.parse(queue).requests ?? [];
          const addresses = new Set(terminals().map(item => item.address));
          this.pendingFlows.push(...freshMessages(this.previousEvents, events).filter(event => addresses.has(event.source) && addresses.has(event.target)));
          this.previousEvents = events;
          this.messageEvents = events;
          this.routeScript = config?.script;
          this.queuedRoutes = requests.map(({id,source,project,hold,error})=>({id,source,project,hold,error}));
          this.messageSnapshot = snapshot;
          this.startFlows(cx);
          cx.notify();
        } catch { /* Retry a partial write on the next tick, without clearing badges. */ }
        finally { this.refreshBusy = false; }
      });
    };
    refresh(cx);
    // File watchers are shared by mod copies. Reconcile independently of focus
    // and watcher wakeups; redraw only when the persisted snapshot changes.
    cx.timer.every(500, refresh);
    cx.timer.every(2000, cx => {
      if (this.routeBusy || !this.routeScript || !this.queuedRoutes.some(item=>!item.hold)) return;
      this.routeBusy = true;
      cx.spawn(async cx => {
        try { await exec('python3',[this.routeScript,'--drain']); }
        finally { this.routeBusy = false; }
      });
    });
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

  startFlows(cx) {
    while (this.activeFlows.length < 4 && this.pendingFlows.length) {
      const event = this.pendingFlows.shift();
      if (Date.now() - event.at > 15000) continue;
      const occupied = new Set(this.activeFlows.map(flow => flow.lane));
      const lane = [0, 1, 2, 3].find(value => !occupied.has(value));
      const flow = { ...event, lane, phase: 'start' };
      this.activeFlows.push(flow);
      cx.timer.after(60, cx => {
        flow.phase = 'travel';
        cx.notify();
      });
      cx.timer.after(1660, cx => {
        flow.phase = 'arrived';
        cx.notify();
      });
      cx.timer.after(3800, cx => {
        this.activeFlows = this.activeFlows.filter(item => item.id !== flow.id);
        this.startFlows(cx);
        cx.notify();
      });
    }
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
    const palette = [t.accent, t.ansi6, t.ansi5, t.ansi3];
    const flows = this.activeFlows.filter(flow => flow.replay || events.some(event => event.id === flow.id));
    const motion = shared('sixfold.motion') !== false;
    const endpoint = address => flows.some(flow => flow.source === address || flow.target === address);
    const routeColor = address => palette[flows.find(flow => flow.target === address || flow.source === address)?.lane ?? 0];
    const label = address => {
      const p = panes().find(p => p.terminal === address);
      const s = spaces().find(s => s.tabs.some(tab => tab.id === p?.tab));
      return p ? `${s?.name ?? ''} · ${title(p)}` : address === 'external' ? (this.lang() === 'ko' ? '외부' : 'External') : address;
    };
    const history = recentRoutes(events);
    const paths = flows.length ? flows : history.map((event, lane) => ({ ...event, lane, phase: 'history' }));
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
    const spaceRows=groups.map(({s,members})=>v_flex().id(`sf-space-${s.id}`).ml(7).mr(41).mb(9).gap(2).flex_none()
      .when(this.dragSpace && this.overSpace===s.id && this.dragSpace!==s.id,e=>e.border_t(2).border_color(t.accent))
      .on_mouse_move((_event,cx)=>{
        const source=spaces().find(x=>x.id===this.dragSpace);
        if(source && (source.machine??null)===(s.machine??null) && this.overSpace!==s.id){this.overSpace=s.id;cx.notify();}
      })
      .on_mouse_up('left',(_event,cx)=>{
        const source=spaces().find(x=>x.id===this.dragSpace);
        if(!source)return;
        this.dragSpace=null;this.overSpace=null;
        if(source.id!==s.id && (source.machine??null)===(s.machine??null)){
          this.suppressClickUntil=Date.now()+250;
          run('space.move',{id:source.id,index:spaces().findIndex(x=>x.id===s.id)+1});
        } else if(source.id===s.id)run('space.select',{id:s.id});
        cx.stop_propagation();cx.notify();
      })
      .child(h_flex().h(34).flex_none().px(8).items_center().gap(5).rounded(5).bg(s.active?t.selected:t.surface).text_size(12).font_bold()
        .when(this.dragSpace===s.id && this.overSpace!==s.id,e=>e.opacity(0.5))
        .when(this.dragSpace && this.overSpace===s.id && this.dragSpace!==s.id,e=>e.border(1).border_color(t.accent))
        .tooltip(this.lang()==='ko'?'드래그하여 순서 변경':'Drag to reorder')
        .on_mouse_down('left',()=>{this.dragSpace=s.id;this.overSpace=s.id;})
        .child(div().flex_1().min_w(0).truncate().child(s.name))
        .when(members.some(p=>unseen(p.terminal)>0),e=>e.child(div().px(4).rounded(3).bg(t.accent).text_color(t.background).text_size(10)
          .child(String(members.reduce((sum,p)=>sum+unseen(p.terminal),0)))))
        .child(div().text_size(10).text_color(t.muted).child(String(members.length))))
      .children(members.map(p=>{
        const tab=s.tabs.find(tab=>tab.id===p.tab);
        return h_flex().id(`sf-member-${p.pane}`).h(28).flex_none().px(7).gap(6).items_center().rounded(4).bg(p.focused?t.selected:t.chrome)
          .when(endpoint(p.terminal),e=>e.border(1).border_color(routeColor(p.terminal)))
          .tooltip(`${s.name} / ${tab.name} / ${title(p)}`)
          .hover(h=>h.bg(t.hover)).on_click(()=>{
            if((this.suppressClickUntil??0)>Date.now() || (this.dragSpace && this.overSpace!==this.dragSpace))return;
            run('tab.select',{id:tab.id});run('pane.focus',{pane:p.pane});
          })
          .child(icon(p,list.find(a=>a.address===p.terminal)?.program ?? p.program))
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(title(p)))
          .when(unseen(p.terminal)>0,e=>e.child(div().px(4).rounded(3).bg(t.accent).text_color(t.background).text_size(10).child(String(unseen(p.terminal)))))
          .child(this.badge(p.status,'',t));
      })));
    const workspaceTree=v_flex().relative().flex_none().children(spaceRows)
      .children(paths.filter(flow => positions[flow.source] !== undefined && positions[flow.target] !== undefined).map(flow => {
        const from=positions[flow.source], to=positions[flow.target];
        const top=Math.min(from,to), height=Math.abs(to-from), color=palette[flow.lane];
        const progress=flow.phase === 'start' && motion ? from-top : to-top;
        const opacity=flow.phase === 'history' ? 0.2 : flow.phase === 'arrived' ? 0.45 : 0.95;
        return div().id(`sf-route-${flow.id}`).absolute().right(7+flow.lane*8).top(top).w(33-flow.lane*8).h(height+1)
          .opacity(opacity).transition('opacity',350)
          .child(div().absolute().right(0).top(0).w(flow.phase==='history'?1:3).h(height).rounded(2).bg(color))
          .child(div().absolute().right(0).top(from-top).w(33-flow.lane*8).h(1).bg(color))
          .child(div().absolute().right(0).top(to-top).w(33-flow.lane*8).h(1).bg(color))
          .child(div().absolute().left(-4).top(to-top-8).text_size(13).text_color(color).child('‹'))
          .when(flow.phase !== 'history', el => el.child(div().id(`sf-packet-${flow.id}`).absolute().right(-2).top(progress-5).size(10).rounded(5).bg(color)
            .when(motion, el => el.transition('top',{duration:1600,easing:'ease-in-out'}))));
      }));
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
        )
      .when(visibleAlerts(this.alerts).length>0, e=>e.child(alertSection(this,t)))
      .when(Boolean(last) || this.queuedRoutes.length > 0, e => e.child(v_flex().flex_none().px(10).py(9).gap(6).bg(t.surface).border_t(1).border_color(t.border)
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().text_size(10).font_bold().text_color(t.muted).child(this.lang()==='ko'?'메시지 흐름':'MESSAGE FLOW'))
          .child(div().text_size(10).text_color(t.accent).child(flows.length ? `${flows.length}${this.lang()==='ko'?'개 연결':' active'}` : (this.lang()==='ko'?'최근 전송':'Recent')))
          .when(this.pendingFlows.length>0, el=>el.child(div().text_size(10).text_color(t.muted).child(`+${this.pendingFlows.length}`))))
        .children(this.queuedRoutes.slice(0,3).map(item=>h_flex().gap(5).text_size(10).text_color(item.hold?t.blocked:t.muted)
          .tooltip(item.error || (this.lang()==='ko'?'사용 가능한 프로젝트 pane이 생기면 전달합니다':'Waiting for an available project pane'))
          .child(div().child(item.hold?'!':'◷'))
          .child(div().flex_1().truncate().child(`${item.project} · ${this.lang()==='ko'?'수신 pane 대기':'Waiting for a pane'}`))))
        .children((flows.length ? flows : history).map(flow => {
          const active=flows.some(item=>item.id===flow.id), color=palette[flow.lane??0];
          const arrived=!active || flow.phase==='arrived';
          const position=flow.phase==='start' && motion ? 0 : 156;
          return v_flex().id(`sf-flow-card-${flow.id}`).gap(3).px(6).py(5).rounded(4).bg(t.chrome)
            .tooltip(`${label(flow.source)} → ${label(flow.target)} · ${this.lang()==='ko'?'전송됨 · 읽음 여부 아님':'Sent, not a read receipt'}`)
            .on_click(()=>run('agent.focus',{terminal:flow.target}))
            .child(h_flex().gap(5).items_center()
              .child(div().size(4).rounded(2).bg(color))
              .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(label(flow.source)))
              .when((flow.count??0)>1,el=>el.child(div().text_size(9).text_color(color).child(`×${flow.count}`)))
              .when(!active, el=>el.child(div().id(`sf-replay-${flow.id}`).px(3).text_size(11).text_color(t.muted)
                .tooltip(this.lang()==='ko'?'기록된 경로 다시 보기 · 메시지를 재전송하지 않습니다':'Replay this route without sending a message')
                .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
                .on_mouse_up('left',(_event,cx)=>cx.stop_propagation())
                .on_click((_event,cx)=>{
                  cx.stop_propagation();
                  this.pendingFlows.push({...flow,id:`${flow.id}-replay-${Date.now()}`,at:Date.now(),replay:true});
                  this.startFlows(cx);cx.notify();
                }).child('↻'))))
            .when(active, el=>el.child(div().relative().h(9).w(170).ml(9)
              .child(div().absolute().left(0).top(2).h(1).w(161).bg(t.border))
              .child(div().id(`sf-flow-dot-${flow.id}`).absolute().left(position).top(0).size(8).rounded(4).bg(color)
                .when(motion, dot=>dot.transition('left',{duration:1600,easing:'ease-in-out'})))))
            .child(h_flex().gap(5).items_center()
              .child(div().text_size(10).text_color(color).child(arrived?'✓':'↓'))
              .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.foreground).child(label(flow.target)))
              .when(arrived,el=>el.child(div().text_size(9).text_color(t.dim).child(flow.replay?(this.lang()==='ko'?'경로 재생':'Replay'):(this.lang()==='ko'?'전송됨':'Sent')))));
        }))))
      .child(h_flex().h(38).flex_none().px(7).items_center()
        .child(this.button('sf-settings',w.settings,()=>run('app.settings'),t))
        .child(div().flex_1())
        .child(this.button('sf-new-space','+ Space',()=>run('space.new'),t)));
  }
}
