// Labels describe the source of connectivity; Tailscale discovery is not SSH.
export function computerKind(os, deviceName = '') {
  switch (String(os ?? '').toLowerCase()) {
    case 'macos': case 'darwin': return 'laptop';
    case 'windows': return 'desktop';
    case 'ipados': return 'tablet';
    case 'ios': return /^ipad(?:\b|[-_ ])/i.test(String(deviceName)) ? 'tablet' : 'phone';
    case 'android': return 'phone';
    default: return 'computer';
  }
}

export function computerStatus(machine, lang = 'ko', platform = 'macos') {
  if (machine.name == null) {
    if (platform === 'macos') return lang === 'ko' ? '이 Mac' : 'This Mac';
    return lang === 'ko' ? '이 컴퓨터' : 'This computer';
  }
  const state = machine.layout === 'ready'
    ? (lang === 'ko' ? '연결됨' : 'Connected')
    : machine.layout === 'loading'
      ? (lang === 'ko' ? '연결 중' : 'Connecting')
      : (lang === 'ko' ? '끊김' : 'Disconnected');
  return `${lang === 'ko' ? 'Herdr 원격' : 'Herdr remote'} · ${state}`;
}

// The row's own words: nothing while this computer or a connected one is fine
// (the coloured icon says it), a short word only when it is not.
export function computerAlert(machine, lang = 'ko') {
  if (machine.name == null || machine.layout === 'ready') return null;
  if (machine.layout === 'loading') return lang === 'ko' ? '연결 중' : 'Connecting';
  return lang === 'ko' ? '연결 끊김' : 'Disconnected';
}

export function tailscaleStatus(peer, lang = 'ko') {
  if (peer.online === true) return lang === 'ko'
    ? 'Tailscale 온라인 · SSH 미등록' : 'Tailscale online · SSH unregistered';
  if (peer.online === false) return lang === 'ko' ? 'Tailscale 오프라인' : 'Tailscale offline';
  return lang === 'ko' ? 'Tailscale 상태 미확인' : 'Tailscale status unknown';
}

// Project names, their marks and colours are machine-local (data/sixfold/site.local.json
// `workspaces`, keyed by lower-case name); the repository only knows the generic ones.
export function workspaceLocal(space, site = {}) {
  const name = String(space.name ?? '').trim().toLowerCase();
  const entry = site?.workspaces?.[name];
  return entry && typeof entry === 'object' ? entry : null;
}

export function workspaceIdentity(space, site = {}) {
  const name = String(space.name ?? '').trim().toLowerCase();
  const hubs = Array.isArray(site?.hub_space_ids) ? site.hub_space_ids : [];
  if (hubs.includes(space.id) || name === 'share' || name === '공통' || name === 'common') return 'hub';
  const icon = workspaceLocal(space, site)?.icon;
  if (typeof icon === 'string' && /^[a-z-]+$/.test(icon)) return icon;
  if (name === 'voice') return 'microphone';
  if (name === 'herdr') return 'terminal';
  return null;
}

// Pin identity is configured explicitly by machine + stable space ID. Names,
// document pins and native terminal pins do not imply workspace pinning.
export function workspacePinned(space, config) {
  return Array.isArray(config?.spaces) && config.spaces.some(item =>
    item && typeof item.id === 'string' && item.id.length > 0 &&
    item.id === space.id && (item.machine ?? null) === (space.machine ?? null));
}

// A computer shown in the sidebar list: this one, a connected or connecting Herdr remote.
export function computerActive(machine) {
  return machine.name == null || machine.layout === 'ready' || machine.layout === 'loading';
}

// Numbered shortcut slots follow the sidebar list: this computer first, then registered
// Herdr machines, with disconnected ones last. Tailscale discovery never takes a slot.
export function computerSlots(machines) {
  const list = Array.isArray(machines) ? machines : [];
  const key = machine => machine.name == null ? 'local' : `remote:${machine.name}`;
  const ordered = [...list.filter(m => m.name == null), ...list.filter(m => m.name != null)];
  return [...ordered.filter(computerActive), ...ordered.filter(m => !computerActive(m))].map(key);
}

// The Share (hub) space of one listed computer, or null. Only an explicit id (this
// computer: site `hub_space_ids`; a remote: its `hub_space_ids` in computers.local.json)
// or the Share/공통/common role name counts. Several candidates or none: null, never a guess.
export function computerHub(spaces, key, site = {}, computers = {}) {
  const machine = key === 'local' ? null : /^remote:(.+)$/.exec(key)?.[1] ?? undefined;
  if (machine === undefined) return null;
  const mine = (Array.isArray(spaces) ? spaces : []).filter(space => (space.machine ?? null) === machine);
  const ids = new Set([
    ...(Array.isArray(site?.hub_space_ids) ? site.hub_space_ids : []),
    ...(machine === null ? [] : (Array.isArray(computers?.machines?.[machine]?.hub_space_ids) ? computers.machines[machine].hub_space_ids : [])),
  ]);
  const explicit = mine.filter(space => ids.has(space.id));
  const found = explicit.length ? explicit : mine.filter(space => ['share', '공통', 'common'].includes(String(space.name ?? '').trim().toLowerCase()));
  return found.length === 1 ? found[0] : null;
}
