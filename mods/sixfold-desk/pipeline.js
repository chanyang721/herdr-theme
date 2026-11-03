import { div, PathBuilder } from 'gpui-kit';

// A moving clipping window reveals a bright segment of a fixed Bezier curve.
// Its child moves by the inverse offset, keeping the curve aligned. Both are
// native transitions: there is no per-frame JavaScript or permanent send loop.
export function pipeline({id, width, from, to, color, phase, packets, motion}) {
  const top = Math.min(from, to);
  const height = Math.abs(to-from);
  const start = from-top, end = to-top;
  const path = stroke => PathBuilder.stroke(stroke).move_to(0,start)
    .cubic_bezier_to(0,end,width*4/3,start,width*4/3,end).build();
  const shape = (stroke, tint) => window.paint_path(path(stroke),tint).absolute().left(0).top(0).w(width+4).h(height+4);
  return div().id(`sf-route-${id}`).absolute().top(top).w(width+4).h(height+4)
    .opacity(phase==='arrived' ? 0.65 : 1).transition('opacity',350)
    .child(shape(7,color).opacity(0.15))
    .child(shape(2,color).opacity(0.7))
    .child(div().id(`sf-route-source-${id}`).absolute().left(-4).top(start-4).size(8).rounded(4).border(2).border_color(color))
    .child(div().id(`sf-route-target-${id}`).absolute().left(-5).top(end-7).text_size(13).font_bold().text_color(color).child(to>=from?'▼':'▲'))
    .children((packets??[{id,phase}]).map((packet,index)=>{
      const position=packet.phase==='start'&&motion?start:end;
      const duration={duration:packet.travelMs??2600,easing:'linear'};
      const band=40+(index%3)*10;
      return div().id(`sf-pipeline-window-${packet.id}`).absolute().left(-4).top(position-band/2).w(width+12).h(band).overflow_hidden()
        .when(motion,el=>el.transition('top',duration))
        .child(div().id(`sf-pipeline-path-${packet.id}`).absolute().left(4).top(band/2-position).w(width+4).h(height+4)
          .when(motion,el=>el.transition('top',duration))
          .child(shape(5+index%2,color)));
    }));
}
