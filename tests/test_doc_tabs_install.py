import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import install_doc_tabs as installer


class DocumentTabInstallTests(unittest.TestCase):
    def setUp(self):
        self.doc = {'spaces': [{'id': 'sp1', 'name': 'Demo', 'folder': '/demo', 'tabs': [
            {'id': 'work', 'name': 'Work', 'root': {'id': 'row', 'type': 'row', 'size': {'weight': 2},
             'children': [{'id': 'p1', 'type': 'block', 'content': {'terminal': 't1'}}]}}]}]}

    def test_appends_one_mod_tab_without_changing_existing_tree_or_focus(self):
        original = copy.deepcopy(self.doc)
        result, added = installer.ensure_document_tabs(self.doc, Path('/app'))
        self.assertEqual(self.doc, original)
        self.assertEqual(result['spaces'][0]['tabs'][0], original['spaces'][0]['tabs'][0])
        tab = result['spaces'][0]['tabs'][1]
        self.assertEqual(tab['root']['content']['mod'], 'project-docs-tabs')
        self.assertNotIn('terminal', tab['root']['content'])
        self.assertEqual(tab['root']['content']['props']['spaceId'], 'sp1')
        self.assertEqual(len(added), 1)
        again, added = installer.ensure_document_tabs(result, Path('/app'))
        self.assertEqual(again, result)
        self.assertEqual(added, [])

    def test_recreates_same_id_after_close_and_does_not_touch_remote_spaces(self):
        self.doc['spaces'].append({'id': 'remote/sp1', 'name': 'Remote', 'tabs': []})
        first, _ = installer.ensure_document_tabs(self.doc, Path('/app'))
        tab = first['spaces'][0]['tabs'].pop()
        second, added = installer.ensure_document_tabs(first, Path('/app'))
        self.assertEqual(second['spaces'][0]['tabs'][-1], tab)
        self.assertEqual(second['spaces'][1], self.doc['spaces'][1])
        self.assertEqual(len(added), 1)

    def test_existing_document_mod_inside_split_is_not_duplicated(self):
        self.doc['spaces'][0]['tabs'][0]['root']['children'].append(
            {'id': 'docs', 'content': {'mod': 'project-docs-tabs', 'props': {'spaceId': 'sp1'}}})
        result, added = installer.ensure_document_tabs(self.doc, Path('/app'))
        self.assertEqual(result, self.doc)
        self.assertEqual(added, [])

    def test_seed_preserves_user_settings_and_original_project_config(self):
        existing = {'version': 1, 'spaces': {'sp1': {'pins': [], 'recent': {'limit': 2}, 'custom': True}}}
        project = {'version': 1, 'spaces': {'Demo': {'folders': ['/docs']}}}
        before = copy.deepcopy(project)
        config = installer.seed_config(self.doc, existing, project, Path('/repo'))
        self.assertEqual(config, existing)
        self.assertEqual(project, before)
        config['spaces']['sp1']['custom'] = False
        self.assertTrue(existing['spaces']['sp1']['custom'])

    def test_share_seed_uses_stable_identity_and_preserves_document_sources(self):
        repo = Path(__file__).resolve().parents[1]
        site = {**installer.site_config.DEFAULTS, 'hub_space_ids': ['sp-share']}
        for space_id, name in [('other', 'Share'), ('sp-share', 'Renamed')]:
            config = installer.seed_space({'id': space_id, 'name': name}, {}, repo, site=site)
            self.assertTrue(any(pin.get('path') == str(repo/'COMMON_ROUTING.md') for pin in config['pins']))

    def test_project_documents_come_from_the_machine_local_site_config(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home/'docs').mkdir()
            (home/'docs/ARCH.md').write_text('# arch')
            (home/'20261101_ProjectB_overview.md').write_text('# b')
            site = {**installer.site_config.DEFAULTS, 'doc_tabs': {
                'Project A': {'sources': [{'path': '~/docs/ARCH.md', 'label': '구조'}], 'folders': ['~/docs']},
                'Project B': {'topics': [{'root': '~', 'suffix': 'ProjectB_overview.md', 'label': '개요'}],
                              'folders': [{'path': '~', 'match': ['projectb']}]}}}
            a = installer.seed_space({'id': 'a', 'name': 'Project A'}, {}, Path('/repo'), home, site)
            self.assertEqual([(p['label'], p['path']) for p in a['pins']], [('구조', str(home/'docs/ARCH.md'))])
            self.assertEqual(a['folders'], [str(home/'docs')])
            b = installer.seed_space({'id': 'b', 'name': 'Project B'}, {}, Path('/repo'), home, site)
            self.assertEqual((b['pins'][0]['kind'], b['pins'][0]['label']), ('latest', '개요'))
            self.assertEqual(b['folders'], [{'path': str(home), 'match': ['projectb']}])
            # Without the local file a project name seeds only its generic README fallback.
            self.assertEqual(installer.seed_space({'id': 'a', 'name': 'Project A'}, {}, Path('/repo'), home,
                                                  installer.site_config.DEFAULTS)['pins'], [])

    def test_dates_follow_latest_in_exact_directory_and_keep_disk_unicode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = '20261027_프로젝트비_전체구조_착수전_정리.md'.encode().decode()
            path = root/name
            path.write_text('# 구조')
            pin = installer.file_pin(path, '구조')
            self.assertEqual(pin['kind'], 'latest')
            self.assertEqual(pin['topic'], '프로젝트비_전체구조_착수전_정리.md')
            self.assertEqual(pin['root'], str(root))
            self.assertFalse(pin['recursive'])
            (root/'archive.md').write_text('# archive')
            self.assertIsNone(installer.file_pin(root/'archive.md'))
            self.assertIsNone(installer.file_pin(root/'missing.md'))

    def test_native_check_failure_prevents_feature_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)/'app'
            with patch.object(installer.subprocess, 'run', side_effect=RuntimeError('invalid mod')):
                with self.assertRaises(RuntimeError): installer.copy_feature(Path('/repo'), home)
            self.assertFalse(home.exists())

    def test_cas_retry_rereads_concurrent_document_and_reports_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home/'mods/project-docs-tabs').mkdir(parents=True)
            (home/'mods/project-docs-tabs/main.js').write_text('// checked')
            concurrent = copy.deepcopy(self.doc)
            concurrent['spaces'][0]['tabs'][0]['name'] = 'Renamed concurrently'
            attempts = []
            gets = iter([{'value': self.doc, 'version': 1}, {'value': self.doc, 'version': 1},
                         {'value': concurrent, 'version': 2}])
            def call(method, params):
                if method == 'doc.get': return next(gets)
                attempts.append(params)
                if len(attempts) == 1: raise RuntimeError('stale')
                return {'version': 3}
            focus = {'space': 'sp1', 'tab': 'work', 'focused_pane': 'p1'}
            with patch.object(sys, 'argv', ['install_doc_tabs.py', '--ensure-tabs', '--home', str(home)]), \
                 patch.object(installer, 'call', side_effect=call), patch.object(installer, 'status', return_value=focus), \
                 patch.object(installer.time, 'sleep'), patch('builtins.print') as output:
                installer.main()
            result = json.loads(output.call_args.args[0])
            self.assertTrue(result['focusUnchanged'])
            self.assertEqual(attempts[1]['version'], 2)
            self.assertEqual(attempts[1]['value']['spaces'][0]['tabs'][0]['name'], 'Renamed concurrently')
            self.assertFalse((home/'data/sixfold/project-docs.json').exists())


if __name__ == '__main__': unittest.main()
