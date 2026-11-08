import {div,svg} from 'gpui-kit';
import {h_flex,v_flex,Popover} from 'gpui-base';

export const ISSUE_SCOPES=Object.freeze([
  {id:'week',label:'이번 주'},
  {id:'milestone',label:'마일스톤'},
  {id:'all',label:'전체'},
]);
const states={blocked:'막힘',working:'진행 중',review:'검수',waiting:'대기',done:'완료'};
const text=(value,color,size=11)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);

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
    return h_flex().id(`task-issue-${id}-${issue.key}`).h(34).px(8).gap(8).items_center().rounded(6)
      .opacity(issue.state==='done'?0.5:1)
      .when(included,row=>row.bg((t.ansi6||t.accent).slice(0,7)+'0F'))
      .child(div().size(8).flex_none().rounded(4).bg(tone))
      .child(text(issue.key,t.muted,10).w(58).flex_none().font_bold().tooltip(issue.key))
      .child(text(issue.title,t.foreground,12).flex_1().tooltip(issue.title))
      .when(issue.week,row=>row.child(text('이번 주',t.ansi4||t.accent,9).px(5).rounded(7).border(1).border_color((t.ansi4||t.accent).slice(0,7)+'55')))
      .child(text(states[issue.state]||states.waiting,tone,9).flex_none())
      .child(div().id(`task-issues-pull-${id}-${issue.key}`).h(24).px(9).rounded(12).border(1)
        .border_color(issue.pinned?(t.ansi6||t.accent).slice(0,7)+'55':t.border)
        .text_color(issue.pinned?t.ansi6||t.accent:t.muted).text_size(10).font_bold()
        .when(enabled,button=>button.cursor_pointer().on_click(change(model.onPull,issue.key,!issue.pinned)))
        .when(issue.week,button=>button.opacity(0.55)).child(label));
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
