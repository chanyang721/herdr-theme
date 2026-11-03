import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('space_cleanup_install', Path(__file__).parents[1]/'scripts/install_space_cleanup.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)/'home'
        self.source = Path(self.tmp.name)/'source'
        (self.source/'scripts').mkdir(parents=True)
        (self.source/'config').mkdir()
        (self.source/'scripts/close_finished_spaces.py').write_text('# fixture observer\n')
        (self.source/'scripts/space_job_evidence.py').write_text('# fixture evidence\n')
        (self.source/'config/close-finished-spaces.example.json').write_text(json.dumps({'fixed_names':['Share'], 'fixed_spaces':[], 'idle_seconds':600, 'trial_seconds':1800}))
        self.calls = []
        self.loaded = False

    def launchctl(self, args, **kwargs):
        self.calls.append(args)
        class Result:
            returncode = 0
        result = Result()
        if args[1]=='print':result.returncode = 0 if self.loaded else 1
        elif args[1]=='bootstrap':self.loaded=True
        elif args[1]=='bootout':self.loaded=False
        return result

    def test_plan_has_no_side_effects_and_defaults_to_dry_run(self):
        plan = installer.install(self.home,self.source)
        self.assertEqual(plan['mode'],'--dry-run')
        self.assertFalse(self.home.exists())

    def test_registers_only_dry_run_and_is_idempotent(self):
        with patch.object(installer.subprocess,'run',self.launchctl):
            first=installer.install(self.home,self.source,execute=True)
            plist=Path(first['plist']);before=plist.stat().st_mtime_ns
            second=installer.install(self.home,self.source,execute=True)
        self.assertTrue(second['loaded']);self.assertEqual(plist.stat().st_mtime_ns,before)
        doc=plistlib.loads(plist.read_bytes())
        self.assertEqual(doc['StartInterval'],300)
        self.assertIn('--dry-run',doc['ProgramArguments']);self.assertNotIn('--apply',doc['ProgramArguments'])
        self.assertNotIn('KeepAlive',doc)
        self.assertEqual(sum(call[1]=='bootstrap' for call in self.calls),1)
        self.assertEqual(sum(call[1]=='kickstart' for call in self.calls),1)
        self.assertFalse((self.home/'.config/herdr-app').exists(),'never writes app files')

    def test_existing_settings_are_preserved(self):
        base=self.home/'Library/Application Support/LukukuWatch';base.mkdir(parents=True)
        existing={'fixed_names':['Custom'], 'fixed_spaces':[{'id':'stable'}], 'notify_terminal':'local-review'}
        (base/'close-finished-spaces.json').write_text(json.dumps(existing))
        with patch.object(installer.subprocess,'run',self.launchctl):installer.install(self.home,self.source,execute=True)
        self.assertEqual(json.loads((base/'close-finished-spaces.json').read_text()),existing)

    def test_apply_refuses_missing_or_unobserved_trial(self):
        base=self.home/'Library/Application Support/LukukuWatch';base.mkdir(parents=True)
        (base/'close-finished-spaces-state.json').write_text(json.dumps({'trial':{'started_at':0,'samples':7}}))
        with self.assertRaises(ValueError):installer.install(self.home,self.source,apply=True,execute=True)
        self.assertFalse((self.home/'Library/LaunchAgents').exists())

    def test_apply_switch_requires_current_code_and_finished_review_window(self):
        import hashlib
        base=self.home/'Library/Application Support/LukukuWatch';base.mkdir(parents=True)
        code_hash=hashlib.sha256(b'# fixture observer\n# fixture evidence\n').hexdigest()
        (base/'close-finished-spaces-state.json').write_text(json.dumps({'observer_sha256':code_hash,'last_at':2000,'trial':{'started_at':0,'samples':7,'error_count':0}}))
        with patch.object(installer.time,'time',lambda:2000),patch.object(installer.subprocess,'run',self.launchctl):
            installed=installer.install(self.home,self.source,apply=True,execute=True)
        self.assertIn('--apply',plistlib.loads(Path(installed['plist']).read_bytes())['ProgramArguments'])
        config=json.loads((base/'close-finished-spaces.json').read_text())
        self.assertEqual(config['reviewed_dry_run_at'],2000)
        self.assertEqual(config['reviewed_observer_sha256'],code_hash)

if __name__=='__main__':unittest.main()
