import {div,svg} from 'gpui-kit';

const PET_BOX={width:24,height:22};
const MOTION={working:{axis:'left',from:0,to:9,period:620},blocked:{axis:'left',from:0,to:3,period:180},done:{axis:'top',from:0,to:2,period:1250},idle:{axis:'top',from:0,to:1,period:3200}};
const LABELS={working:'작업 중',blocked:'확인 필요',done:'완료 · 미확인',idle:'대기'};

export function panePetState(status){
  const known=['working','blocked','done','idle'].includes(status)?status:'idle';
  return {status:known,pose:({working:'walk',blocked:'raise',done:'sit',idle:'sleep'})[known],motion:MOTION[known]};
}

export function panePet(p,t,shared){
  const options={enabled:shared('sixfold.pets')!==false,motion:shared('sixfold.motion')!==false&&shared('sixfold.pets.motion')!==false};
  if(!options.enabled)return div().w(PET_BOX.width).h(PET_BOX.height);
  const state=panePetState(p.status);
  const color=state.status==='working'?t.working:state.status==='blocked'?t.blocked:state.status==='done'?t.done||t.ansi2:t.accent;
  const config=MOTION[state.status];
  const name=p.title||p.program?.name||p.terminal||'session';
  const tooltip=`${name} · ${LABELS[state.status]}`;
  return div().id(`pane-pet-${p.pane||p.terminal}`).relative().flex_none().w(PET_BOX.width).h(PET_BOX.height).overflow_hidden()
    .tooltip(tooltip)
    .accessibility_label(tooltip)
    .child(svg(`mods/session-pets/icons/${state.pose}.svg`).id(`pane-pet-glyph-${p.pane||p.terminal}`)
      .absolute().left(0).bottom(0).size(20).text_color(color)
      .when(options.motion,e=>e.loop(config.axis,{from:config.from,to:config.to,period:config.period})))
    .when(state.status==='blocked',e=>e.child(div().absolute().right(0).top(0).size(8).rounded_full().bg(t.blocked).text_size(7).font_bold().text_color(t.canvas).items_center().justify_center().child('!')))
    .when(state.status==='done',e=>e.child(div().absolute().left(2).bottom(0).size(3).rounded_full().bg(t.done||t.ansi2)
      .when(options.motion,dot=>dot.loop('top',{from:0,to:2,period:900}))));
}

export function petBox(){return PET_BOX;}
