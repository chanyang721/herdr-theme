"""Catalog classification, version families and the harness view, on temporary files only."""
from datetime import date
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import doc_catalog  # noqa: E402
from resolve_doc_pins import catalog  # noqa: E402


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='doc-catalog-')
        self.root = Path(self.temporary.name).resolve()
        self.docs = self.root / 'docs'
        self.app = self.root / 'app'
        self.config = {'version': 1, 'spaces': {'sp1': {'name': 'Demo', 'folders': [str(self.docs)], 'pins': []}}}
        self.today = date(2026, 11, 4)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, name, text='본문', base=None):
        path = (base or self.docs) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def view(self):
        return catalog(self.config, 'sp1', self.today, self.app)

    def by_name(self, data):
        return {d['name']: d for d in data['documents'] if not d.get('harness')}

    def test_versions_fold_under_the_newest_and_archive_is_separate(self):
        self.file('20261102_데모_견적_회신안.md')
        self.file('20261103_데모_견적_회신안_공유본.md')
        self.file('20261103_데모_견적_회신안.v1-before-review.md')
        self.file('_보관/20261101_데모_견적_회신안.md')
        rows = self.by_name(self.view())
        head = rows['20261103_데모_견적_회신안_공유본.md']
        self.assertEqual(head['state'], 'latest')
        self.assertEqual(head['kind'], 'reply')
        self.assertEqual({rows[n]['state'] for n in ('20261102_데모_견적_회신안.md', '20261103_데모_견적_회신안.v1-before-review.md')}, {'previous'})
        self.assertEqual(len(head['versions']), 2)
        self.assertEqual(rows['20261101_데모_견적_회신안.md']['state'], 'archived')
        self.assertTrue(head['recent'])

    def test_undated_same_names_in_two_folders_stay_separate(self):
        self.file('a/README.md')
        self.file('b/README.md')
        heads = [d for d in self.view()['documents'] if d['name'] == 'README.md']
        self.assertEqual([d['state'] for d in heads], ['latest', 'latest'])

    def test_dated_copies_in_shared_folders_join_the_same_family(self):
        self.file('20261027_전체구조_정리.md')
        self.file('20261027_전체구조_공유본/20261027_전체구조_정리.md')
        rows = [d for d in self.view()['documents'] if d['name'] == '20261027_전체구조_정리.md']
        self.assertEqual(sorted(d['state'] for d in rows), ['latest', 'previous'])
        self.assertEqual(next(d for d in rows if d['state'] == 'latest')['folder'], '')

    def test_pinned_document_heads_its_family_and_is_listed_once(self):
        self.file('20261101_데모_구조.md')
        newest = self.file('20261103_데모_구조.md')
        self.config['spaces']['sp1']['pins'] = [{'id': 'p', 'label': '구조', 'kind': 'latest', 'root': str(self.docs), 'topic': '데모_구조.md'}]
        data = self.view()
        self.assertEqual([d['id'] for d in data['documents'] if d.get('path') == str(newest)], ['p'])
        pin = data['documents'][0]
        self.assertEqual((pin['kind'], len(pin['versions'])), ('structure', 1))
        self.assertTrue(all(d['state'] == 'previous' for d in data['documents'][1:]))

    def test_kinds_come_from_folder_then_name_and_local_rules_replace_defaults(self):
        self.file('adr/0015-shared-queue-status.md')
        self.file('20261104_계정목록.md')
        self.file('20261104_무언가.md')
        rows = self.by_name(self.view())
        self.assertEqual(rows['0015-shared-queue-status.md']['kind'], 'decision')
        self.assertEqual(rows['20261104_계정목록.md']['kind'], 'account')
        self.assertEqual(rows['20261104_무언가.md']['kind'], 'other')
        self.config['classify'] = {'kinds': [{'id': 'misc', 'label': '잡무', 'terms': ['무언가']}]}
        data = self.view()
        self.assertEqual(self.by_name(data)['20261104_무언가.md']['kind'], 'misc')
        self.assertEqual([k['id'] for k in data['kinds']], ['misc', 'other'])

    def test_labels_drop_dates_shared_prefix_and_long_hashes(self):
        for name in ('20261101_데모_가.md', '20261102_데모_나.md', '20261103_데모_자동검토_a1b2c3d4.md'):
            self.file(name)
        labels = {d['name']: d['label'] for d in self.view()['documents']}
        self.assertEqual(labels['20261101_데모_가.md'], '가')
        self.assertEqual(labels['20261103_데모_자동검토_a1b2c3d4.md'], '자동검토 #a1b2c3')

    def test_reading_the_catalog_changes_no_file(self):
        self.file('20261104_회신.md')
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.view()
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def harness_folder(self, space='sp1', machine=None):
        base = self.app / 'data/sixfold/harness-local/views/workspaces'
        root = base / f'core-{space}'
        root.mkdir(parents=True)
        (base / 'index.json').write_text(json.dumps({'workspaces': [
            {'workspace_id': f'other-{space}', 'space_id': space, 'machine_name': 'remote'},
            {'workspace_id': f'core-{space}', 'space_id': space, 'machine_name': machine}]}))
        return root

    def test_harness_sections_follow_the_folder_contract(self):
        root = self.harness_folder()
        listed = self.file('20261104_데모_구조.md')
        for name in ('README.md', 'context/goal.md', 'context/constraints.md', 'next.md', 'escalation.md',
                     'history/2026-11/2026-11-04/fix.md', 'history/2026-10/2026-10-30/old.md',
                     'decisions/2026-11-03-choose.md', 'brain/brain.md', '.hidden.md'):
            self.file(name, base=root)
        (root / 'docs/고정').mkdir(parents=True)
        os.symlink(listed, root / 'docs/고정/20261104_데모_구조.md')
        os.symlink(root / 'missing.md', root / 'docs/고정/broken.md')
        data = self.view()
        sections = {s['id']: s for s in data['harness']['sections']}
        self.assertEqual(list(sections), ['status', 'history', 'decisions', 'docs', 'brain'])
        rows = {d['id']: d for d in data['documents'] if d.get('harness')}
        status = [rows[i]['name'] for i in sections['status']['groups'][0]['ids']]
        self.assertEqual(status, ['README.md', 'goal.md', 'constraints.md', 'next.md', 'escalation.md'])
        self.assertEqual([g['label'] for g in sections['history']['groups']], ['2026-11', '2026-10'])
        alias = rows[sections['docs']['groups'][0]['ids'][0]]
        self.assertEqual(alias['aliasOf'], self.by_name(data)['20261104_데모_구조.md']['id'])
        self.assertEqual(len(sections['docs']['groups'][0]['ids']), 1, 'broken links are hidden')
        self.assertFalse(any(d['name'].startswith('.') for d in rows.values()))
        self.assertIn(str(root), data['watchRoots'])

    def test_harness_version_folders_fold_under_the_newest_link(self):
        root = self.harness_folder()
        older = self.file('20261101_데모_구조.md', base=self.root / 'src')
        newer = self.file('20261103_데모_구조.md', base=self.root / 'src')
        bundle = root / 'docs/주제/데모_구조'
        bundle.mkdir(parents=True)
        os.symlink(older, bundle / older.name)
        os.symlink(newer, bundle / newer.name)
        data = self.view()
        rows = {d['name']: d for d in data['documents'] if d.get('harness')}
        head, previous = rows[newer.name], rows[older.name]
        self.assertEqual((head['label'], head['versions']), ('데모 구조', [previous['id']]))
        self.assertEqual((previous['state'], previous['head']), ('previous', head['id']))
        group = next(s for s in data['harness']['sections'] if s['id'] == 'docs')['groups'][0]
        self.assertEqual(group['label'], '주제')

    def test_harness_is_hidden_without_a_local_entry(self):
        self.harness_folder(space='other')
        self.assertIsNone(self.view()['harness'])
        root = self.root / 'manual'
        self.file('README.md', base=root)
        self.config['spaces']['sp1']['harness'] = {'root': str(root)}
        self.assertEqual(self.view()['harness']['root'], str(root))

    def test_remote_machine_entry_is_not_this_mac(self):
        base = self.app / 'data/sixfold/harness-local/views/workspaces'
        (base / 'core-sp1').mkdir(parents=True)
        (base / 'index.json').write_text(json.dumps({'workspaces': [{'workspace_id': 'core-sp1', 'space_id': 'sp1', 'machine_name': 'remote'}]}))
        self.assertIsNone(doc_catalog.harness_root('sp1', self.app))


if __name__ == '__main__':
    unittest.main()
