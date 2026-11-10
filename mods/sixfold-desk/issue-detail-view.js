import {div} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import {kindTone} from './alert-model.js';
import {statusLook,statusTone} from './issue-model.js';

// Inside the issue search: an issue's detail (list → detail, ← back) and the milestone list.
// Every action is a pressed button: reads are requested by the caller, writes go through the
// collector's guard as before.
const text=(value,color,size=11)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const wrap=(value,color,size=11)=>div().min_w(0).text_size(size).text_color(color).child(value);
const clock=at=>{const d=new Date(at);if(Number.isNaN(d.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;};
const press=(callback,...args)=>(_event,cx)=>{cx.stop_propagation();callback?.(...args,cx);};

export function statusChip(status,t,id){
  const look=statusLook(status),tone=statusTone(status,t);
  return h_flex().id(id).flex_none().gap(3).items_center().tooltip(look.label)
    .child(text(look.icon,tone,11).font_bold()).child(text(look.label,look.kind==='unknown'?t.dim:tone,9));
}
const button=(id,label,t,{onClick,enabled=true,accent=false,tip}={})=>div().id(id).h(24).px(9).flex_none().rounded(12).border(1)
  .border_color(accent?t.accent:t.border).text_size(10).font_bold().flex().items_center()
  .text_color(enabled?accent?t.accent:t.foreground:t.dim).opacity(enabled?1:0.5)
  .when(Boolean(tip),b=>b.tooltip(tip))
  .when(enabled&&Boolean(onClick),b=>b.cursor_pointer().on_click(press(onClick))).child(label);

export function issueDetail(model,t){
  const d=model.detail,id=model.id;
  const body=v_flex().id(`task-issue-detail-${id}`).gap(8).max_h(600).overflow_y_scroll();
  body.child(h_flex().gap(8).items_center()
    .child(button(`task-issue-detail-back-${id}`,'← 목록',t,{onClick:()=>model.onDetail?.(null)}))
    .child(text(d.key,t.muted,11).flex_none().font_bold())
    .child(div().flex_1())
    .child(statusChip(d.status,t,`task-issue-detail-status-${id}`)));
  body.child(wrap(d.title,t.foreground,13).font_bold());
  if(d.fields.length)body.child(h_flex().flex_wrap().gap(10).children(d.fields.map(([label,value],i)=>h_flex().id(`task-issue-detail-field-${id}-${i}`).gap(4)
    .child(text(label,t.dim,10)).child(text(value,t.foreground,10)))));
  // What the alerts say changed: highlighted, on top.
  if(d.alerts.length)body.child(v_flex().id(`task-issue-detail-alerts-${id}`).gap(4).p(8).rounded(7).border(1).border_color(t.accent)
    .bg((t.accent||'#888888').slice(0,7)+'14')
    .child(text(`새 알림 ${d.alerts.length}건`,t.accent,10).font_bold())
    .children(d.alerts.map((a,i)=>h_flex().id(`task-issue-detail-alert-${id}-${i}`).gap(6).items_center()
      .child(div().px(5).rounded(3).flex_none().text_size(9).font_bold().bg(kindTone(a.kind,t)).text_color(t.accent_foreground||t.background).child(a.category||'알림'))
      .child(text(a.text,t.foreground,10).flex_1()).child(text(clock(a.at),t.dim,9).flex_none()))));
  if(d.description)body.child(wrap(d.description,t.muted,11).p(8).rounded(7).bg(t.surface||t.background));
  if(!d.loaded)body.child(text(d.error?`Linear 읽기 실패: ${d.error}`:model.detailWaiting?'Linear에서 상세를 읽는 중…':'상세를 아직 읽지 않았습니다',d.error?t.blocked:t.dim,10));
  else if(d.error)body.child(text(`최근 읽기 실패: ${d.error} · ${clock(d.at)} 결과`,t.blocked,10));
  if(d.comments.length){
    body.child(text(`최근 댓글 ${d.comments.length}`,t.dim,10).font_bold());
    body.children(d.comments.map((c,i)=>v_flex().id(`task-issue-detail-comment-${id}-${i}`).gap(2).p(8).rounded(7).border(1).border_color(t.border)
      .child(h_flex().gap(6).child(text(c.author||'작성자 미상',t.foreground,10).font_bold()).child(text(clock(c.at),t.dim,9)))
      .child(wrap(c.body,t.muted,10))));
  }else if(d.loaded)body.child(text('댓글 없음',t.dim,10));
  if(d.agents.length){
    body.child(text('이 이슈의 에이전트 작업',t.dim,10).font_bold());
    body.children(d.agents.map((a,i)=>h_flex().id(`task-issue-detail-agent-${id}-${i}`).gap(6).items_center()
      .child(div().size(6).rounded(3).flex_none().bg(a.status==='working'?t.ansi3||t.accent:t.dim))
      .child(text(a.title,t.foreground,10).flex_1()).child(text(a.status,t.dim,9).flex_none())));
  }
  // Buttons. Writes only on press, through the collector's guard (one call, exact arguments).
  const writes=model.writes||[];
  const actions=h_flex().gap(6).flex_wrap().pt(4)
    .when(d.alerts.length>0&&model.readable,row=>row.child(button(`task-issue-detail-read-${id}`,'읽음',t,{onClick:()=>model.onRead?.(d.alerts),accent:true})))
    .child(button(`task-issue-detail-state-${id}`,'상태 변경',t,{onClick:()=>model.onMenu?.(model.menu==='state'?null:'state'),
      enabled:writes.includes('set_state'),tip:writes.includes('set_state')?'Linear 상태를 바꿉니다':'이 컴퓨터에서 상태 변경이 꺼져 있습니다'}))
    .child(button(`task-issue-detail-comment-${id}`,'댓글',t,{onClick:()=>model.onMenu?.(model.menu==='comment'?null:'comment'),
      enabled:writes.includes('comment'),tip:writes.includes('comment')?'Linear에 댓글을 남깁니다':'이 컴퓨터에서 댓글 쓰기가 꺼져 있습니다'}))
    .child(button(`task-issue-detail-open-${id}`,'Linear에서 열기 ↗',t,{onClick:()=>model.onLink?.(d.url),enabled:Boolean(d.url),tip:'전체 편집은 웹에서'}));
  body.child(actions);
  if(model.menu==='state'){
    const list=model.statuses||[];
    body.child(h_flex().id(`task-issue-detail-states-${id}`).flex_wrap().gap(4)
      .children(list.length?list.map((s,i)=>div().id(`task-issue-detail-state-${id}-${i}`).h(22).px(8).rounded(11).border(1)
        .border_color(s.name===d.status?.name?statusTone(s,t):t.border).flex().items_center().gap(3)
        .when(s.name!==d.status?.name,b=>b.cursor_pointer().on_click(press(model.onSetState,s.name)))
        .child(text(statusLook(s).icon,statusTone(s,t),10)).child(text(s.name,t.foreground,10))):[text('팀 상태 목록을 아직 읽지 않았습니다',t.dim,10)]));
  }
  if(model.menu==='comment'&&model.commentBox){
    body.child(h_flex().gap(6).items_center().child(model.commentBox)
      .child(button(`task-issue-detail-send-${id}`,'보내기',t,{onClick:()=>model.onComment?.(),accent:true})));
  }
  if(model.writeNote)body.child(text(model.writeNote,/^실패/.test(model.writeNote)?t.blocked:t.dim,10));
  return body;
}

const MILESTONE_ICON={done:'✔',started:'◐',planned:'○'};
// Every milestone of the project, Linear's order: icon · name · target · issues · progress, unread
// alerts on it; a pressed row unfolds its issues (a pressed issue opens its detail).
export function milestoneRows(model,t){
  const id=model.id,list=v_flex().gap(2);
  for(const m of model.milestones||[]){
    const open=model.expanded?.has(m.id),tone=m.status==='done'?t.ansi4||t.accent:m.status==='started'?t.ansi3||t.accent:t.dim;
    list.child(h_flex().id(`task-issues-milestone-${id}-${m.id}`).h(34).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(open,row=>row.bg(t.selected))
      .on_click(press(model.onMilestone,m.id))
      .child(text(open?'▾':'▸',t.dim,10).flex_none())
      .child(text(MILESTONE_ICON[m.status]||'○',tone,12).flex_none().font_bold())
      .child(text(m.name,t.foreground,12).flex_1().tooltip(m.name))
      .when(m.unread>0,row=>row.child(div().id(`task-issues-milestone-unread-${id}-${m.id}`).h(16).px(5).flex_none().rounded(8).bg(t.accent)
        .text_color(t.accent_foreground||t.background).text_size(9).font_bold().flex().items_center().child(`미확인 ${m.unread}`)))
      .child(text(m.target?m.target.slice(5).replace('-','/'):'—',t.dim,10).w(40).flex_none())
      .child(text(Number.isInteger(m.issues)?`${m.issues}건`:'—',t.muted,10).w(36).flex_none())
      .child(text(m.progress===null?'—':`${Math.round(m.progress)}%`,tone,10).w(34).flex_none().font_bold()
        .when(m.counted,c=>c.tooltip('Linear 값이 없어 이슈 상태로 계산한 값'))));
    if(open){
      if(!m.items.length)list.child(text(model.projectWaiting?'이슈를 읽는 중…':'이 마일스톤의 이슈를 아직 읽지 않았습니다',t.dim,10).pl(28).py(4));
      for(const issue of m.items.slice(0,40)){
        const status=model.statusOf?.(issue.key);
        list.child(h_flex().id(`task-issues-milestone-issue-${id}-${issue.key}`).h(28).pl(28).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
          .on_click(press(model.onDetail,issue.key))
          .child(div().size(7).flex_none().rounded(4).bg(statusTone(status,t)))
          .child(text(issue.key,t.muted,10).w(58).flex_none().font_bold())
          .child(text(issue.title||'',t.foreground,11).flex_1().tooltip(issue.title||''))
          .child(statusChip(status,t,`task-issues-milestone-status-${id}-${issue.key}`)));
      }
    }
  }
  if(model.milestonesCounted)list.child(text('일부 값은 Linear가 주지 않아 이슈 상태로 계산했습니다(계산값)',t.dim,9).pt(4));
  return list;
}
