"""Routing shared-folder documents to spaces by their words, and newest-write ordering; temp files only."""
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import doc_routing  # noqa: E402
from collect_docs import documents  # noqa: E402
from resolve_doc_pins import catalog  # noqa: E402


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='doc-routing-')
        self.root = Path(self.temporary.name).resolve()
        self.reports = self.root / 'reports'
        self.downloads = self.root / 'downloads'
        self.app = self.root / 'app'
        self.routing_file = self.root / 'project-docs-routing.local.json'
        self.routing_file.write_text(json.dumps({
            'version': 1, 'fallback': 'Share',
            'sources': [{'path': str(self.reports)}, {'path': str(self.downloads), 'depth': 1, 'requireMatch': True}],
            'spaces': {'Alpha': {'terms': ['alpha', '알파']}, 'Beta': {'terms': ['beta', '베타']}}}), encoding='utf-8')
        self.routing = doc_routing.load(self.routing_file)
        self.config = {'version': 1, 'spaces': {
            'sp-a': {'name': 'Alpha', 'folders': [], 'pins': []},
            'sp-b': {'name': 'Beta', 'folders': [], 'pins': []},
            'sp-s': {'name': 'Share', 'folders': [], 'pins': []}}}
        self.today = date(2026, 11, 5)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, base, name, text='본문', mtime=None):
        path = base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def names(self, space):
        data = catalog(self.config, space, self.today, self.app, self.routing)
        return [d['name'] for d in data['documents'] if not d.get('harness') and d.get('state') != 'previous']

    def test_name_title_and_body_words_pick_the_space(self):
        self.file(self.reports, '20261105_알파_현황.md')
        self.file(self.reports, 'notes.html', '<html><head><title>Beta 견적</title></head><body>x</body></html>')
        self.file(self.reports, 'memo.md', '# 메모\n\n이번 주 alpha 일정 정리')
        self.assertEqual(sorted(self.names('sp-a')), ['20261105_알파_현황.md', 'memo.md'])
        self.assertEqual(self.names('sp-b'), ['notes.html'])

    def test_a_path_word_outweighs_a_body_mention_and_ties_go_to_the_fallback(self):
        self.file(self.reports, 'alpha/회신.md', 'beta 쪽 문의도 참고')
        self.file(self.reports, '공통_정리.md', 'alpha 와 beta 모두')
        self.file(self.reports, '일지.md', '아무 단어 없음')
        self.assertEqual(self.names('sp-a'), ['회신.md'])
        self.assertEqual(sorted(self.names('sp-s')), ['공통_정리.md', '일지.md'])

    def test_downloads_list_only_matching_documents_at_the_top_level(self):
        self.file(self.downloads, 'ALPHA-비용-초안.html', '<title>초안</title>')
        self.file(self.downloads, '개인_계약서.pdf')
        self.file(self.downloads, 'photo.png')
        self.file(self.downloads, 'deep/alpha-old.md')
        self.assertEqual(self.names('sp-a'), ['ALPHA-비용-초안.html'])
        self.assertEqual(self.names('sp-s'), [])

    def test_routed_files_are_not_moved_and_are_watched(self):
        path = self.file(self.downloads, 'alpha.md')
        data = catalog(self.config, 'sp-a', self.today, self.app, self.routing)
        row = next(d for d in data['documents'] if d['name'] == 'alpha.md')
        self.assertEqual(row['path'], str(path))
        self.assertEqual(row['routedFrom'], str(self.downloads))
        self.assertTrue(path.is_file())
        self.assertIn(str(self.downloads), data['watchRoots'])
        self.assertNotIn(str(self.downloads), catalog(self.config, 'sp-a', self.today, self.app, {})['watchRoots'])

    def test_newest_write_comes_first_whatever_the_name_date(self):
        self.file(self.reports, '20261104_alpha_a.md', mtime=1_700_000_000)
        self.file(self.reports, '20261101_alpha_b.md', mtime=1_700_000_500)
        self.file(self.reports, 'alpha_c.md', mtime=1_700_000_100)
        self.assertEqual(self.names('sp-a'), ['20261101_alpha_b.md', 'alpha_c.md', '20261104_alpha_a.md'])

    def test_pins_and_folders_stay_and_a_file_is_listed_once(self):
        pinned = self.file(self.reports, 'alpha_arch.md')
        own = self.root / 'alpha-docs'
        self.file(own, 'plan.md')
        self.config['spaces']['sp-a'].update(folders=[str(own), {'path': str(self.reports), 'match': ['alpha']}],
                                             pins=[{'id': 'p1', 'label': '구조', 'kind': 'file', 'path': str(pinned)}])
        data = catalog(self.config, 'sp-a', self.today, self.app, self.routing)
        rows = [d for d in data['documents'] if not d.get('harness')]
        self.assertEqual(rows[0]['id'], 'p1')
        self.assertTrue(rows[0]['pinned'])
        self.assertEqual(sorted(d['name'] for d in rows), ['alpha_arch.md', 'plan.md'])

    def test_title_decides_the_kind_when_the_name_says_nothing(self):
        self.file(self.reports, 'alpha_x.md', '# 고객 회신안\n')
        row = next(d for d in catalog(self.config, 'sp-a', self.today, self.app, self.routing)['documents'] if d['name'] == 'alpha_x.md')
        self.assertEqual(row['kind'], 'reply')

    def test_unknown_space_or_missing_file_routes_nothing(self):
        self.file(self.reports, 'alpha.md')
        self.config['spaces']['sp-x'] = {'name': 'Gamma', 'folders': [], 'pins': []}
        self.assertEqual(self.names('sp-x'), [])
        self.assertIsNone(doc_routing.load(self.root / 'missing.json'))
        self.assertEqual(doc_routing.routed(None, 'Alpha', documents), [])

    def test_cli_reads_the_routing_file_beside_the_rules(self):
        self.file(self.downloads, 'alpha.md')
        config = self.root / 'project-docs-pins.json'
        config.write_text(json.dumps(self.config), encoding='utf-8')
        script = Path(__file__).resolve().parents[1] / 'scripts/resolve_doc_pins.py'
        env = dict(os.environ, HERDR_APP_HOME=str(self.app))
        result = subprocess.run([sys.executable, str(script), '--config', str(config), '--space', 'sp-a'],
                                capture_output=True, text=True, check=True, env=env)
        self.assertIn('alpha.md', [d['name'] for d in json.loads(result.stdout)['documents']])


if __name__ == '__main__':
    unittest.main()
