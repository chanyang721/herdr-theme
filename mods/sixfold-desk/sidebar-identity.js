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

export function tailscaleStatus(peer, lang = 'ko') {
  if (peer.online === true) return lang === 'ko'
    ? 'Tailscale 온라인 · SSH 미등록' : 'Tailscale online · SSH unregistered';
  if (peer.online === false) return lang === 'ko' ? 'Tailscale 오프라인' : 'Tailscale offline';
  return lang === 'ko' ? 'Tailscale 상태 미확인' : 'Tailscale status unknown';
}

export function workspaceIdentity(space) {
  const name = String(space.name ?? '').trim().toLowerCase();
  if (space.id === 'sp5b1f0e5ae362facabc5ac1ece5d08277' || name === 'share' || name === '공통' || name === 'common') return 'hub';
  if (name === 'peaceminusone' || name === 'pmo') return 'flower';
  if (name === 'medihomes') return 'medical';
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
