#!/usr/bin/env python3
"""Read local Tailscale status only; never connect to peers or change settings."""
import json
from pathlib import Path
import shutil
import subprocess


def computers(status):
    if status.get('BackendState') != 'Running':
        raise ValueError('Tailscale is not running')
    rows = []
    for peer in (status.get('Peer') or {}).values():
        if peer.get('OS') not in ('windows', 'macOS', 'linux', 'iOS', 'iPadOS', 'android'):
            continue
        name = (peer.get('DNSName') or '').split('.')[0] or peer.get('HostName')
        if not name:
            continue
        rows.append({'name': name, 'host': peer.get('HostName', name),
                     'ips': peer.get('TailscaleIPs') or [], 'os': peer.get('OS'),
                     'online': peer.get('Online') if isinstance(peer.get('Online'), bool) else None})
    return sorted(rows, key=lambda row: row['name'])


def main():
    try:
        command = shutil.which('tailscale')
        if not command:
            command = next((p for p in ('/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
                                       '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
                            if Path(p).is_file()), None)
        if not command:
            raise ValueError('Tailscale CLI unavailable')
        result = subprocess.run([command, 'status', '--json'], capture_output=True,
                                text=True, timeout=8, check=True)
        print(json.dumps({'peers': computers(json.loads(result.stdout)), 'error': None}))
    except (OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'peers': [], 'error': 'Tailscale status unavailable'}))


if __name__ == '__main__':
    main()
