import { div } from 'gpui-kit';
import { PACKET_PIXELS, snap, centred, pixelBlock, pixelRoute, pixelRing } from './pixel.js';

// One send between two workspace rows, in the task panel's pixel grammar
// (2026-11-10): a 1px right-angle pipe with stepped corners out to the lane and
// a 3x3 block that runs down it in one native transition, then a square 1px ring
// opens at the receiver. There is no per-frame JavaScript or permanent send loop;
// the caller's three finite phase changes (start, travel, arrived) drive it.
export function pipeline({id, width, from, to, color, phase, packets, motion, inset=0, unit=1}) {
  const u = unit;
  const top = Math.min(from, to);
  const height = Math.abs(to-from);
  const start = snap(from-top, u), end = snap(to-top, u), lane = snap(inset+width, u), x0 = snap(inset, u);
  const history = phase === 'history';
  const side = PACKET_PIXELS*u, offset = centred(PACKET_PIXELS, u);
  return div().id(`sf-route-${id}`).absolute().top(top).w(inset+width+4).h(height+4)
    .opacity(history ? 0.22 : phase==='arrived' ? 0.5 : 0.95).when(motion,el=>el.transition('opacity',350))
    .child(pixelRoute(start, end, lane, x0, x0, color, u))
    .when(!history&&motion, el=>el.children((packets??[{id,phase,travelMs:1600}]).flatMap(packet=>{
      const y=(packet.phase==='start'?start:end)-offset;
      return [
        pixelBlock(lane-offset, y, side, side, color, `sf-pipeline-packet-${packet.id}`)
          .opacity(packet.phase==='arrived'?0:1)
          .transition('top',{duration:packet.travelMs??1600,easing:'ease-in-out'})
          .transition('opacity',{duration:120,easing:'ease-out'}),
        pixelRing(`sf-pipeline-receiver-${packet.id}`, x0, end, packet.phase==='arrived', color, u),
      ];
    })));
}
