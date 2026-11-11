import {div} from 'gpui-kit';
import {h_flex} from 'gpui-base';

// What the pane's Claude session is working on, as Plan Usage publishes it per terminal
// (agent-usage.shares → terminals[t].work, read by Agent Usage's work.py from Claude's own files):
// task-list progress and running sub-agents. A pane without a confirmed session shows nothing.
export const SHARES_KEY='agent-usage.shares';

export function paneWork(terminal,shared){
  const work=shared(SHARES_KEY)?.terminals?.[terminal]?.work;
  if(!work||typeof work!=='object')return null;
  const tasks=work.tasks?.total>0?work.tasks:null;
  const agents=work.subagents?.running>0?work.subagents:null;
  return tasks||agents?{tasks,agents}:null;
}

// Labels for the header: full words when wide, short ones when medium or narrow.
export function workParts(work,width){
  const wide=width==null||width>=560;
  const parts=[];
  if(work.tasks)parts.push({kind:'tasks',text:`${wide?'할 일 ':''}${work.tasks.completed}/${work.tasks.total}`,
    done:work.tasks.completed===work.tasks.total});
  if(work.agents)parts.push({kind:'agents',text:wide?`서브에이전트 ${work.agents.running} 실행 중`:`서브 ${work.agents.running}`});
  return parts;
}

export function workTip(work){
  const lines=[];
  if(work.tasks){
    const {completed,in_progress:progress,pending,total,current}=work.tasks;
    lines.push(`할 일 ${completed}/${total} 완료 · 진행 중 ${progress} · 대기 ${pending}`);
    if(current)lines.push(`지금: ${current}`);
  }
  if(work.agents){
    lines.push(`서브에이전트 ${work.agents.running}개 실행 중`);
    for(const name of work.agents.names||[])lines.push(`· ${name}`);
  }
  lines.push('Claude 할 일 목록·서브에이전트 기록 기준 (최대 2분 늦음)');
  return lines.join('\n');
}

export function paneWorkChip(p,t,work,width){
  const tip=workTip(work);
  const chip=h_flex().id(`pane-work-${p.pane}`).flex_none().h(18).items_center().gap(6).px(8).rounded(9)
    .bg(t.surface).border(1).border_color(t.border).text_size(11).tooltip(tip).accessibility_label(tip);
  for(const part of workParts(work,width)){
    if(part.kind==='tasks'){
      const share=work.tasks.completed/work.tasks.total;
      chip.child(h_flex().items_center().gap(4)
        .child(div().w(18).h(4).rounded(2).bg(t.border).child(div().h(4).w(share?Math.max(2,18*share):0).rounded(2).bg(part.done?t.muted:t.accent)))
        .child(div().text_color(part.done?t.muted:t.foreground).child(part.text)));
    }else{
      chip.child(h_flex().items_center().gap(4)
        .child(div().size(6).rounded(3).flex_none().bg(t.working||t.accent))
        .child(div().font_semibold().text_color(t.working||t.foreground).child(part.text)));
    }
  }
  return chip;
}
