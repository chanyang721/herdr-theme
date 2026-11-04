import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from update_install import InstallError, exchange_directories, lock_exclusive, update


class UpdateInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo, self.home = self.base / 'repo', self.base / 'app'
        self.source = self.repo / 'mods/example'
        self.target = self.home / 'mods/example'
        self.source.mkdir(parents=True)
        self.target.mkdir(parents=True)
        (self.source / 'main.js').write_text('new')
        (self.source / 'required.js').write_text('dependency')
        (self.target / 'main.js').write_text('old')
        (self.target / 'unlisted.js').write_text('preserve me')
        script = self.base / 'fake-herdr.py'
        script.write_text('#!' + sys.executable + '''
import json,os,sys
from pathlib import Path
home=Path(os.environ['HERDR_APP_HOME']);config=json.loads((home/'fake.json').read_text())
target=home/'mods/example/main.js';current=target.read_text() if target.exists() else 'absent'
with (home/'calls.jsonl').open('a') as log:log.write(json.dumps({'argv':sys.argv[1:],'installed':current})+'\\n')
if sys.argv[1]=='check':
 stage=Path(sys.argv[2]);candidate=(stage/'main.js').read_text()
 if config.get('check_fail') or (candidate=='needs-dependency' and not (stage/'required.js').exists()):sys.exit(3)
 print('check passed')
elif sys.argv[1]=='status':
 errors=['broken'] if config.get('unhealthy') or (current=='old' and config.get('pre_errors')) or (current!='old' and config.get('post_fail')) else []
 if current=='new' and config.get('concurrent'):
  target.write_text('other writer');errors=['broken']
 print(json.dumps({'errors':errors,'space':'space','tab':'tab','focused_pane':'moved' if current=='new' and config.get('focus_change') else 'pane'}))
else:sys.exit(4)
''')
        script.chmod(0o755)
        if sys.platform == 'win32':
            # Windows cannot start a shebang script directly; a batch wrapper stands in for the CLI.
            self.cli = self.base / 'fake-herdr.cmd'
            self.cli.write_text(f'@"{sys.executable}" "{script}" %*' + chr(10))
        else:
            self.cli = script
        self.configure()

    def configure(self, **value):
        (self.home / 'fake.json').write_text(json.dumps(value))

    def install(self, files=None, **kwargs):
        return update(self.repo, self.home, files or ['mods/example/main.js'], str(self.cli), verify_timeout=1.6, **kwargs)

    def calls(self):
        path = self.home / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def receipt(self):
        return json.loads(next((self.home / 'backups').glob('sixfold-update-*/receipt.json')).read_text())

    def test_checks_complete_candidate_then_atomically_exchanges_and_preserves_unlisted_files(self):
        (self.source / 'main.js').write_text('needs-dependency')
        backup = self.install(['mods/example/main.js', 'mods/example/required.js'])
        self.assertEqual((self.target / 'main.js').read_text(), 'needs-dependency')
        self.assertEqual((self.target / 'unlisted.js').read_text(), 'preserve me')
        self.assertEqual((backup / 'mods/example/main.js').read_text(), 'old')
        self.assertEqual((backup / 'mods/example/unlisted.js').read_text(), 'preserve me')
        check = next(call for call in self.calls() if call['argv'][0] == 'check')
        self.assertEqual(check['installed'], 'old')
        self.assertFalse(Path(check['argv'][1]).is_relative_to(self.home / 'mods'))
        self.assertEqual(self.receipt()['phase'], 'verified')

    def test_missing_selected_dependency_fails_before_installation(self):
        (self.source / 'main.js').write_text('needs-dependency')
        with self.assertRaisesRegex(InstallError, 'Native check failed'):
            self.install()
        self.assertEqual((self.target / 'main.js').read_text(), 'old')
        self.assertFalse(list((self.home / 'backups').glob('sixfold-update-*')))

    def test_post_install_errors_restore_complete_mod_and_remove_new_files(self):
        self.configure(post_fail=True)
        with self.assertRaisesRegex(InstallError, 'rolled_back'):
            self.install(['mods/example/main.js', 'mods/example/required.js'])
        self.assertEqual((self.target / 'main.js').read_text(), 'old')
        self.assertFalse((self.target / 'required.js').exists())
        self.assertEqual((self.target / 'unlisted.js').read_text(), 'preserve me')
        self.assertEqual(self.receipt()['rollback_status']['errors'], [])

    def test_preexisting_errors_refuse_install_by_default(self):
        self.configure(unhealthy=True)
        with self.assertRaisesRegex(InstallError, 'already reports errors'):
            self.install()
        self.assertFalse(any(call['argv'][0] == 'check' for call in self.calls()))
        self.assertEqual((self.target / 'main.js').read_text(), 'old')

    def test_authorized_repair_allows_initial_errors_but_requires_final_zero(self):
        self.configure(pre_errors=True)
        self.install(allow_unhealthy_before=True)
        self.assertEqual(self.receipt()['before']['errors'], ['broken'])
        self.assertEqual(self.receipt()['after']['errors'], [])

    def test_authorized_repair_with_persistent_errors_still_rolls_back(self):
        self.configure(unhealthy=True)
        with self.assertRaisesRegex(InstallError, 'rolled_back'):
            self.install(allow_unhealthy_before=True)
        self.assertEqual((self.target / 'main.js').read_text(), 'old')

    def test_focus_change_is_reported_and_content_is_rolled_back_without_focus_commands(self):
        self.configure(focus_change=True)
        with self.assertRaisesRegex(InstallError, 'focus changed'):
            self.install()
        self.assertEqual((self.target / 'main.js').read_text(), 'old')
        self.assertTrue(all(call['argv'][0] in ('status', 'check') for call in self.calls()))

    def test_existing_installation_lock_refuses_all_cli_and_file_changes(self):
        lock = self.home / 'data/sixfold/install.lock'
        lock.parent.mkdir(parents=True)
        with lock.open('w') as stream:
            lock_exclusive(stream)
            with self.assertRaisesRegex(InstallError, 'holds the lock'):
                self.install()
        self.assertEqual(self.calls(), [])
        self.assertEqual((self.target / 'main.js').read_text(), 'old')

    def test_rollback_does_not_overwrite_an_uncooperative_later_writer(self):
        self.configure(concurrent=True)
        with self.assertRaisesRegex(InstallError, 'rollback_conflict'):
            self.install()
        self.assertEqual((self.target / 'main.js').read_text(), 'other writer')
        self.assertEqual(self.receipt()['rollback_conflicts'], ['mods/example'])

    def test_unchanged_candidate_causes_no_native_check_or_mod_exchange(self):
        (self.source / 'main.js').write_text('old')
        with patch('update_install.exchange_directories') as exchange:
            self.install()
        exchange.assert_not_called()
        self.assertEqual([call['argv'][0] for call in self.calls()], ['status'])
        self.assertEqual(self.receipt()['phase'], 'unchanged')

    def test_recovery_mod_clones_and_escaping_targets_are_refused(self):
        for target in ['mods/example-recovery/main.js', '../main.js', 'layouts/.state/sixfold.json']:
            with self.subTest(target=target), self.assertRaises(InstallError):
                self.install([target])
        self.assertEqual(self.calls(), [])

    def test_script_destination_matches_initial_installer(self):
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/workspace.py').write_text('updated helper')
        self.install(['scripts/workspace.py'])
        self.assertEqual((self.home / 'scripts/sixfold/workspace.py').read_text(), 'updated helper')
        self.assertFalse((self.home / 'scripts/workspace.py').exists())

    def test_layout_files_roll_back_together_with_mod(self):
        (self.repo / 'layouts').mkdir()
        (self.home / 'layouts').mkdir()
        (self.repo / 'layouts/sixfold.json').write_text('{"new":true}')
        (self.home / 'layouts/sixfold.json').write_text('{"old":true}')
        self.configure(post_fail=True)
        with self.assertRaisesRegex(InstallError, 'rolled_back'):
            self.install(['mods/example/main.js', 'layouts/sixfold.json'])
        self.assertEqual((self.home / 'layouts/sixfold.json').read_text(), '{"old":true}')
        self.assertEqual((self.target / 'main.js').read_text(), 'old')


    def test_exchange_swaps_directory_contents_and_leaves_no_scratch_path(self):
        left, right = self.base / 'stage/example', self.base / 'live/example'
        left.mkdir(parents=True)
        right.mkdir(parents=True)
        (left / 'main.js').write_text('candidate')
        (right / 'main.js').write_text('installed')
        exchange_directories(left, right)
        self.assertEqual((right / 'main.js').read_text(), 'candidate')
        self.assertEqual((left / 'main.js').read_text(), 'installed')
        self.assertEqual(sorted(p.name for p in left.parent.iterdir()), ['example'])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows rename fallback only')
    def test_windows_failed_second_rename_restores_the_installed_directory(self):
        import update_install
        left, right = self.base / 'stage/example', self.base / 'live/example'
        left.mkdir(parents=True)
        right.mkdir(parents=True)
        (right / 'main.js').write_text('installed')
        real = os.rename
        def flaky(source, target):
            if Path(source) == left:
                raise PermissionError('held open')
            return real(source, target)
        with patch('update_install.os.rename', side_effect=flaky), patch('update_install.time.sleep'):
            with self.assertRaises(PermissionError):
                update_install.exchange_directories(left, right)
        self.assertEqual((right / 'main.js').read_text(), 'installed')
        self.assertFalse((left.parent / 'example.exchange-aside').exists())

class VoiceRoutingTests(unittest.TestCase):
    """voice/... names install the voice plugin as one unit, not as app files."""

    def run_main(self, names):
        import update_install
        calls = []
        repo = Path(__file__).resolve().parents[1]
        with patch.object(update_install, 'update', side_effect=lambda *a, **k: calls.append(('update', a[2])) or 'receipt'), \
             patch.object(update_install, 'install_voice', side_effect=lambda r, h: calls.append(('voice', r))), \
             patch.object(sys, 'argv', ['update_install.py', '--repo', str(repo), *names]):
            update_install.main()
        return calls

    def test_voice_alone_skips_the_app_update(self):
        self.assertEqual([c[0] for c in self.run_main(['voice'])], ['voice'])

    def test_app_files_and_voice_install_both_in_order(self):
        calls = self.run_main(['mods/sixfold-desk/main.js', 'voice/focus_queue.py'])
        self.assertEqual(calls[0], ('update', ['mods/sixfold-desk/main.js']))
        self.assertEqual(calls[1][0], 'voice')

    def test_a_failed_voice_install_fails_the_update(self):
        import update_install
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'voice').mkdir()
            (Path(folder) / 'voice/install.py').write_text('import sys; sys.exit(1)\n')
            with self.assertRaises(InstallError):
                update_install.install_voice(Path(folder), Path(folder) / 'app')


if __name__ == '__main__':
    unittest.main()
