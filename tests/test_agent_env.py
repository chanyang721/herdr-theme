import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import agent_env

PARENT = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/home/demo', 'HERDR_ENV': '1',
          'CLAUDECODE': '1', 'CLAUDE_CODE_CHILD_SESSION': '1', 'CLAUDE_CODE_SESSION_ID': 'parent',
          'CLAUDE_PID': '10', 'CODEX_THREAD_ID': 'thread', 'HERDR_PANE_ID': 'w8:p12',
          'HERDR_TAB_ID': 'w8:t1', 'HERDR_WORKSPACE_ID': 'w8'}


class AgentEnvTests(unittest.TestCase):
    def test_hc_terminal_drops_agent_and_parent_pane_markers(self):
        env = agent_env.clean_env({**PARENT, 'HC_TERMINAL_ID': 'new'})
        self.assertEqual(env, {'PATH': PARENT['PATH'], 'HOME': '/home/demo', 'HERDR_ENV': '1', 'HC_TERMINAL_ID': 'new'})

    def test_native_pane_keeps_its_own_pane_identity(self):
        env = agent_env.clean_env(PARENT)
        self.assertEqual(env['HERDR_PANE_ID'], 'w8:p12')
        self.assertNotIn('CLAUDE_CODE_CHILD_SESSION', env)

    def test_launch_argv_unsets_every_marker_then_runs_the_program(self):
        argv = agent_env.launch_argv(['claude', '--resume', 'x'])
        self.assertEqual(argv[0], 'env')
        self.assertEqual(argv[-3:], ['claude', '--resume', 'x'])
        self.assertEqual(sorted(argv[2:-3:2]), sorted(agent_env.INHERITED))
        with self.assertRaises(ValueError):
            agent_env.launch_argv([])

    def test_windows_keeps_the_plain_argv(self):
        from unittest.mock import patch
        with patch.object(agent_env.sys, 'platform', 'win32'):
            self.assertEqual(agent_env.launch_argv(['claude']), ['claude'])

    @unittest.skipIf(sys.platform == 'win32', 'env(1) is POSIX')
    def test_launch_argv_really_clears_the_markers(self):
        script = 'import json,os;print(json.dumps(sorted(k for k in os.environ if k in %r)))' % (agent_env.INHERITED,)
        output = subprocess.run(agent_env.launch_argv([sys.executable, '-c', script]), env=PARENT,
                                capture_output=True, text=True, check=True).stdout
        self.assertEqual(output.strip(), '[]')

    def test_exec_wrapper_runs_with_the_cleaned_environment(self):
        script = 'import os;print(os.environ.get("CLAUDE_CODE_CHILD_SESSION"), os.environ.get("HERDR_PANE_ID"))'
        output = subprocess.run([sys.executable, agent_env.__file__, sys.executable, '-c', script],
                                env={**PARENT, 'HC_TERMINAL_ID': 'new'}, capture_output=True, text=True, check=True).stdout
        self.assertEqual(output.strip(), 'None None')


if __name__ == '__main__':
    unittest.main()
