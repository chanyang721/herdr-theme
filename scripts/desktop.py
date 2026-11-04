"""Open or copy a local document through the current computer's desktop tools."""
import argparse
import base64
import os
from pathlib import Path
import shutil
import subprocess
import sys


def powershell_copy(path, mode):
    value = base64.b64encode(str(path).encode('utf-8')).decode('ascii')
    source = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + value + "'));"
    source += 'Set-Clipboard -LiteralPath $p' if mode == 'copy-file' else 'Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath $p)'
    command = base64.b64encode(source.encode('utf-16le')).decode('ascii')
    return ['powershell.exe', '-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', command]


def launch(action, path):
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError('Select a local file')
    quiet = {'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
    if action.startswith('copy-') and os.name == 'nt':
        subprocess.run(powershell_copy(path, action), check=True, timeout=15, capture_output=True, **quiet)
        return
    if action == 'open' and os.name == 'nt':
        os.startfile(str(path))
        return
    if os.name == 'nt':
        if action == 'browser':
            candidates = [Path(os.environ.get(key, '')) / 'Citro Labs/ego lite/Application/ego.exe'
                          for key in ('ProgramFiles', 'LOCALAPPDATA')]
        elif action == 'editor':
            candidates = [Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs/Microsoft VS Code/Code.exe',
                          Path(os.environ.get('ProgramFiles', '')) / 'Microsoft VS Code/Code.exe']
        else:
            raise ValueError('Unsupported desktop action')
        program = next((p for p in candidates if p.is_file()), None)
        if program is None:
            raise RuntimeError('Ego lite 또는 VS Code 실행 파일을 찾지 못했습니다.')
        argv = [str(program), *(['--reuse-window'] if action == 'editor' else []), str(path)]
    elif action == 'editor':
        argv = ['code', '--reuse-window', str(path)]
    elif action in ('open', 'browser'):
        argv = ['open' if sys.platform == 'darwin' else 'xdg-open', str(path)]
    else:
        raise ValueError('Clipboard action is not supported on this platform')
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **quiet)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['open', 'browser', 'editor', 'copy-file', 'copy-text'])
    parser.add_argument('path')
    args = parser.parse_args()
    launch(args.action, args.path)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    main()
