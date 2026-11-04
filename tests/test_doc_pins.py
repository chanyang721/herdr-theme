"""Selection and mutation use temporary originals and never invoke owned_links."""
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from resolve_doc_pins import identity, mutate, resolve


class PinTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='doc-pins-')
        self.root = Path(self.temporary.name).resolve()
        self.config = {'version': 1, 'spaces': {'sp': {'name': 'Demo', 'folders': [str(self.root)], 'pins': [], 'recent': {'limit': 6, 'days': 14}}}}
        self.today = date(2026, 11, 2)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, name, text='original'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def rows(self):
        return resolve(self.config, 'sp', self.today)['documents']

    def latest(self, topic, root=None):
        self.config['spaces']['sp']['pins'].append({'id': 'always', 'label': '구조', 'kind': 'latest', 'root': str(root or self.root), 'topic': topic})

    def test_latest_date_beats_mtime_and_preserves_topic_id(self):
        old = self.file('20261029_프로젝트비_구조.md')
        fresh = self.file('20261102_프로젝트비_구조.md')
        os.utime(old, (2_000_000_000, 2_000_000_000))
        self.latest('프로젝트비_구조.md')
        row = self.rows()[0]
        self.assertEqual(row['path'], str(fresh))
        self.assertEqual(row['id'], 'always')
        newest = self.file('20261102_프로젝트비_구조.md', 'updated')
        self.assertEqual(self.rows()[0]['path'], str(newest))
        self.assertEqual(old.read_text(), 'original')

    def test_iso_dates_share_topic_with_compact_dates(self):
        self.file('20261029_pmo-회신.md')
        fresh = self.file('2026-11-02-pmo-회신.md')
        self.file('2026-11-03-pmo-회신.md')
        self.latest('pmo-회신.md')
        self.assertEqual(self.rows()[0]['path'], str(fresh))
        self.assertEqual(len(self.rows()), 1)

    def test_nonrecursive_pin_ignores_shared_copy_collisions_and_follows_new_date(self):
        self.file('20261029_전체구조.md')
        self.file('shared/20261102_전체구조.md')
        self.file('other/20261102_전체구조.md')
        self.latest('전체구조.md')
        self.config['spaces']['sp']['pins'][0]['recursive'] = False
        self.assertEqual(self.rows()[0]['name'], '20261029_전체구조.md')
        fresh = self.file('20261102_전체구조.md')
        self.assertEqual(self.rows()[0]['path'], str(fresh))
        self.config['spaces']['sp']['pins'][0].pop('recursive')
        self.config['spaces']['sp']['pins'][0]['depth'] = 1
        self.assertEqual(self.rows()[0]['path'], str(fresh))

    def test_archives_symlinks_and_future_versions_are_excluded(self):
        good = self.file('20261101_구조.md')
        for prefix in ('archive', '아카이브', '보관', '.before-v1'):
            self.file(prefix + '/20261102_구조.md')
        self.file('20261103_구조.md')
        outside = self.file('other/20261102_구조.md')
        self.latest('구조.md', self.root / 'approved')
        (self.root / 'approved').mkdir()
        (self.root / 'approved' / good.name).write_text('safe')
        (self.root / 'approved' / outside.name).symlink_to(outside)
        (self.root / 'approved' / 'nested').symlink_to(outside.parent, target_is_directory=True)
        self.assertEqual(self.rows()[0]['path'], str(self.root / 'approved' / good.name))

    def test_same_date_collision_is_visible_and_missing_pin_is_retained(self):
        self.file('a/20261102_구조.md')
        self.file('b/20261102_구조.md')
        self.latest('구조.md')
        row = self.rows()[0]
        self.assertEqual(row['status'], 'conflict')
        self.assertIsNone(row['path'])
        self.assertEqual(len(row['candidates']), 2)
        self.config['spaces']['sp']['pins'].append({'id': 'gone', 'label': 'missing', 'kind': 'file', 'path': str(self.root / 'missing.md')})
        self.assertEqual(self.rows()[1]['status'], 'missing')
        self.assertEqual(self.rows()[1]['id'], 'gone')

    def test_recent_fourteen_day_window_topic_grouping_limit_and_no_pin_duplicate(self):
        for day in range(20, 32):
            self.file(f'202610{day}_확인요청-{day}.md')
        self.file('20261019_회신-old.md')
        self.file('20261029_회신-topic.md')
        latest = self.file('20261102_회신-topic.md')
        self.file('20261103_회신-future.md')
        self.file('20261102_일반노트.md')
        self.file('archive/20261102_회신-archive.md')
        rows = self.rows()
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[0]['path'], str(latest))
        self.assertEqual(sum(item['topic'] == '회신-topic.md' for item in rows), 1)
        self.latest('회신-topic.md')
        self.assertEqual(len(self.rows()), 7)
        self.assertEqual(sum(item.get('topic') == '회신-topic.md' for item in self.rows()), 1)
        self.config['spaces']['sp']['recent']['limit'] = 12
        names = [item['name'] for item in self.rows()]
        self.assertNotIn('20261019_회신-old.md', names)
        self.assertNotIn('20261103_회신-future.md', names)

    def test_unicode_topic_and_recent_keyword_normalization(self):
        target = self.file('20261102_프로젝트비_회신.md')
        self.latest('프로젝트비_회신.md')
        import unicodedata
        self.config['spaces']['sp']['pins'][0]['topic'] = unicodedata.normalize('NFD', '프로젝트비_회신.md')
        self.assertEqual(self.rows()[0]['path'], str(target))

    def test_missing_source_warning_is_not_an_empty_success(self):
        self.config['spaces']['sp']['folders'] = [str(self.root / 'unavailable')]
        output = resolve(self.config, 'sp', self.today)
        self.assertIn('source_unavailable', output['warnings'])
        self.assertEqual(output['documents'], [])

    def test_file_pin_rejects_archive_symlink_and_escape(self):
        source = self.file('source.md')
        link = self.root / 'linked.md'
        link.symlink_to(source)
        for path, root in [(link, self.root), (source, self.root / 'scope'), (self.file('archive/doc.md'), self.root)]:
            self.config['spaces']['sp']['pins'] = [{'id': 'bad', 'label': 'bad', 'kind': 'file', 'path': str(path), 'root': str(root)}]
            self.assertEqual(self.rows()[0]['status'], 'error')

    def test_pin_unpin_only_changes_rules_and_excludes_auto_topic(self):
        path = self.file('20261102_회신-topic.md')
        before = path.read_bytes()
        mutate(self.config, 'sp', pin_path=str(path))
        rows = self.rows()
        self.assertTrue(rows[0]['pinned'])
        self.assertEqual(rows[0]['kind'], 'latest')
        mutate(self.config, 'sp', unpin=rows[0]['id'])
        self.assertEqual(self.rows(), [])
        mutate(self.config, 'sp', pin_path=str(path))
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(path.read_bytes(), before)

    def test_read_only_cli_never_writes_index_links_or_rules(self):
        self.file('20261102_회신-topic.md')
        config = self.root / 'rules.json'
        config.write_text(json.dumps(self.config))
        before = {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        script = Path(__file__).resolve().parents[1] / 'scripts/resolve_doc_pins.py'
        result = subprocess.run([sys.executable, str(script), '--config', str(config), '--space', 'sp'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['spaceId'], 'sp')
        after = {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(config.with_suffix('.lock').exists())

    def test_source_permission_failure_retains_pin(self):
        target = self.file('struct.md')
        self.config['spaces']['sp']['pins'] = [{'id': 'always', 'label': 'structure', 'kind': 'file', 'path': str(target)}]
        with patch.object(Path, 'is_file', side_effect=PermissionError('denied')):
            self.assertEqual(self.rows()[0]['status'], 'error')


if __name__ == '__main__':
    unittest.main()
