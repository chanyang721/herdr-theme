import {div} from 'gpui-kit';
import {h_flex} from 'gpui-base';

// Reads the per-terminal shares Plan Usage publishes (herdr-workspace-mods). Draws nothing without them.
export const SHARES_KEY='agent-usage.shares';
const NAMES={claude:'Claude',codex:'Codex'};
const REASONS={session_unconfirmed:'세션 미확인',session_not_indexed:'기록 없음',process_tree_limit:'확인 보류',remote_session_unsupported:'원격 세션'};

export function sharePercent(value){
  if(value==null||!Number.isFinite(value))return '—';
  if(value>0&&value<0.1)return '<0.1%';
  return `${value.toFixed(value<10?1:0)}%`;
}

export function paneUsageTip(entry,terminal){
  const name=NAMES[entry.agent]||'Agent';
  // An external producer can mark inactive sessions while retaining their usage.
  const asleep=entry.sleeping?' · 절전 중 (이어 열 대화)':'';
  if(!entry.known)return `${terminal} · ${name}${asleep} · ${REASONS[entry.reason]||'사용량 미확인'}`;
  const window=entry.since?`현재 주간 한도 기간(${entry.since}~)`:'최근 7일';
  const limit=entry.limitPart!=null&&entry.limitWeek!=null?`\n주간 한도 ${Math.round(entry.limitWeek)}% 중 약 ${entry.limitPart.toFixed(1)}%p`:'';
  return `${terminal}${asleep} · ${window} ${name} 사용량 중 ${sharePercent(entry.share)}${limit}${entry.model?`\n모델 ${entry.model}`:''}\n가격 비율 가중 추정 (로컬 기록)`;
}

// The pane's session share of its agent's current weekly window, as a small bar and percentage.
export function paneUsage(p,t,shared){
  const entry=shared(SHARES_KEY)?.terminals?.[p.terminal];
  if(!entry)return div().flex_none();
  const tip=paneUsageTip(entry,p.terminal);
  const chip=h_flex().id(`pane-usage-${p.pane}`).flex_none().h(18).items_center().gap(5).px(8).rounded(9)
    .bg(t.surface).border(1).border_color(t.border).text_size(12).tooltip(tip).accessibility_label(tip);
  if(!entry.known)return chip.child(div().text_color(t.dim).child(entry.sleeping?'절전 · 사용량 —':'사용량 —'));
  const share=entry.share;
  // Asleep: the same share, muted, so a parked pane never reads as a running one.
  const color=entry.sleeping?t.dim:t.accent;
  return chip.child(div().text_size(11).text_color(t.muted).child(entry.sleeping?'절전 · 이번 주':'이번 주'))
    .child(div().w(40).h(5).rounded(3).bg(t.border)
      .child(div().h(5).w(share?Math.max(2,40*Math.min(100,share)/100):0).rounded(3).bg(color)))
    .child(div().font_semibold().text_color(color).child(sharePercent(share)));
}
