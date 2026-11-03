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

// The computer a known terminal lives on: its machine/ prefix, null for this
// computer, undefined when the address is no known terminal. Parked and
// background terminals have no pane, so the address is the record to read.
export function terminalMachine(address, known) {
  if (!known.has(address)) return undefined;
  const slash = address.indexOf('/');
  return slash > 0 ? address.slice(0, slash) : null;
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

// Sends between computers as seen here, newest first.
export function machineHops(events, machineOf, limit = 4) {
  const result = [];
  for (let index = events.length - 1; index >= 0 && result.length < limit; index--) {
    const hop = crossMachine(events[index], machineOf);
    if (hop) result.push({ event: events[index], hop });
  }
  return result;
}

// Per computer (null is this one): sends out to and in from other computers
// within the last `windowMs`.
export function machineTraffic(events, machineOf, now, windowMs = 10 * 60 * 1000) {
  const traffic = new Map();
  const add = (machine, key) => {
    const count = traffic.get(machine) ?? { sent: 0, received: 0 };
    count[key]++;
    traffic.set(machine, count);
  };
  for (const event of events) {
    if (!Number.isFinite(event.at) || now - event.at > windowMs) continue;
    const hop = crossMachine(event, machineOf);
    if (!hop) continue;
    add(hop.from, 'sent');
    add(hop.to, 'received');
  }
  return traffic;
}

// When the last-ten-minutes ↑/↓ counts next change with no new send: the oldest
// counted send leaving the window. Null when no send is counted.
export function trafficWake(events, machineOf, now, windowMs = 10 * 60 * 1000) {
  let wake = null;
  for (const event of events) {
    if (!Number.isFinite(event.at) || now - event.at > windowMs || !crossMachine(event, machineOf)) continue;
    const leaves = event.at + windowMs + 1;
    if (wake === null || leaves < wake) wake = leaves;
  }
  return wake;
}
