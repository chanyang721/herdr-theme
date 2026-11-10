import {div} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import {partOpen} from './linear-auto-model.js';

// The '자동 작업' group of a space's issue search, above '알림 온 이슈': finished work waiting for
// the person's approval (반영 대기), alerts a person decides (결정 필요), and work running now.
// Every button only calls back; the caller drops the request file (see linear-auto-model.js).
const text=(value,color,size=11)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);
const summary=comment=>{
  const lines=String(comment||'').split('\n').map(line=>line.trim()).filter(Boolean);
  const at=lines.findIndex(line=>line.replace(/\*/g,'')==='한 일');
  return (at>=0?lines[at+1]:lines[1]||lines[0]||'').replace(/^[-*]\s*/,'');
};

export function autoGroup(model,t){
  const {id,view}=model;
  if(!view||!(view.pending.length||view.decide.length||view.running.length))return null;
  const busy=model.busy||new Set(),change=(callback,...args)=>(_event,cx)=>{cx.stop_propagation();callback?.(...args,cx);};
  const button=(key,label,tip,action,{enabled=true,strong=false}={})=>div().id(key).h(20).px(7).flex_none().rounded(10).border(1)
    .border_color(enabled?(strong?t.accent:t.border):t.border).text_size(9).font_bold()
    .text_color(enabled?(strong?t.accent:t.muted):t.dim).flex().items_center()
    .when(enabled&&Boolean(action),e=>e.cursor_pointer().hover(s=>s.bg(t.hover||t.selected)).tooltip(tip).on_click(action)).child(label);
  const head=(r,prefix)=>h_flex().id(`${prefix}-head-${id}-${r.key}`).gap(6).items_center().px(2)
    .when(Boolean(r.url&&model.onLink),e=>e.cursor_pointer().tooltip('Linear에서 이 알림 열기').on_click(change(model.onLink,r.url)))
    .child(text(r.issue,t.muted,10).flex_none().font_bold())
    .child(text(r.title,t.foreground,12).flex_1().tooltip(r.title));
  const group=v_flex().id(`task-issues-auto-${id}`).gap(4).p(6).rounded(8).bg(t.chrome||t.surface).border(1).border_color(t.border)
    .child(h_flex().gap(6).items_center().px(2)
      .child(text('자동 작업',t.foreground,11).font_bold())
      .when(view.pending.length>0,e=>e.child(text(`반영 대기 ${view.pending.length+view.more.pending}`,t.accent,10)))
      .when(view.decide.length>0,e=>e.child(text(`결정 필요 ${view.decide.length+view.more.decide}`,t.blocked||t.accent,10)))
      .child(div().flex_1())
      .child(text(!view.enabled?'꺼짐':view.mode==='live'?(view.spaceOn?'자동 시작 켜짐':'이 공간 꺼짐'):'계획만(dry-run)',t.dim,9)
        .tooltip('Linear 알림을 분류해 할 일이면 이 공간에 작업을 보냅니다 · Linear 반영은 아래 버튼을 누를 때만')));
  for(const r of view.pending){
    const p=r.proposal,b=part=>busy.has(`${r.key}:${part}`);
    const comment=partOpen(r,'comment'),state=partOpen(r,'state');
    const done=(part,label)=>r.applied?.[part]?.ok?text(`✓ ${label}`,t.muted,9).flex_none():null;
    const card=v_flex().id(`task-issues-auto-pending-${id}-${r.key}`).gap(2).p(4).rounded(6).bg(t.selected)
      .child(head(r,'task-issues-auto-pending'))
      .child(text(summary(p.comment)||'(한 일 요약 없음)',t.muted,11).px(2).tooltip(p.comment))
      .child(text(`검사: ${p.checks.join(' · ')}`,t.dim,9).px(2))
      .when(Boolean(p.publish),e=>e.child(text(p.publish,t.blocked||t.accent,9).px(2)))
      .child(h_flex().gap(5).px(2).pt(2).items_center()
        .child(comment?button(`task-issues-auto-comment-${id}-${r.key}`,b('comment')?'처리 중':'댓글 올리기',
          'Linear 이슈에 이 댓글을 한 번 올립니다',change(model.onApprove,r,'comment'),{enabled:!b('comment'),strong:true}):done('comment','댓글'))
        .when(Boolean(p.state),e=>e.child(state?button(`task-issues-auto-state-${id}-${r.key}`,b('state')?'처리 중':`상태 → ${p.state}`,
          `Linear 이슈 상태를 ${p.from||'지금 상태'}에서 ${p.state}(으)로 바꿉니다`,change(model.onApprove,r,'state'),{enabled:!b('state'),strong:true}):done('state','상태')))
        .when(comment&&state,e=>e.child(button(`task-issues-auto-all-${id}-${r.key}`,'모두 반영','댓글과 상태 변경을 함께 반영합니다',
          change(model.onApplyAll,r),{enabled:!b('comment')&&!b('state'),strong:true})))
        .child(div().flex_1())
        .when(comment&&Boolean(model.onEdit),e=>e.child(button(`task-issues-auto-edit-${id}-${r.key}`,'수정','댓글 초안을 문서로 열어 고칩니다 · 고친 글이 올라갑니다',change(model.onEdit,r))))
        .child(button(`task-issues-auto-discard-${id}-${r.key}`,'버리기','이 반영안을 버립니다 · Linear에는 아무것도 쓰지 않습니다',change(model.onDiscard,r),{enabled:!b('comment')&&!b('state')})));
    const failed=['comment','state'].map(part=>r.applied?.[part]).find(a=>a&&a.ok===false);
    if(failed)card.child(text(`반영 실패: ${String(failed.error||'이유 미확인').slice(0,120)}`,t.blocked||t.accent,10).px(2));
    group.child(card);
  }
  for(const r of view.decide)group.child(v_flex().id(`task-issues-auto-decide-${id}-${r.key}`).gap(1).p(4).rounded(6).bg(t.selected)
    .child(head(r,'task-issues-auto-decide'))
    .child(h_flex().gap(6).px(2).items_center()
      .child(text(`결정 필요 · ${r.reason}`,t.muted,10).flex_1().tooltip(r.reason))
      .when(Boolean(model.onStart),e=>e.child(button(`task-issues-auto-start-${id}-${r.key}`,busy.has(`${r.key}:start`)?'처리 중':'작업 시작',
        '이 알림을 할 일로 보고 이 공간에 작업을 보냅니다',change(model.onStart,r),{enabled:!busy.has(`${r.key}:start`)})))));
  for(const r of view.running)group.child(h_flex().id(`task-issues-auto-running-${id}-${r.key}`).gap(6).px(6).py(2).rounded(5).items_center()
    .child(text(r.issue,t.muted,10).flex_none().font_bold())
    .child(text(r.title,t.muted,11).flex_1().tooltip(`${r.reason}${r.note?` · ${r.note}`:''}`))
    .child(text(r.label,t.dim,9).flex_none()));
  const more=view.more.pending+view.more.decide+view.more.running;
  if(more>0)group.child(text(`외 ${more}건`,t.dim,10).px(8));
  if(model.error)group.child(text(model.error,t.blocked||t.accent,10).px(4));
  return group;
}
