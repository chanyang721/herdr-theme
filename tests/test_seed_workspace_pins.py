import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('seed_pins', Path(__file__).parents[1]/'scripts/seed_workspace_pins.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class SeedPinsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)/'app'
        self.target = self.home/'data/sixfold/workspace-pins.local.json'
        # The seeded names are machine-local (site.local.json), not repository constants.
        self.target.parent.mkdir(parents=True, exist_ok=True)
        (self.target.parent/'site.local.json').write_text(json.dumps({'fixed_space_names': ['Share', 'Project A', 'Project B']}))
        self.calls = []
        self.available = [{'id': 'remote-share', 'name': 'Share', 'machine': 'remote'},
                          {'id': 'local-share', 'name': 'Share', 'machine': None}]

    def fake_app(self, args, **kwargs):
        self.assertEqual(kwargs['env']['HERDR_APP_HOME'], str(self.home))
        self.calls.append(args)
        if args[1] == 'ls':
            result = {'spaces': self.available}
        elif args[1] == 'status':
            result = {'space': 'local-share', 'focused_pane': 'pane-original'}
        elif args[1:3] == ['do', 'space.new']:
            name = args[args.index('--name')+1]
            self.assertEqual(args[args.index('--machine')+1], '')
            self.available.append({'id': 'generated-'+name, 'name': name, 'machine': None})
            result = {'ok': True}
        else:
            result = {'ok': True}
        return subprocess.CompletedProcess(args, 0, json.dumps(result), '')

    def test_first_seed_creates_only_missing_local_spaces_then_second_run_is_read_only(self):
        with patch.object(seed.subprocess, 'run', self.fake_app):
            self.assertTrue(seed.seed(self.home, True, 'fake-herdr'))
            before = len(self.calls)
            self.assertFalse(seed.seed(self.home, True, 'fake-herdr'))
            self.assertEqual(len(self.calls), before)
        self.assertEqual(json.loads(self.target.read_text()), {'spaces': [
            {'id': 'local-share', 'machine': None},
            {'id': 'generated-Project A', 'machine': None},
            {'id': 'generated-Project B', 'machine': None},
        ]})
        creates = [c for c in self.calls if c[1:3] == ['do', 'space.new']]
        self.assertEqual(len(creates), 2)
        restores = [c for c in self.calls if c[1:3] == ['do', 'pane.focus']]
        self.assertEqual(restores, [['fake-herdr', 'do', 'pane.focus', '--pane', 'pane-original']]*2)

    def test_existing_manual_configuration_is_preserved_without_contacting_app(self):
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.target.write_text('manual even if invalid JSON')
        with patch.object(seed.subprocess, 'run', side_effect=AssertionError('must not contact app')):
            self.assertFalse(seed.seed(self.home, True))
        self.assertEqual(self.target.read_text(), 'manual even if invalid JSON')

    def test_missing_space_without_ensure_does_not_write_partial_configuration(self):
        with patch.object(seed.subprocess, 'run', self.fake_app):
            with self.assertRaisesRegex(ValueError, 'Project A'):
                seed.seed(self.home)
        self.assertFalse(self.target.exists())
        self.assertFalse(any(c[1] == 'do' for c in self.calls))

    def test_creation_failure_restores_original_selection_and_does_not_write_config(self):
        def fail_create(args, **kwargs):
            if args[1:3] == ['do', 'space.new']:
                raise subprocess.CalledProcessError(1, args)
            return self.fake_app(args, **kwargs)
        with patch.object(seed.subprocess, 'run', fail_create):
            with self.assertRaises(subprocess.CalledProcessError):
                seed.seed(self.home, True)
        self.assertFalse(self.target.exists())
        self.assertIn(['herdr-app', 'do', 'space.select', '--id', 'local-share'], self.calls)
        self.assertIn(['herdr-app', 'do', 'pane.focus', '--pane', 'pane-original'], self.calls)
