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

    def test_copies_match_the_source_and_an_approval_for_the_replaced_copy_does_not_carry_over(self):
        # User rule (2026-11-05): only the review policy approves a new copy.
        self.config(self.old)
        with patch.object(installer, 'source_commit', lambda source: (None, 'no review in this fixture')):
            result = self.refresh()
        for name in (*installer.CLEANUP['files'], 'sleep_idle_sessions.py', 'file_lock.py', 'agent_env.py'):
            self.assertEqual((self.base/name).read_bytes(), (self.REPO/'scripts'/name).read_bytes(), name)
        self.assertFalse(result['observers']['close-finished-spaces']['approved_for_this_copy'])
        self.assertEqual(json.loads((self.base/'close-finished-spaces.json').read_text())['reviewed_observer_sha256'], self.old)

    def test_an_approval_for_other_code_is_not_kept_for_this_copy(self):
        self.config('someone-elses-hash')
        with patch.object(installer, 'source_commit', lambda source: (None, 'no review in this fixture')):
            result = self.refresh()
        self.assertFalse(result['observers']['close-finished-spaces']['approved_for_this_copy'])
        self.assertEqual(json.loads((self.base/'close-finished-spaces.json').read_text())['reviewed_observer_sha256'], 'someone-elses-hash')

    def test_nothing_is_written_when_no_observer_is_registered(self):
        for plist in (self.home/'Library/LaunchAgents').iterdir():
            plist.unlink()
        self.assertEqual(self.refresh()['refreshed'], [])
        self.assertEqual((self.base/'agent_sessions.py').read_text(), '# old agent_sessions.py\n')


class ReviewPolicyTests(RefreshTests):
    """User rule (2026-11-05): an installed copy is approved by policy (actor auto-policy) when the
    harness cross-family review of its commit is PASS, or CONDITIONAL with only install/live checks left."""
    SHA = '9681baf' + '0' * 33
    INSTALL_ONLY = 'VERDICT: CONDITIONAL\n\n- **P2 — 설치·실동작 검증 미완료:** 설치 후 확인 필요. 대상 9681baf\n'

    def setUp(self):
        super().setUp()
        self.harness = self.home / 'harness'
        (self.harness / 'records/m/2026-11').mkdir(parents=True)
        self.local = self.home / '.config/herdr-app/data/sixfold/harness-local'
        (self.local / 'reviews').mkdir(parents=True)
        (self.local / 'config.json').write_text(json.dumps({'repo_path': str(self.harness)}))
        self.n = 0
        self.record('report', report_id='R1', summary={'done': '관찰기 9681baf 보완'})

    def record(self, kind, **fields):
        self.n += 1
        rid = f'01M6N{self.n:021d}'
        (self.harness / f'records/m/2026-11/{rid}.json').write_text(json.dumps({'id': rid, 'type': kind, **fields}))
        return rid

    def verdict(self, value, text, report='R1'):
        name = f'{report}-codex-{self.n}.md'
        (self.local / 'reviews' / name).write_text(text, encoding='utf-8')
        return self.record('verdict', target_report_id=report, value=value,
                           note=f'codex-exec 검수, 전문은 이 PC harness-local/reviews/{name}; cross-family')

    def approval(self):
        return installer.review_approval(self.home, self.REPO, commit=self.SHA)

    def test_pass_and_install_only_conditional_are_approved(self):
        self.verdict('PASS', 'VERDICT: PASS\n9681baf 확인\n')
        self.assertEqual((self.approval()['ok'], self.approval()['why']), (True, 'PASS'))
        vid = self.verdict('CONDITIONAL', self.INSTALL_ONLY)
        got = self.approval()
        self.assertTrue(got['ok'], got)
        self.assertEqual((got['verdict_id'], got['value'], got['commit']), (vid, 'CONDITIONAL', self.SHA))

    def test_every_other_result_is_not_approved(self):
        cases = {
            'no verdict': None,
            'hold': ('HOLD', 'VERDICT: HOLD\n- **P2 — 기록 유실:** 9681baf\n'),
            'conditional with a code finding': ('CONDITIONAL', self.INSTALL_ONLY + '- **P2 — 재시도 대기열 유실:** x\n'),
            'conditional without findings': ('CONDITIONAL', 'VERDICT: CONDITIONAL\n9681baf\n'),
            'review file without the commit': ('PASS', 'VERDICT: PASS\n다른 커밋\n'),
        }
        for name, case in cases.items():
            with self.subTest(name):
                self.setUp()
                if case:
                    self.verdict(*case)
                self.assertFalse(self.approval()['ok'], name)

    def test_a_later_hold_on_the_same_commit_wins(self):
        self.verdict('PASS', 'VERDICT: PASS\n9681baf\n')
        self.record('report', report_id='R2', summary={'done': '9681baf 다시'})
        self.verdict('HOLD', 'VERDICT: HOLD\n- **P1 — 결함:** 9681baf\n', report='R2')
        self.assertEqual(self.approval()['why'], 'verdict HOLD')

    def test_refresh_records_the_policy_approval_for_both_observers(self):
        self.config('someone-elses-hash')
        (self.base/'sleep-idle-sessions.json').write_text(json.dumps({'user_approved_apply': True, 'reviewed_observer_sha256': 'old'}))
        vid = self.verdict('CONDITIONAL', self.INSTALL_ONLY)
        with patch.object(installer, 'source_commit', lambda source: (self.SHA, None)):
            result = self.refresh()
        for job in ('close-finished-spaces', 'sleep-idle-sessions'):
            config = json.loads((self.base/f'{job}.json').read_text())
            self.assertTrue(result['observers'][job]['approved_for_this_copy'], job)
            self.assertEqual(config['reviewed_observer_sha256'], result['observers'][job]['observer_sha256'])
            self.assertEqual({k: config['reviewed_by_policy'][k] for k in ('actor', 'verdict_id', 'commit')},
                             {'actor': 'auto-policy', 'verdict_id': vid, 'commit': self.SHA})
            self.assertTrue(config['reviewed_by_policy']['review_file'].endswith('.md'))

    def test_refresh_without_an_allowing_review_installs_but_does_not_approve(self):
        self.config('someone-elses-hash')
        self.verdict('HOLD', 'VERDICT: HOLD\n9681baf\n')
        for commit in ((self.SHA, None), (None, 'source scripts have uncommitted changes')):
            with self.subTest(commit[1] or 'hold'), patch.object(installer, 'source_commit', lambda source, c=commit: c):
                result = self.refresh()
                self.assertFalse(result['observers']['close-finished-spaces']['approved_for_this_copy'])
                config = json.loads((self.base/'close-finished-spaces.json').read_text())
                self.assertEqual(config['reviewed_observer_sha256'], 'someone-elses-hash')
                self.assertNotIn('reviewed_by_policy', config)


class CarriedApprovalTests(ReviewPolicyTests):
    """An approval carried by the old installer (hash = this copy, policy record of an older copy)."""

    def carried(self):
        self.refresh_plain = installer.spec_hash(self.REPO/'scripts', installer.CLEANUP)
        with patch.object(installer, 'source_commit', lambda source: (None, 'x')):
            self.refresh()   # copies the source; nothing approved
        new = installer.spec_hash(self.base, installer.CLEANUP)
        (self.base/'close-finished-spaces.json').write_text(json.dumps({'user_approved_apply': True, 'reviewed_observer_sha256': new,
            'reviewed_by_policy': {'actor': 'auto-policy', 'observer_sha256': 'older-copy', 'commit': 'old'}}))
        return new

    def test_is_judged_again_and_recorded_when_the_review_allows(self):
        new = self.carried()
        vid = self.verdict('CONDITIONAL', self.INSTALL_ONLY)
        with patch.object(installer, 'source_commit', lambda source: (self.SHA, None)):
            result = self.refresh()
        config = json.loads((self.base/'close-finished-spaces.json').read_text())
        self.assertTrue(result['observers']['close-finished-spaces']['approved_for_this_copy'])
        self.assertEqual((config['reviewed_observer_sha256'], config['reviewed_by_policy']['observer_sha256'],
                          config['reviewed_by_policy']['verdict_id']), (new, new, vid))

    def test_is_withdrawn_when_the_review_does_not_allow(self):
        self.carried()
        self.verdict('HOLD', 'VERDICT: HOLD\n- **P1 — 결함:** 9681baf\n')
        with patch.object(installer, 'source_commit', lambda source: (self.SHA, None)):
            result = self.refresh()
        self.assertFalse(result['observers']['close-finished-spaces']['approved_for_this_copy'])
        self.assertEqual(json.loads((self.base/'close-finished-spaces.json').read_text())['reviewed_observer_sha256'], 'older-copy')
