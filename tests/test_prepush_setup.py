"""Regression: the pre-push hook stops before any check when it cannot convert the repo path."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Fake tools are real files reached through PREPUSH_* variables (PATH injection does not reach sh on Windows).
# Each one appends its name to calls.log, so a test can prove the fake ran and that no check ran.
FAKES = {
    'cygpath.sh': 'echo "cygpath $*" >> calls.log\nexit 9\n',
    'py.sh': 'if [ "$1" = -3.12 ] && [ "$2" = -c ]; then exit 0; fi\necho "py $*" >> calls.log\nexit 0\n',
}


class PrePushSetupTests(unittest.TestCase):
    def test_path_conversion_failure_stops_before_checks(self):
        if shutil.which('sh') is None:
            self.skipTest('needs sh')
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        repo = tmp / 'repo'
        (repo / 'scripts').mkdir(parents=True)
        (repo / 'fakes').mkdir()
        (repo / 'scripts' / 'pre-push').write_bytes((ROOT / 'scripts' / 'pre-push').read_bytes())
        git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
        subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
        subprocess.run(git + ['add', '-A'], cwd=repo, check=True)
        subprocess.run(git + ['commit', '-q', '-m', 'x'], cwd=repo, check=True)
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True,
                             check=True).stdout.strip()
        for name, body in FAKES.items():
            (repo / 'fakes' / name).write_text(body, encoding='utf-8', newline='\n')
        env = dict(os.environ, PREPUSH_CYGPATH='sh fakes/cygpath.sh', PREPUSH_PY='sh fakes/py.sh')
        done = subprocess.run(['sh', 'scripts/pre-push'], cwd=repo, env=env, capture_output=True, text=True,
                              input=f'refs/heads/main {sha} refs/heads/main {"0" * 40}\n')
        log = repo / 'calls.log'
        calls = log.read_text(encoding='utf-8').splitlines() if log.exists() else []
        self.assertTrue(any(c.startswith('cygpath ') for c in calls), 'the failing fake converter must have run')
        self.assertNotEqual(done.returncode, 0, done.stderr)
        self.assertIn('cannot convert', done.stderr)
        self.assertFalse(any(c.startswith('py ') for c in calls), 'no check may run when the path cannot be converted')


if __name__ == '__main__':
    unittest.main()
