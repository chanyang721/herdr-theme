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
    // Hops come newest first, so this is the pair's latest send: the link ends at `until`.
    links.push({ key: `send:${machines.join('|')}`, name: null, machines, working: false, until: event.at + windowMs });
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

// How long an ended link takes to fade before it leaves.
export const LINK_FADE_MS = 1500;

// Keep each drawn link in its lane while it lasts, in `seen` (key -> {link, gone, slot}).
// Ended links are dropped first, so their lanes are free for new ones in the same
// pass; with all lanes taken, the link fading longest gives its lane up. Without
// motion an ended link leaves at once. `wake` is when the drawing next changes
// with no new event: a send link reaching its end, or a fade finishing.
export function trackLinks(seen, links, now, motion = true, slots = 4) {
  const live = new Set(links.map(link => link.key));
  for (const [key, entry] of seen) {
    if (live.has(key)) continue;
    entry.gone ??= now;
    if (!motion || now - entry.gone >= LINK_FADE_MS) seen.delete(key);
  }
  for (const link of links) {
    const entry = seen.get(link.key);
    if (entry) { entry.link = link; entry.gone = null; continue; }
    const used = new Set([...seen.values()].map(item => item.slot));
    let slot = [...Array(slots).keys()].find(value => !used.has(value));
    if (slot === undefined) {
      const fading = [...seen].filter(([, item]) => item.gone !== null).sort((a, b) => a[1].gone - b[1].gone)[0];
      if (!fading) continue;
      seen.delete(fading[0]);
      slot = fading[1].slot;
    }
    seen.set(link.key, { link, gone: null, slot });
  }
  const wakes = [...seen.values()].map(item => item.gone !== null ? item.gone + LINK_FADE_MS : item.link.until).filter(Number.isFinite);
  return { lanes: [...seen.values()].sort((a, b) => a.slot - b.slot), wake: wakes.length ? Math.min(...wakes) : null };
}

// The collaboration colour (periwinkle), apart from the accent and the amber "needs you".
// Text in it must read at 4.5:1 or more on whatever it is drawn over (`ground`: a header's
// surface or selected colour, which may be a translucent overlay on the surface). Of the
// two periwinkles the one that reads better is used; when neither reaches 4.5:1 (win98's
// grey, say) it is darkened or lightened until it does, else the theme's foreground.
export const COLLAB_COLORS = { dark: '#A9B8FF', light: '#3346B8' };
export const COLLAB_CONTRAST = 4.5;

function rgba(value) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(String(value ?? '').trim())?.[1];
  if (!hex || ![3, 4, 6, 8].includes(hex.length)) return null;
  const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
  const parts = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  return [...parts, full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1];
}

// An opaque colour for `value` drawn over `base` (alpha composited), as [r, g, b].
function over(value, base) {
  const top = rgba(value), under = base ? over(base) : [0, 0, 0];
  if (!top) return under;
  return [0, 1, 2].map(i => Math.round(top[i] * top[3] + under[i] * (1 - top[3])));
}

function luminance([r, g, b]) {
  const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const toHex = rgb => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();

export function collabColor(t, ground = t?.surface) {
  const base = t?.surface ?? t?.background;
  const back = over(ground ?? base, ground && ground !== base ? base : null);
  const options = [COLLAB_COLORS.dark, COLLAB_COLORS.light].map(color => ({ color, rgb: rgba(color).slice(0, 3) }))
    .map(item => ({ ...item, ratio: contrast(item.rgb, back) })).sort((a, b) => b.ratio - a.ratio);
  if (options[0].ratio >= COLLAB_CONTRAST) return options[0].color;
  const target = luminance(back) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  for (let step = 1; step <= 20; step++) {
    const rgb = options[0].rgb.map((c, i) => c + (target[i] - c) * step / 20);
    if (contrast(rgb, back) >= COLLAB_CONTRAST) return toHex(rgb);
  }
  return t?.foreground ?? options[0].color;
}

// Text on a filled collaboration badge: black or white, whichever reads better.
export function onCollab(color) {
  const rgb = rgba(color)?.slice(0, 3) ?? [169, 184, 255];
  return contrast(rgb, [0, 0, 0]) >= contrast(rgb, [255, 255, 255]) ? '#000000' : '#FFFFFF';
}

// A workspace's partners: the other computers with a space of the same project
// (projectGroups), whether or not anyone is working there now. Null without one.
export function spacePartners(groups, space, labelOf = () => null) {
  const name = projectName(space, labelOf).normalize('NFC').toLowerCase();
  const machine = space?.machine ?? null;
  const group = groups.find(item => item.name.normalize('NFC').toLowerCase() === name && item.machines.includes(machine));
  if (!group) return null;
  const partners = group.machines.filter(other => other !== machine);
  if (!partners.length) return null;
  const working = partners.map(other => group.working[group.machines.indexOf(other)]);
  // Worked on together now: agents working here and on at least one partner. This is the
  // card's own state, apart from the pipe lanes (which are capped at four).
  const here = group.working[group.machines.indexOf(machine)] > 0;
  const activePartners = here ? partners.filter((_other, index) => working[index] > 0) : [];
  return { group, partners, working, active: activePartners.length > 0, activePartners };
}
