import {View, div, svg} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {agents, focused, theme, shared, props} from 'herdr';
import {petSessions, petOptions, petTooltip, petWalks} from './model.js';

export default class SessionPets extends View {
  render(cx) {
    const t=theme(), options=petOptions(shared);
    if (!options.enabled && !props()?.preview) return div();
    // preview fixtures are explicit, local-only input; the installed layout never sets them.
    const sessions=petSessions(props()?.preview?.agents || agents(), props()?.preview?.space || focused()?.space);
    const motion=options.motion && props()?.preview?.motion !== false;
    const {walking, wake}=petWalks(this.petMemory ??= {}, sessions);
    // One wake when the last walk ends, so the pet is drawn standing again.
    if (motion && wake !== null && wake !== this.petWakeAt && typeof cx?.timer?.after === 'function') {
      this.petWake?.cancel?.(); this.petWakeAt=wake;
      this.petWake=cx.timer.after(Math.max(1, wake-Date.now()), cx=>{this.petWake=null; this.petWakeAt=null; cx.notify();});
    }
    return h_flex().size_full().gap(4).px(10).items_end().overflow_hidden()
      .children(sessions.map(a => div().id(`pet-${a.address}`).relative().flex_1().min_w(16).h(16)
        .tooltip(petTooltip(a)).accessibility_label(petTooltip(a))
        // Swallow presses so a draggable toolbar cannot interpret a pet press as focus/navigation.
        .on_mouse_down('left', (_event,cx)=>cx.stop_propagation())
        .child(div().absolute().bottom(0).left(0).right(0).h(1).bg(t[a.token] || t.muted).opacity(0.25))
        .child(svg(`mods/session-pets/icons/${a.pose}.svg`).id(`pet-glyph-${a.address}-${a.pose}`)
          .absolute().bottom(2).left(2).size(12).text_color(t.muted).opacity(0.45)
          .when(motion && walking.has(a.address), e=>e.loop('left',{from:2,to:8,period:12000})))));
  }
}
