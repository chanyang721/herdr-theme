// Never replay old traffic after a reload, or mistake an updated log for one send.
export function freshMessages(previous, incoming, now = Date.now()) {
  if (previous === null) return [];
  const seen = new Set(previous.map(event => event.id));
  const added = new Set();
  return incoming.filter(event => {
    if (!event.id || seen.has(event.id) || added.has(event.id)
        || !event.source || !event.target || event.source === event.target
        || !Number.isFinite(event.at) || now - event.at > 15000 || event.at > now + 1000) return false;
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
