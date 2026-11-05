"""Regression: the pre-push hook stops before any check when it cannot convert the repo path, and
PREPUSH_* variables cannot skip the checks."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Fakes are swapped into a COPY of the hook at the marked lines; the real hook has no environment switch.
# Each fake appends its name to calls.log, so a test can prove the fake ran and that no check ran.
FAKES = {
    'cygpath.sh': 'echo "cygpath $*" >> calls.log\nexit 9\n',
    'py.sh': 'echo "py $*" >> calls.log\nexit 0\n',
}
SUBSTITUTIONS = {
    'CYG=cygpath  # @tool-cygpath': "CYG='sh fakes/cygpath.sh'",
    'PY=auto  # @tool-py': "PY='sh fakes/py.sh'",
}


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith('PREPUSH_')}


def init_repo(repo, hook_text):
    (repo / 'scripts').mkdir(parents=True)
    (repo / 'scripts' / 'pre-push').write_text(hook_text, encoding='utf-8', newline='\n')
    git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
    subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
    subprocess.run(git + ['add', '-A'], cwd=repo, check=True)
    subprocess.run(git + ['commit', '-q', '-m', 'x'], cwd=repo, check=True)
    return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True,
                          check=True).stdout.strip()


class PrePushSetupTests(unittest.TestCase):
    def test_path_conversion_failure_stops_before_checks(self):
        if shutil.which('sh') is None:
            self.skipTest('needs sh')
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        repo = tmp / 'repo'
        (repo / 'fakes').mkdir(parents=True)
        for name, body in FAKES.items():
            (repo / 'fakes' / name).write_text(body, encoding='utf-8', newline='\n')
        text = (ROOT / 'scripts' / 'pre-push').read_text(encoding='utf-8')
        for old, new in SUBSTITUTIONS.items():
            self.assertEqual(text.count(old), 1, old)
            text = text.replace(old, new)
        sha = init_repo(repo, text)
        done = subprocess.run(['sh', 'scripts/pre-push'], cwd=repo, env=clean_env(), capture_output=True, text=True,
                              input=f'refs/heads/main {sha} refs/heads/main {"0" * 40}\n')
        log = repo / 'calls.log'
        calls = log.read_text(encoding='utf-8').splitlines() if log.exists() else []
        self.assertTrue(any(c.startswith('cygpath ') for c in calls), 'the failing fake converter must have run')
        self.assertNotEqual(done.returncode, 0, done.stderr)
        self.assertIn('cannot convert', done.stderr)
        self.assertFalse(any(c.startswith('py ') for c in calls), 'no check may run when the path cannot be converted')

    def test_prepush_variables_cannot_skip_checks_in_a_real_push(self):
        """The bypass that was reproduced: PREPUSH_PY=true skipped every check and the push went through."""
        if shutil.which('sh') is None:
            self.skipTest('needs sh')
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        repo, bare = tmp / 'repo', tmp / 'remote.git'
        init_repo(repo, (ROOT / 'scripts' / 'pre-push').read_text(encoding='utf-8'))
        subprocess.run(['git', 'init', '-q', '--bare', str(bare)], check=True)
        subprocess.run(['git', 'remote', 'add', 'origin', bare.as_posix()], cwd=repo, check=True)
        (repo / '.git' / 'hooks' / 'pre-push').write_text('#!/bin/sh\nexec sh scripts/pre-push "$@"\n',
                                                         encoding='utf-8', newline='\n')
        env = dict(clean_env(), PREPUSH_PY='true', PREPUSH_CYGPATH='true')
        done = subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/main'], cwd=repo, env=env,
                              capture_output=True, text=True)
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('PREPUSH_', done.stderr)
        remote = subprocess.run(['git', 'ls-remote', bare.as_posix(), 'refs/heads/main'], capture_output=True,
                                text=True, check=True).stdout.strip()
        self.assertEqual(remote, '', f'the bypass pushed to the remote: {remote}')


if __name__ == '__main__':
    unittest.main()
