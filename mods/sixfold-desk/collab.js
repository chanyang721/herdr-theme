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

// Projects with a working agent on two or more computers, by name.
// Machines are listed with this computer (null) first.
export function collaborations(agentList, spaceList, labelOf = () => null) {
  const spaceById = new Map(spaceList.map(space => [space.id, space]));
  const projects = new Map();
  for (const agent of agentList) {
    if (agent.status !== 'working') continue;
    const space = spaceById.get(agent.space);
    if (!space) continue;
    const name = projectName(space, labelOf);
    if (NO_PROJECT.has(name)) continue;
    const key = projectKey(name);
    const project = projects.get(key) ?? { name, machines: new Set() };
    if ((space.machine ?? null) === null) project.name = name;  // Prefer this computer's spelling.
    project.machines.add(space.machine ?? null);
    projects.set(key, project);
  }
  const order = machine => machine === null ? '' : `~${machine}`;
  return [...projects.values()]
    .filter(project => project.machines.size >= 2)
    .map(project => ({ name: project.name, machines: [...project.machines].sort((a, b) => order(a).localeCompare(order(b))) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
