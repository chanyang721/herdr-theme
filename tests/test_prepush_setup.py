"""Regression: the pre-push hook stops before any check when it cannot convert the repo path."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FAKE_CYGPATH = '#!/bin/sh\nexit 9\n'
# Any check command (npm, node, py) writes a marker; the test asserts it never appears.
FAKE_CHECK = '#!/bin/sh\necho ran >> "$MARKER"\nexit 0\n'
# The hook probes `py -3.12 -c ''` before anything else: that probe is not a check.
FAKE_PY = '#!/bin/sh\nif [ "$1" = -3.12 ] && [ "$2" = -c ]; then exit 0; fi\necho ran >> "$MARKER"\nexit 0\n'


class PrePushSetupTests(unittest.TestCase):
    def test_path_conversion_failure_stops_before_checks(self):
        if shutil.which('sh') is None:
            self.skipTest('needs sh')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            repo, bin_dir = tmp / 'repo', tmp / 'bin'
            (repo / 'scripts').mkdir(parents=True); bin_dir.mkdir()
            (repo / 'scripts' / 'pre-push').write_bytes((ROOT / 'scripts' / 'pre-push').read_bytes())
            git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
            subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
            subprocess.run(git + ['add', '-A'], cwd=repo, check=True)
            subprocess.run(git + ['commit', '-q', '-m', 'x'], cwd=repo, check=True)
            sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True,
                                 check=True).stdout.strip()
            for name, body in (('cygpath', FAKE_CYGPATH), ('py', FAKE_PY), ('npm', FAKE_CHECK), ('node', FAKE_CHECK)):
                (bin_dir / name).write_text(body, encoding='utf-8', newline='\n')
                (bin_dir / name).chmod(0o755)
            marker = tmp / 'marker'
            env = dict(os.environ, MARKER=str(marker), PATH=f'{bin_dir}{os.pathsep}{os.environ.get("PATH", "")}')
            done = subprocess.run(['sh', 'scripts/pre-push'], cwd=repo, env=env, capture_output=True, text=True,
                                  input=f'refs/heads/main {sha} refs/heads/main {"0" * 40}\n')
            self.assertNotEqual(done.returncode, 0, done.stderr)
            self.assertFalse(marker.exists(), 'no check may run when the repo path cannot be converted')


if __name__ == '__main__':
    unittest.main()
