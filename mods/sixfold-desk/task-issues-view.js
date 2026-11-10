import {div,svg} from 'gpui-kit';
import {h_flex,v_flex,Popover} from 'gpui-base';
import {kindTone} from './alert-model.js';

export const ISSUE_SCOPES=Object.freeze([
  {id:'week',label:'이번 주'},
  {id:'milestone',label:'마일스톤'},
  {id:'all',label:'전체'},
]);
const states={blocked:'막힘',working:'진행 중',review:'검수',waiting:'대기',done:'완료'};
const text=(value,color,size=11)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const kindBadge=(item,t,id)=>div().id(id).px(5).rounded(3).flex_none().text_size(9).font_bold()
  .bg(kindTone(item.kind,t)).text_color(t.accent_foreground||t.background).child(item.category||'알림');
const clock=at=>{const d=new Date(at);if(Number.isNaN(d.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;};

// The caller supplies normalized display data, owns local UI state, and posts
// explicit row actions through its local request boundary.
export function issuePopover(model,t){
  const {id,trigger,open=false,scope='week',rows=[],groups=[],busyKeys=new Set()}=model;
  const change=(callback,...args)=>(_event,cx)=>{cx.stop_propagation();callback?.(...args,cx);};
  const popover=Popover.new(`task-issues-${id}`).anchor('left_center').open(open)
    .on_open_change((value,cx)=>model.onOpen?.(value,cx)).trigger(trigger);
  if(!open)return popover;
  // The trigger ends inside the card. Keep the supplied route gutter outside
  // the surface; margin participates in native window-edge clamping.
  const body=v_flex().id(`task-issues-body-${id}`).relative().w(440).ml(model.leadingGap||0).max_h(700).gap(8).p(12)
    .rounded(10).border(1).border_color(t.border).bg(t.popover||t.surface).text_color(t.foreground);
  body.child(svg('mods/sixfold-desk/icons/popover-tail.svg').absolute().left(-9).top(22).size(10).text_color(t.popover||t.surface));
  const heading=h_flex().gap(8).items_center();
  if(model.icon)heading.child(model.icon);
  body.child(heading
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(text(model.projectLabel||'업무 이슈',t.foreground,13).font_bold())
      .child(text(model.updatedLabel||model.toolLabel||'연결 없음',t.dim,10)))
    .child(div().id(`task-issues-close-${id}`).size(28).rounded(6).text_size(14).text_color(t.muted)
      .cursor_pointer().tooltip('닫기').on_click(change(model.onOpen,false)).child('✕')));
  if(model.search)body.child(model.search);
  const group=alertedGroup(model,t);
  if(group)body.child(group);
  body.child(h_flex().gap(4).pb(8).border_b(1).border_color(t.border)
    .children(ISSUE_SCOPES.map(item=>{
      const count=model.scopeCounts?.[item.id];
      return h_flex().id(`task-issues-scope-${id}-${item.id}`).h(30).px(12).gap(4).rounded(6).items_center()
        .bg(scope===item.id?t.selected:t.popover||t.surface).cursor_pointer()
        .on_click(change(model.onScope,item.id))
        .child(text(item.label,scope===item.id?t.foreground:t.muted,12))
        .child(text(Number.isInteger(count)?String(count):'—',t.dim,10));
    })));
  const list=v_flex().id(`task-issues-list-${id}`).min_h(42).max_h(560).overflow_y_scroll().gap(2);
  const issueRow=issue=>{
    const included=issue.week||issue.pinned,busy=busyKeys.has(issue.key);
    const tone=issue.state==='blocked'?t.blocked:issue.state==='working'?t.ansi4||t.accent:issue.state==='review'?t.accent:t.dim;
    const label=busy?'요청 중':issue.week?'이번 주':issue.pinned?'가져옴 ✓':'가져오기';
    const enabled=model.canImport===true&&!busy&&!issue.week;
    // An issue with new alerts gets a small count here; what changed is in the shared group above the tabs.
    const alerts=model.alertsFor?.(issue.key)||null;
    const row=h_flex().id(`task-issue-${id}-${issue.key}`).h(34).px(8).gap(8).items_center().rounded(6)
      .opacity(issue.state==='done'&&!alerts?0.5:1)
      .when(included,row=>row.bg((t.ansi6||t.accent).slice(0,7)+'0F'))
      .child(div().size(8).flex_none().rounded(4).bg(tone))
      .child(text(issue.key,t.muted,10).w(58).flex_none().font_bold().tooltip(issue.key))
      .when(Boolean(alerts),row=>row.child(div().id(`task-issue-alerts-${id}-${issue.key}`).h(16).px(5).flex_none().rounded(8)
        .bg(t.accent).text_color(t.accent_foreground||t.background).text_size(9).font_bold().flex().items_center()
        .tooltip(`새 알림 ${alerts.unread}건`).child(`새 ${alerts.unread}`)))
      .child(text(issue.title,t.foreground,12).flex_1().tooltip(issue.title))
      .when(issue.week,row=>row.child(text('이번 주',t.ansi4||t.accent,9).px(5).rounded(7).border(1).border_color((t.ansi4||t.accent).slice(0,7)+'55')))
      .child(text(states[issue.state]||states.waiting,tone,9).flex_none())
      .child(div().id(`task-issues-pull-${id}-${issue.key}`).h(24).px(9).rounded(12).border(1)
        .border_color(issue.pinned?(t.ansi6||t.accent).slice(0,7)+'55':t.border)
        .text_color(issue.pinned?t.ansi6||t.accent:t.muted).text_size(10).font_bold()
        .when(enabled,button=>button.cursor_pointer().on_click(change(model.onPull,issue.key,!issue.pinned)))
        .when(issue.week,button=>button.opacity(0.55)).child(label));
    return row;
  };
  if(scope==='milestone'){
    for(const group of groups){
      list.child(h_flex().id(`task-issues-group-${id}-${group.id}`).pt(10).pb(4).px(8).gap(8).items_center()
        .child(text(group.name,t.foreground,11).font_bold())
        .child(text(group.due||'',t.dim,10)).child(div().flex_1())
        .child(text(group.progress||'',t.dim,10)));
      list.children(group.items.map(issueRow));
    }
  }else list.children(rows.map(issueRow));
  if(!(scope==='milestone'?groups.some(group=>group.items.length):rows.length)){
    list.child(text(model.loading?'이슈를 불러오는 중':model.emptyLabel||'이 범위에 표시할 이슈가 없습니다',t.dim,11).py(12));
  }
  body.child(list);
  if(model.error)body.child(text(model.error,t.blocked,10));
  const footer=h_flex().pt(10).gap(8).border_t(1).border_color(t.border).items_center()
    .child(text(model.scopeNote||'이번 주와 직접 가져온 이슈가 공간에 표시됩니다',t.dim,10).flex_1());
  if(model.onExternal)footer.child(text(`${model.toolLabel||'도구'}에서 열기 ↗`,t.accent,10).font_bold()
    .cursor_pointer().on_click(change(model.onExternal)));
  else footer.child(text('도구 링크 없음',t.dim,10).tooltip('연결 도구의 URL이 제공되지 않았습니다'));
  return popover.content(body.child(footer));
}

// The shared "알림 온 이슈" group: in the issue search above its tabs, and alone in a peek
// (the popover a new alert opens beside its card). `model.fresh` lights the alerts just arrived.
export function alertedGroup(model,t){
  // Issues with new alerts, the same in every tab (even when a tab's list lacks the issue).
  // Opening a row (or [읽음]) confirms it in Linear; a pending mark is drawn dimmed until the
  // collector reports back, a failure comes back unread with one error line.
  const {id}=model,change=(callback,...args)=>(_event,cx)=>{cx.stop_propagation();callback?.(...args,cx);};
  const alerted=model.alerted||[],pending=model.readPending||new Set(),done=model.doneKeys||new Set(),fresh=model.fresh||new Set();
  if(!alerted.length)return null;
  {
    const readButton=(key,label,tip,action,enabled=true)=>div().id(key).h(20).px(7).flex_none().rounded(10).border(1)
      .border_color(enabled?t.accent:t.border).text_size(9).font_bold().text_color(enabled?t.accent:t.dim).flex().items_center()
      .when(enabled,e=>e.cursor_pointer().hover(s=>s.bg(t.hover||t.selected)).tooltip(tip).on_click(action)).child(label);
    const unread=alerted.reduce((sum,entry)=>sum+entry.alerts.unread,0);
    const waiting=alerted.every(entry=>entry.alerts.lines.every(item=>pending.has(item.id)));
    const group=v_flex().id(`task-issues-alerted-${id}`).gap(4).p(6).rounded(8).bg(t.chrome||t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().px(2)
        .child(text('알림 온 이슈',t.foreground,11).font_bold())
        .child(text(`미확인 ${unread}`,t.accent,10))
        .child(div().flex_1())
        .child(model.onReadAll&&model.readable
          ?readButton(`task-issues-read-all-${id}`,waiting?'처리 중':'모두 읽음','이 묶음의 알림을 Linear에서도 읽음으로 표시',change(model.onReadAll),!waiting)
          :text('읽음은 Linear 기준',t.dim,9)));
    for(const entry of alerted){
      const newest=entry.alerts.lines[0]||{};
      const issueAlerts=()=>model.issueTargets?.(entry.key)||entry.alerts.lines;
      const line=(item,i)=>{
        const busy=pending.has(item.id);
        // A comment from a linked issue has no Linear notification: [확인] keeps it on this computer only.
        const canRead=Boolean(model.onRead)&&(item.local||model.readable);
        // Just arrived (an opened peek): lit until it folds into the chip.
        return h_flex().id(`task-issues-alerted-line-${id}-${entry.key}-${i}`).gap(6).px(6).py(2).rounded(5).items_center()
          .opacity(busy?0.45:1)
          .when(fresh.has(item.id),e=>e.bg((t.accent||'#88aaff').slice(0,7)+'33').border(1).border_color(t.accent))
          .when(Boolean(item.url&&model.onLink)&&!busy,e=>e.cursor_pointer().tooltip('누르면 이 댓글을 Linear에서 열고 읽음으로 표시합니다').hover(s=>s.bg(t.hover||t.selected))
            .on_click((_event,cx)=>{cx.stop_propagation();model.onLink(item.url,cx,[item]);}))
          .child(kindBadge(item,t,`task-issues-alerted-kind-${id}-${entry.key}-${i}`))
          .child(text(item.text,t.muted,11).flex_1().tooltip(item.text))
          .child(text(clock(item.at),t.dim,9).flex_none())
          .when(canRead,e=>e.child(readButton(`task-issues-read-${id}-${entry.key}-${i}`,busy?'처리 중':item.local?'확인':'읽음',
            item.local?'이 컴퓨터에서만 확인 표시 · Linear에는 쓰지 않음':'Linear에서 이 알림을 읽음으로 표시',change(model.onRead,[item]),!busy)));
      };
      const target=entry.alerts.lines.find(item=>item.url)?.url||'';
      group.child(v_flex().id(`task-issues-alerted-${id}-${entry.key}`).gap(1).p(4).rounded(6).bg(t.selected)
        .child(h_flex().id(`task-issues-alerted-head-${id}-${entry.key}`).gap(6).items_center().px(2)
          .when(Boolean(target&&model.onLink),e=>e.cursor_pointer().tooltip('누르면 이 이슈(최근 댓글)를 Linear에서 열고 이 이슈의 알림을 읽음으로 표시합니다')
            .on_click((_event,cx)=>{cx.stop_propagation();model.onLink(target,cx,issueAlerts());}))
          .child(kindBadge(newest,t,`task-issues-alerted-headkind-${id}-${entry.key}`))
          .child(text(entry.key,t.muted,10).flex_none().font_bold())
          .child(text(entry.title,t.foreground,12).flex_1().tooltip(entry.title))
          // Its work finished (the sidebar shows the issue done): marked, not read in Linear unless set.
          .when(done.has(entry.key),e=>e.child(div().id(`task-issues-alerted-done-${id}-${entry.key}`).px(5).rounded(7).flex_none().border(1)
            .border_color(t.border).text_size(9).text_color(t.muted).tooltip('이 이슈의 작업이 끝났습니다 · 알림은 Linear 기준으로 남아 있습니다').child('처리됨')))
          .when(entry.alerts.unread>1,e=>e.child(text(`${entry.alerts.unread}건`,t.accent,9).flex_none())))
        .children(entry.alerts.lines.map(line))
        .when(entry.alerts.more>0,e=>e.child(text(`외 ${entry.alerts.more}건`,t.dim,10).px(8))));
    }
    if(model.readError)group.child(text(model.readError,t.blocked,10).px(4));
    return group;
  }
}
