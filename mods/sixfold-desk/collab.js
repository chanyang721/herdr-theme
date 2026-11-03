// Same-project work across computers, read from space names and live agent
// status only. It shows that two computers work on one project at the same
// time; it is not evidence that anything passed between them.

const NO_PROJECT = new Set(['', '~']);

// "거상 제어판 (sub1)" on sub1 is the same project as "거상 제어판": a trailing
// "(name)" is dropped when it names the space's own computer (id or label).
export function projectName(space, labelOf = () => null) {
  const name = String(space?.name ?? '').trim();
  const machine = space?.machine ?? null;
  const own = [machine, labelOf(machine)].filter(Boolean).map(value => String(value).trim().toLowerCase());
  const match = name.match(/^(.*\S)\s*\(([^()]+)\)$/);
  return match && own.includes(match[2].trim().toLowerCase()) ? match[1] : name;
}

const projectKey = name => name.normalize('NFC').toLowerCase();

// Agent status counts per computer (null is this one), by the agent's space.
export function machineCounts(agentList, spaceList) {
  const machineOf = new Map(spaceList.map(space => [space.id, space.machine ?? null]));
  const result = new Map();
  for (const agent of agentList) {
    if (!machineOf.has(agent.space)) continue;
    const machine = machineOf.get(agent.space);
    const count = result.get(machine) ?? { blocked: 0, done: 0, working: 0, idle: 0 };
    if (agent.status in count) count[agent.status]++;
    result.set(machine, count);
  }
  return result;
}

// Projects that have a space on two or more computers: a linked group of any
// size. Machines are listed with this computer (null) first; `working` gives
// each one's working agents there, and `active` means at least two of them
// are working on it now.
export function projectGroups(agentList, spaceList, labelOf = () => null) {
  const projects = new Map();
  const project = space => {
    const name = projectName(space, labelOf);
    if (NO_PROJECT.has(name)) return null;
    const key = projectKey(name);
    const found = projects.get(key) ?? { name, working: new Map() };
    if ((space.machine ?? null) === null) found.name = name;  // Prefer this computer's spelling.
    projects.set(key, found);
    return found;
  };
  for (const space of spaceList) {
    const found = project(space);
    if (found && !found.working.has(space.machine ?? null)) found.working.set(space.machine ?? null, 0);
  }
  const spaceById = new Map(spaceList.map(space => [space.id, space]));
  for (const agent of agentList) {
    const space = spaceById.get(agent.space);
    if (agent.status !== 'working' || !space) continue;
    const found = project(space), machine = space.machine ?? null;
    if (found) found.working.set(machine, (found.working.get(machine) ?? 0) + 1);
  }
  const order = machine => machine === null ? '' : `~${machine}`;
  return [...projects.values()]
    .filter(found => found.working.size >= 2)
    .map(found => {
      const machines = [...found.working.keys()].sort((a, b) => order(a).localeCompare(order(b)));
      const working = machines.map(machine => found.working.get(machine));
      return { name: found.name, machines, working, active: working.filter(count => count > 0).length >= 2 };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.machines.length - a.machines.length || a.name.localeCompare(b.name));
}

// Linked groups with at least two computers working on them now.
export function collaborations(agentList, spaceList, labelOf = () => null) {
  return projectGroups(agentList, spaceList, labelOf).filter(group => group.active);
}

// Sends between computers, filed under the smallest group holding both ends
// (the most specific project); the rest stay apart. Pairs are kept as sent.
export function groupSends(hops, groups, perGroup = 3, rest = 3) {
  const byGroup = groups.map(() => []);
  const others = [];
  for (const item of hops) {
    let best = -1;
    groups.forEach((group, index) => {
      if (group.machines.includes(item.hop.from) && group.machines.includes(item.hop.to)
          && (best < 0 || group.machines.length < groups[best].machines.length)) best = index;
    });
    if (best >= 0) { if (byGroup[best].length < perGroup) byGroup[best].push(item); }
    else if (others.length < rest) others.push(item);
  }
  return { byGroup, others };
}

// How long a send keeps two computers joined after it.
export const LINK_SEND_MS = 5 * 60 * 1000;

// Computers to join in the gutter now. A project being worked on from two or
// more computers joins those working computers. A send within `windowMs` joins
// its two computers unless they are already joined. Nothing else is drawn: a
// shared name alone, or an old send, never links computers.
export function liveLinks(groups, hops, now, windowMs = LINK_SEND_MS) {
  const links = [];
  for (const group of groups) {
    const machines = group.machines.filter((_machine, index) => group.working[index] > 0);
    if (machines.length >= 2) links.push({ key: `project:${group.name}`, name: group.name, machines, working: true });
  }
  const order = machine => machine === null ? '' : `~${machine}`;
  for (const { event, hop } of hops) {
    if (!Number.isFinite(event.at) || now - event.at > windowMs) continue;
    if (links.some(link => link.machines.includes(hop.from) && link.machines.includes(hop.to))) continue;
    const machines = [hop.from, hop.to].sort((a, b) => order(a).localeCompare(order(b)));
    links.push({ key: `send:${machines.join('|')}`, name: null, machines, working: false });
  }
  return links;
}

// Mix two theme colours ("#rgb", "#rrggbb", optional alpha): `amount` of the
// way from `color` to `toward`. An unreadable colour is returned as it is.
export function tone(color, toward, amount) {
  const parse = value => {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(String(value ?? '').trim())?.[1];
    if (!hex || ![3, 4, 6, 8].includes(hex.length)) return null;
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map(c => c + c).join('') : hex.slice(0, 6);
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  };
  const from = parse(color), to = parse(toward);
  if (!from || !to) return color;
  return '#' + from.map((c, i) => Math.round(c + (to[i] - c) * amount).toString(16).padStart(2, '0')).join('');
}

// Colours for computer-to-computer pipes, apart from the in-computer route
// palette (accent, ansi2-6): the bright ansi tones, muted toward `dim`. Each
// gives a quiet `link` tone near the sidebar and a brighter `packet` tone.
export function linkPalette(t) {
  const background = t.chrome ?? t.background, grey = t.dim ?? t.muted;
  return ['ansi14', 'ansi13', 'ansi12', 'ansi10'].map(name => {
    const base = tone(t[name] ?? t.accent, grey, 0.35);
    return { link: tone(base, background, 0.45), packet: base };
  });
}
