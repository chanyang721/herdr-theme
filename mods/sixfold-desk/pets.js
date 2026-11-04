import {div,svg} from 'gpui-kit';

// A small cat in each pane header: it gallops while the agent works, sits when it needs you
// or has finished, and sleeps when idle. Every motion runs natively and only while drawn, so a
// hidden header or one with motion off costs no script work.
const PET_BOX={width:24,height:22};
export const RUN_FRAMES=5;
export const RUN_FRAME_MS=110;
const LABELS={working:'작업 중',blocked:'확인 필요',done:'완료 · 미확인',idle:'대기'};
// Idle breathing and the "needs you" fidget are native loops; running is a native frame cycle.
const MOTION={blocked:{axis:'left',from:0,to:2,period:220},idle:{axis:'top',from:0,to:1,period:3200}};

export function panePetState(status){
  const known=['working','blocked','done','idle'].includes(status)?status:'idle';
  return {status:known,pose:({working:'run',blocked:'sit',done:'sit',idle:'sleep'})[known],motion:MOTION[known]||null};
}

export function petRunning(status,shared){
  return status==='working'&&shared('sixfold.pets')!==false&&shared('sixfold.motion')!==false&&shared('sixfold.pets.motion')!==false;
}

// `frames` can only change an element's text, so each run frame sits behind a gate whose width
// is that text: the gate holds a wide transparent string on its own turn and nothing otherwise.
// Every view shares one frame clock, so exactly one gate is open at a time.
const RUN_GATE='MM';
export function runGate(frame){
  return Array.from({length:RUN_FRAMES},(_,i)=>i===frame?RUN_GATE:'');
}

function runner(id,color){
  return div().id(`pane-pet-run-${id}`).absolute().left(0).bottom(2).w(24).h(16).overflow_hidden()
    .children(Array.from({length:RUN_FRAMES},(_,frame)=>div().absolute().left(0).top(0).h(16).flex().overflow_hidden()
      .child(div().h(16).text_size(40).text_color('#00000000').frames(runGate(frame),RUN_FRAME_MS))
      .child(svg(petGlyph({pose:'run'},frame)).id(`pane-pet-glyph-${id}-${frame}`).absolute().left(0).top(0).w(24).h(16).text_color(color))));
}

export function petGlyph(state,frame){
  return state.pose==='run'?`mods/sixfold-desk/icons/cat/run-${((frame%RUN_FRAMES)+RUN_FRAMES)%RUN_FRAMES}.svg`:`mods/sixfold-desk/icons/cat/${state.pose}.svg`;
}

export function panePet(p,t,shared){
  const options={enabled:shared('sixfold.pets')!==false,motion:shared('sixfold.motion')!==false&&shared('sixfold.pets.motion')!==false};
  if(!options.enabled)return div().w(PET_BOX.width).h(PET_BOX.height);
  const state=panePetState(p.status);
  const color=state.status==='working'?t.working:state.status==='blocked'?t.blocked:state.status==='done'?t.done||t.ansi2:t.accent;
  const name=p.title||p.program?.name||p.terminal||'session';
  const tooltip=`${name} · ${LABELS[state.status]}`;
  const id=p.pane||p.terminal;
  // Without motion the runner holds its stretched-out frame.
  const glyph=state.pose==='run'&&options.motion?runner(id,color):svg(petGlyph(state,0)).id(`pane-pet-glyph-${id}`)
    .absolute().left(0).bottom(2).w(24).h(16).text_color(color)
    .when(options.motion&&Boolean(state.motion),e=>e.loop(state.motion.axis,{from:state.motion.from,to:state.motion.to,period:state.motion.period}));
  return div().id(`pane-pet-${id}`).relative().flex_none().w(PET_BOX.width).h(PET_BOX.height).overflow_hidden()
    .tooltip(tooltip)
    .accessibility_label(tooltip)
    .child(glyph)
    .when(state.status==='blocked',e=>e.child(div().absolute().right(0).top(0).size(8).rounded_full().bg(t.blocked).text_size(7).font_bold().text_color(t.canvas).items_center().justify_center().child('!')))
    .when(state.status==='done',e=>e.child(div().absolute().right(1).top(1).size(5).rounded_full().bg(t.done||t.ansi2)));
}

export function petBox(){return PET_BOX;}
