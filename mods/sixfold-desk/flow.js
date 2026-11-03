// Never replay old traffic after a reload, or mistake an updated log for one send.
export function freshMessages(previous, incoming, now = Date.now()) {
  if (previous === null) return [];
  const seen = new Set(previous.map(event => event.id));
  const added = new Set();
  const watermark=Math.max(0,...previous.map(event=>Number.isSafeInteger(event.seq)?event.seq:0));
  return incoming.filter(event => {
    if (!event.id || seen.has(event.id) || added.has(event.id)
        || !event.source || !event.target || event.source === event.target
        || !Number.isFinite(event.at) || event.at > now + 1000) return false;
    if(Number.isSafeInteger(event.seq)) { if(event.seq<=watermark)return false; }
    else if(now-event.at>15000)return false;
    added.add(event.id);
    return true;
  }).sort((a, b) => a.at - b.at);
}

// A pair can carry several messages; opposite directions remain separate.
export function recentRoutes(events, limit = 3) {
  const pairs = new Map();
  for (const event of events) {
    if (!event.source || !event.target || event.source === event.target) continue;
    const key = JSON.stringify([event.source, event.target]);
    const previous = pairs.get(key);
    pairs.set(key, { ...event, count: (previous?.count ?? 0) + 1 });
  }
  return [...pairs.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

// Draw a route once while retaining every independently moving message on it.
export function simultaneousRoutes(flows) {
  const routes = new Map();
  for (const flow of flows) {
    const key=JSON.stringify([flow.source,flow.target]);
    if(!routes.has(key))routes.set(key,{...flow,id:`route-${key}`,packets:[],count:0});
    const route=routes.get(key);
    route.packets.push(flow);
    route.count++;
    if(flow.at>route.at)route.at=flow.at;
  }
  return [...routes.values()].map(route=>({...route,phase:route.packets.every(p=>p.phase==='arrived')?'arrived':route.packets.every(p=>p.phase==='start')?'start':'travel'}));
}

// A route whose two ends live on different computers. `machineOf` returns the
// endpoint's machine (null for this computer) or undefined when it is unknown.
// `far` is the other computer to name: the target, or the source when the target is here.
export function crossMachine(route, machineOf) {
  const from = machineOf(route.source), to = machineOf(route.target);
  return from !== undefined && to !== undefined && from !== to ? { from, to, far: to ?? from } : null;
}

// Follow focus onto another computer, but keep a manual pick until focus moves there.
// A null focusKey (no focused space) is not a move and changes nothing.
export function followComputer(state, focusKey, saved) {
  const valid = typeof saved === 'string' && (saved === 'local' || /^(remote|tailscale):.+/.test(saved));
  if (focusKey === null) return state.follow && state.lastFocus !== undefined ? state.lastFocus : valid ? saved : 'local';
  if (state.lastFocus !== undefined && state.lastFocus !== focusKey) state.follow = true;
  state.lastFocus = focusKey;
  if (state.follow || !valid) return focusKey;
  return saved;
}
