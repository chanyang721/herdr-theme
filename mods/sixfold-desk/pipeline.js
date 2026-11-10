import { div } from 'gpui-kit';
import { PACKET_PIXELS, snap, centred, pixelBlock, pixelRoute, pixelArrival } from './pixel.js';

// The three legs of one send, as fractions of its travel: out to the lane, down
// the lane, back in to the receiving row.
export const PIPE_LEG_SHARE = Object.freeze([0.16, 0.68, 0.16]);
export function pipeLegs(travelMs) {
  const out = Math.round(travelMs * PIPE_LEG_SHARE[0]), back = Math.round(travelMs * PIPE_LEG_SHARE[2]);
  return { out, down: travelMs - out - back, back };
}

// One send between two workspace rows, in the task panel's pixel grammar
// (2026-11-10): a 1px right-angle pipe with stepped corners out to the lane and
// a 3x3 block that leaves the sending row, runs down the lane and enters the
// receiving row; then the arrival mark (pixel.js pixelArrival) lights there.
// The three legs are three nested elements, each with one native transition: the outer one moves out, the
// middle one moves along after it, the inner one moves back in last. All three
// targets change at the caller's single `travel` phase change, so the corners
// need no extra timer and no per-frame JavaScript.
export function pipeline({id, width, from, to, color, phase, packets, motion, inset=0, unit=1, done=color}) {
  const u = unit;
  const top = Math.min(from, to);
  const height = Math.abs(to-from);
  const start = snap(from-top, u), end = snap(to-top, u), lane = snap(inset+width, u), x0 = snap(inset, u);
  const history = phase === 'history';
  const side = PACKET_PIXELS*u, offset = centred(PACKET_PIXELS, u), reach = lane - x0;
  // Only the pipe dims after arrival; the arrival mark keeps full contrast.
  return div().id(`sf-route-${id}`).absolute().top(top).w(inset+width+4).h(height+4)
    .child(pixelRoute(start, end, lane, x0, x0, color, u, `sf-pipe-${id}`)
      .opacity(history ? 0.22 : phase==='arrived' ? 0.5 : 0.95).when(motion,el=>el.transition('opacity',350)))
    .when(!history&&motion, el=>el.children((packets??[{id,phase,travelMs:1600}]).flatMap(packet=>{
      const moving = packet.phase !== 'start', legs = pipeLegs(packet.travelMs ?? 1600);
      const block = pixelBlock(moving ? -reach : 0, 0, side, side, color, `sf-pipeline-packet-${packet.id}`)
        .opacity(packet.phase==='arrived'?0:1)
        .transition('left',{duration:legs.back,delay:legs.out+legs.down,easing:'ease-out'})
        .transition('opacity',{duration:120,easing:'ease-out'});
      const along = div().id(`sf-pipeline-along-${packet.id}`).absolute().left(0).top((moving?end:start)-offset)
        .transition('top',{duration:legs.down,delay:legs.out,easing:'ease-in-out'}).child(block);
      const out = div().id(`sf-pipeline-out-${packet.id}`).absolute().top(0).left(x0-offset+(moving?reach:0))
        .transition('left',{duration:legs.out,easing:'ease-in'}).child(along);
      return [out, ...pixelArrival(`sf-pipeline-receiver-${packet.id}`, x0, end, packet.phase==='arrived', done, u)];
    })));
}
