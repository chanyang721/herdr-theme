"""The pinned Herdr Workspace Mods release: pin checks, the checkout, and both installers using it."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import workspace_mods  # noqa: E402
import update_install  # noqa: E402

spec = importlib.util.spec_from_file_location('base_install_wm', SCRIPTS / 'install.py')
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


class Release:
    """A local git repo shaped like Herdr Workspace Mods, plus a theme repo pinned to it."""

    def __init__(self, root):
        self.mods = root / 'workspace-mods'
        for path, text in {
            'system-metrics/mods/system-metrics/mod.json': '{"title":"System Metrics"}',
            'system-metrics/mods/system-metrics/main.js': 'export default 1;',
            'system-metrics/mods/system-metrics/jsconfig.json': 'generated',
            'system-metrics/README.md': 'docs, not installed',
            'plan-usage/mods/plan-usage/mod.json': '{"title":"Plan Usage"}',
            'plan-usage/mods/plan-usage/usage.py': 'print(1)\n',
        }.items():
            p = self.mods / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding='utf-8')
        git(root, 'init', '-q', str(self.mods))
        git(self.mods, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A')
        git(self.mods, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'release')
        self.commit = git(self.mods, 'rev-parse', 'HEAD')
        self.theme = root / 'theme'
        self.theme.mkdir()
        self.pin({'system-metrics': 'system-metrics/mods/system-metrics', 'plan-usage': 'plan-usage/mods/plan-usage'})

    def pin(self, mods, commit=None):
        (self.theme / workspace_mods.LOCK_NAME).write_text(json.dumps({
            'repository': str(self.mods), 'tag': 'v-test', 'commit': commit or self.commit, 'mods': mods,
            'document_viewer': 'document-viewer/scripts/install_preview.py'}), encoding='utf-8')


class PinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.release = Release(Path(self.tmp.name))

    def test_lists_each_pinned_mods_runtime_files_and_skips_generated_ones(self):
        pin, root, files = workspace_mods.pinned_files(self.release.theme, self.release.mods)
        self.assertEqual(pin['tag'], 'v-test')
        self.assertEqual(sorted(str(rel).replace('\\', '/') for _, rel in files), [
            'mods/plan-usage/mod.json', 'mods/plan-usage/usage.py',
            'mods/system-metrics/main.js', 'mods/system-metrics/mod.json'])

    def test_a_checkout_at_another_commit_or_with_changes_is_refused(self):
        self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'}, commit='0' * 40)
        with self.assertRaisesRegex(workspace_mods.PinError, 'not the pinned'):
            workspace_mods.pinned_files(self.release.theme, self.release.mods)
        self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'})
        (self.release.mods / 'system-metrics/README.md').write_text('edited', encoding='utf-8')
        with self.assertRaisesRegex(workspace_mods.PinError, 'local changes'):
            workspace_mods.pinned_files(self.release.theme, self.release.mods)

    def test_unsafe_or_incomplete_pins_are_refused(self):
        for mods, commit in (({'x': '../outside'}, None), ({}, None), ({'x': 'x'}, 'abc')):
            self.release.pin(mods, commit)
            with self.assertRaises(workspace_mods.PinError):
                workspace_mods.read_pin(self.release.theme)
        self.release.pin({'missing': 'nowhere/mods/missing'})
        with self.assertRaisesRegex(workspace_mods.PinError, 'no mod'):
            workspace_mods.pinned_files(self.release.theme, self.release.mods)

    def test_fetches_the_pinned_commit_into_an_empty_cache(self):
        cache = Path(self.tmp.name) / 'cache'
        with patch.object(workspace_mods, 'default_cache', return_value=cache):
            _, root, files = workspace_mods.pinned_files(self.release.theme)
        self.assertEqual(root, cache / self.release.commit[:12], 'one cache folder per commit')
        self.assertEqual(git(root, 'rev-parse', 'HEAD'), self.release.commit)
        self.assertEqual(len(files), 4)

    def test_a_failed_fetch_leaves_no_cache_behind_and_the_next_try_works(self):
        cache = Path(self.tmp.name) / 'cache'
        missing = 'f' * 40
        self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'}, commit=missing)
        with patch.object(workspace_mods, 'default_cache', return_value=cache):
            with self.assertRaisesRegex(workspace_mods.PinError, 'could not fetch'):
                workspace_mods.pinned_files(self.release.theme)
            self.assertEqual(list(cache.iterdir()), [], 'no half-made or temporary checkout is left')
            self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'})
            _, root, files = workspace_mods.pinned_files(self.release.theme)
        self.assertEqual(len(files), 2)

    def test_installs_pinned_to_different_commits_keep_separate_checkouts(self):
        cache = Path(self.tmp.name) / 'cache'
        first = self.release.commit
        (self.release.mods / 'system-metrics/mods/system-metrics/main.js').write_text('export default 2;', encoding='utf-8')
        git(self.release.mods, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'next')
        second = git(self.release.mods, 'rev-parse', 'HEAD')
        with patch.object(workspace_mods, 'default_cache', return_value=cache):
            self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'}, commit=first)
            _, old_root, _ = workspace_mods.pinned_files(self.release.theme)
            self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'}, commit=second)
            _, new_root, files = workspace_mods.pinned_files(self.release.theme)
        self.assertNotEqual(old_root, new_root)
        self.assertEqual(git(old_root, 'rev-parse', 'HEAD'), first, 'the older pin is not moved')
        main = next(path for path, rel in files if rel.name == 'main.js')
        self.assertEqual(main.read_text(encoding='utf-8'), 'export default 2;')

    def test_ignored_files_in_a_checkout_are_not_installed(self):
        (self.release.mods / '.gitignore').write_text('*.log' + chr(10), encoding='utf-8')
        git(self.release.mods, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.gitignore')
        git(self.release.mods, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'ignore logs')
        self.release.commit = git(self.release.mods, 'rev-parse', 'HEAD')
        self.release.pin({'system-metrics': 'system-metrics/mods/system-metrics'})
        (self.release.mods / 'system-metrics/mods/system-metrics/debug.log').write_text('local', encoding='utf-8')
        _, _, files = workspace_mods.pinned_files(self.release.theme, self.release.mods)
        self.assertNotIn('debug.log', [rel.name for _, rel in files])

    def test_records_the_installed_release_and_finds_a_files_layout(self):
        app = Path(self.tmp.name) / 'app'
        pin = workspace_mods.read_pin(self.release.theme)
        workspace_mods.record(app, pin)
        saved = json.loads((app / 'data/sixfold/workspace-mods.json').read_text(encoding='utf-8'))
        self.assertEqual((saved['commit'], saved['mods']), (self.release.commit, ['plan-usage', 'system-metrics']))
        self.assertIsNone(workspace_mods.has_files_layout(app))
        (app / 'layouts').mkdir()
        (app / 'layouts/plain.json').write_text('{"id":"root","children":[]}', encoding='utf-8')
        (app / 'layouts/main.json').write_text('{"id":"root","children":[{"id":"files"}]}', encoding='utf-8')
        self.assertEqual(workspace_mods.has_files_layout(app), 'main')


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.release = Release(Path(self.tmp.name))
        theme = self.release.theme
        for path, text in {'keys.json': '{}', 'mods/sixfold-desk/main.js': 'x', 'layouts/sixfold.json': '{}', 'themes/sixfold-night.json': '{}'}.items():
            (theme / path).parent.mkdir(parents=True, exist_ok=True)
            (theme / path).write_text(text, encoding='utf-8')
        for name in ('workspace', 'core_api', 'balance_grid', 'collect_computers', 'route', 'collaborate', 'update_install', 'workspace_mods',
                     'file_lock', 'agent_env', 'site_config', 'desktop', 'install_doc_tabs', 'resolve_doc_pins', 'doc_catalog', 'doc_routing',
                     'collect_docs', 'open_doc_tab', 'render_mermaid', 'render_html'):
            (theme / 'scripts').mkdir(exist_ok=True)
            (theme / f'scripts/{name}.py').write_text('# helper\n', encoding='utf-8')

    def test_the_first_install_brings_the_pinned_mods_with_the_theme(self):
        app = Path(self.tmp.name) / 'app'
        _, _, files = workspace_mods.pinned_files(self.release.theme, self.release.mods)
        install.install(self.release.theme, app, extra=files)
        self.assertEqual((app / 'mods/system-metrics/main.js').read_text(encoding='utf-8'), 'export default 1;')
        self.assertTrue((app / 'mods/plan-usage/usage.py').exists())
        self.assertFalse((app / 'mods/system-metrics/jsconfig.json').exists())
        self.assertTrue((app / 'mods/sixfold-desk/main.js').exists())
        with self.assertRaises(SystemExit):           # a second first-install never overwrites
            install.install(self.release.theme, app, extra=files)
        install.install(self.release.theme, app, update=True, extra=files)

    def test_updater_includes_the_pinned_mods_by_default_and_not_for_voice_alone(self):
        calls = []
        fake = [(self.release.mods / 'plan-usage/mods/plan-usage/usage.py', Path('mods/plan-usage/usage.py'))]
        pin = workspace_mods.read_pin(self.release.theme)

        def run(*names):
            calls.clear()
            with patch.object(update_install.workspace_mods, 'pinned_files', return_value=(pin, self.release.mods, fake)), \
                 patch.object(update_install.workspace_mods, 'record'), \
                 patch.object(update_install, 'update', side_effect=lambda *a, **k: calls.append((a[2], [str(r) for _, r in a[6]])) or 'receipt'), \
                 patch.object(update_install, 'install_voice', side_effect=lambda r, h: calls.append('voice')), \
                 patch.object(sys, 'argv', ['update_install.py', '--repo', str(Path(__file__).resolve().parents[1]), *names]):
                update_install.main()
            return list(calls)

        self.assertEqual(run(), [([], [str(Path('mods/plan-usage/usage.py'))])])
        self.assertEqual(run('mods/sixfold-desk/main.js')[0][0], ['mods/sixfold-desk/main.js'])
        self.assertEqual(run('mods/sixfold-desk/main.js', '--without-workspace-mods'), [(['mods/sixfold-desk/main.js'], [])])
        self.assertEqual(run('voice'), ['voice'])

    def test_pinned_targets_are_checked_like_listed_files(self):
        home = Path(self.tmp.name) / 'home'
        (home / 'mods').mkdir(parents=True)
        source = self.release.mods / 'plan-usage/mods/plan-usage/usage.py'
        entries = update_install.pinned_inputs([(source, Path('mods/plan-usage/usage.py'))], home)
        self.assertEqual(entries[0][0], Path('mods/plan-usage/usage.py'))
        with self.assertRaises(update_install.InstallError):
            update_install.pinned_inputs([(source, Path('layouts/x.json'))], home)
        (home / 'mods/plan-usage/usage.py').mkdir(parents=True)
        with self.assertRaisesRegex(update_install.InstallError, 'regular'):
            update_install.pinned_inputs([(source, Path('mods/plan-usage/usage.py'))], home)

    def test_a_linked_mods_folder_is_refused(self):
        home = Path(self.tmp.name) / 'home2'
        home.mkdir()
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        try:
            if sys.platform == 'win32':
                subprocess.run(['cmd', '/c', 'mklink', '/J', str(home / 'mods'), str(outside)], check=True, capture_output=True)
            else:
                (home / 'mods').symlink_to(outside, target_is_directory=True)
        except (OSError, subprocess.CalledProcessError):
            self.skipTest('cannot create a link here')
        source = self.release.mods / 'plan-usage/mods/plan-usage/usage.py'
        with self.assertRaisesRegex(update_install.InstallError, 'Symlink'):
            update_install.pinned_inputs([(source, Path('mods/plan-usage/usage.py'))], home)

    def test_the_later_document_viewer_command_names_the_home_and_quotes_paths(self):
        from pathlib import PureWindowsPath, PurePosixPath
        windows = install.later_command(['C:/Py/python.exe', 'C:/Users/A B/x.py', '--layout', '<layout>', '--markdown-only'],
                                        PureWindowsPath('C:/Users/A B/.config/herdr-app'), windows=True)
        self.assertEqual(windows, r"$env:HERDR_APP_HOME = 'C:\Users\A B\.config\herdr-app'; & 'C:/Py/python.exe' 'C:/Users/A B/x.py' --layout '<layout>' --markdown-only")
        posix = install.later_command(['/usr/bin/python3', '/home/a b/x.py', '--layout', '<layout>'],
                                      PurePosixPath('/home/a b/.config/herdr-app'), windows=False)
        self.assertEqual(posix, "HERDR_APP_HOME='/home/a b/.config/herdr-app' /usr/bin/python3 '/home/a b/x.py' --layout '<layout>'")


if __name__ == '__main__':
    unittest.main()
