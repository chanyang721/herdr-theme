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

    def test_imported_helpers_are_copied_beside_the_observer_outside_the_reviewed_hash(self):
        (self.source/'scripts/file_lock.py').write_text('# fixture lock\n')
        (self.source/'scripts/agent_env.py').write_text('# fixture env\n')
        before = installer.install(self.home,self.source)['observer_sha256']
        with patch.object(installer.subprocess,'run',self.launchctl):
            installed = installer.install(self.home,self.source,execute=True)
        folder = Path(installed['script']).parent
        self.assertEqual(((folder/'file_lock.py').read_text(), (folder/'agent_env.py').read_text()), ('# fixture lock\n', '# fixture env\n'))
        self.assertEqual(installed['observer_sha256'], before)

    def test_existing_settings_are_preserved(self):
        base=self.home/'Library/Application Support/HerdrSixfold';base.mkdir(parents=True)
        existing={'fixed_names':['Custom'], 'fixed_spaces':[{'id':'stable'}], 'notify_terminal':'local-review'}
        (base/'close-finished-spaces.json').write_text(json.dumps(existing))
        with patch.object(installer.subprocess,'run',self.launchctl):installer.install(self.home,self.source,execute=True)
        self.assertEqual(json.loads((base/'close-finished-spaces.json').read_text()),existing)

    def test_apply_refuses_missing_or_unobserved_trial(self):
        base=self.home/'Library/Application Support/HerdrSixfold';base.mkdir(parents=True)
        (base/'close-finished-spaces-state.json').write_text(json.dumps({'trial':{'started_at':0,'samples':7}}))
        with self.assertRaises(ValueError):installer.install(self.home,self.source,apply=True,execute=True)
        self.assertFalse((self.home/'Library/LaunchAgents').exists())

    def test_apply_switch_requires_current_code_and_finished_review_window(self):
        import hashlib
        base=self.home/'Library/Application Support/HerdrSixfold';base.mkdir(parents=True)
        code_hash=hashlib.sha256(b'# fixture observer\n# fixture evidence\n').hexdigest()  # agent_sessions.py absent in this fixture
        (base/'close-finished-spaces-state.json').write_text(json.dumps({'observer_sha256':code_hash,'last_at':2000,'trial':{'started_at':0,'samples':7,'error_count':0}}))
        with patch.object(installer.time,'time',lambda:2000),patch.object(installer.subprocess,'run',self.launchctl):
            installed=installer.install(self.home,self.source,apply=True,execute=True)
        self.assertIn('--apply',plistlib.loads(Path(installed['plist']).read_bytes())['ProgramArguments'])
        config=json.loads((base/'close-finished-spaces.json').read_text())
        self.assertEqual(config['reviewed_dry_run_at'],2000)
        self.assertEqual(config['reviewed_observer_sha256'],code_hash)

    def test_user_approved_apply_needs_one_recorded_dry_run_of_the_current_code(self):
        import hashlib
        base=self.home/'Library/Application Support/HerdrSixfold';base.mkdir(parents=True)
        code_hash=hashlib.sha256(b'# fixture observer\n# fixture evidence\n').hexdigest()
        state=base/'close-finished-spaces-state.json'
        state.write_text(json.dumps({'observer_sha256':'older','last_at':2000,'trial':{'started_at':1900,'samples':1,'error_count':0}}))
        with patch.object(installer.time,'time',lambda:2000),self.assertRaises(ValueError):
            installer.install(self.home,self.source,apply=True,user_approved=True,execute=True)
        state.write_text(json.dumps({'observer_sha256':code_hash,'last_at':2000,'trial':{'started_at':1900,'samples':1,'error_count':0}}))
        with patch.object(installer.time,'time',lambda:2000),patch.object(installer.subprocess,'run',self.launchctl):
            installed=installer.install(self.home,self.source,apply=True,user_approved=True,execute=True)
        self.assertIn('--apply',plistlib.loads(Path(installed['plist']).read_bytes())['ProgramArguments'])
        config=json.loads((base/'close-finished-spaces.json').read_text())
        self.assertEqual((config['user_approved_apply'],config['reviewed_observer_sha256']),(True,code_hash))

    def test_harness_location_comes_from_the_harness_local_config(self):
        repo=Path(self.tmp.name)/'harness';(repo/'runtime').mkdir(parents=True);(repo/'runtime/harness.py').write_text('')
        local=self.home/'.config/herdr-app/data/sixfold/harness-local';local.mkdir(parents=True)
        (local/'config.json').write_text(json.dumps({'repo_path':str(repo)}))
        self.assertEqual(installer.detect_harness(self.home)['script'],str(repo/'runtime/harness.py'))
        with patch.object(installer.subprocess,'run',self.launchctl):installer.install(self.home,self.source,execute=True)
        config=json.loads((self.home/'Library/Application Support/HerdrSixfold/close-finished-spaces.json').read_text())
        self.assertEqual(config['harness']['script'],str(repo/'runtime/harness.py'))

if __name__=='__main__':unittest.main()


class RefreshTests(unittest.TestCase):
    """Registered observer copies follow the source without plist or launchctl."""
    REPO = Path(__file__).resolve().parents[1]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.base = installer.site_config.folder('state_dir', self.home, installer.site_config.load(self.home))
        self.base.mkdir(parents=True)
        agents = self.home/'Library/LaunchAgents'; agents.mkdir(parents=True)
        for job in ('close-finished-spaces', 'sleep-idle-sessions'):
            (agents/(installer.site_config.label(job, self.home) + '.plist')).write_bytes(plistlib.dumps({'Label': job}))
        names = {*installer.CLEANUP['files'], 'sleep_idle_sessions.py', 'session_sleep_stub.py', 'file_lock.py', 'agent_env.py'}
        for name in names:
            (self.base/name).write_text(f'# old {name}\n')
        self.old = installer.spec_hash(self.base, installer.CLEANUP)

    def config(self, reviewed):
        (self.base/'close-finished-spaces.json').write_text(json.dumps({'user_approved_apply': True, 'reviewed_observer_sha256': reviewed}))

    def refresh(self):
        def forbidden(*a, **k):
            raise AssertionError('refresh must not run launchctl')
        with patch.object(installer.subprocess, 'run', forbidden):
            return installer.refresh_installed(self.home, self.REPO)

    def test_copies_match_the_source_and_the_approval_for_the_replaced_copy_carries_over(self):
        self.config(self.old)
        result = self.refresh()
        for name in (*installer.CLEANUP['files'], 'sleep_idle_sessions.py', 'file_lock.py', 'agent_env.py'):
            self.assertEqual((self.base/name).read_bytes(), (self.REPO/'scripts'/name).read_bytes(), name)
        new = installer.spec_hash(self.REPO/'scripts', installer.CLEANUP)
        self.assertTrue(result['observers']['close-finished-spaces']['approval_carried'])
        self.assertEqual(json.loads((self.base/'close-finished-spaces.json').read_text())['reviewed_observer_sha256'], new)

    def test_an_approval_for_other_code_does_not_carry_over(self):
        self.config('someone-elses-hash')
        result = self.refresh()
        self.assertFalse(result['observers']['close-finished-spaces']['approval_carried'])
        self.assertEqual(json.loads((self.base/'close-finished-spaces.json').read_text())['reviewed_observer_sha256'], 'someone-elses-hash')

    def test_nothing_is_written_when_no_observer_is_registered(self):
        for plist in (self.home/'Library/LaunchAgents').iterdir():
            plist.unlink()
        self.assertEqual(self.refresh()['refreshed'], [])
        self.assertEqual((self.base/'agent_sessions.py').read_text(), '# old agent_sessions.py\n')
