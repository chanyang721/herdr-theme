import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('base_install', Path(__file__).parents[1]/'scripts/install.py')
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root/'repo'
        self.app = self.root/'app'
        for path, text in {
            'keys.json': json.dumps({'layout:sixfold': {'ctrl-x': 'original'}}),
            'mods/sixfold-desk/main.js': 'import {value} from "./model.js";',
            'mods/sixfold-desk/model.js': 'export const value=1;',
            'mods/sixfold-desk/jsconfig.json': 'generated, never install',
            'layouts/sixfold.json': '{"owned":1}',
            'themes/sixfold-night.json': '{"color":"original"}',
            'themes/win98.json': '{"reference":1}',
            **{f'scripts/{name}.py': '# helper\n' for name in ('workspace', 'core_api', 'balance_grid', 'collect_computers', 'route', 'collaborate', 'update_install',
                'file_lock', 'agent_env', 'site_config', 'desktop', 'install_doc_tabs', 'resolve_doc_pins', 'doc_catalog', 'collect_docs', 'open_doc_tab', 'render_mermaid', 'render_html')},
        }.items():
            p = self.repo/path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)

    def test_fresh_install_refuses_overwrite_before_mutating(self):
        install.install(self.repo, self.app)
        self.assertFalse((self.app/'mods/sixfold-desk/jsconfig.json').exists())
        with self.assertRaises(SystemExit):
            install.install(self.repo, self.app)
        self.assertEqual((self.app/'mods/sixfold-desk/model.js').read_text(), 'export const value=1;')

    def test_update_is_idempotent_and_preserves_personal_configuration(self):
        install.install(self.repo, self.app)
        custom = {
            'keys.json': '{"layout:sixfold":{"ctrl-x":"custom"},"global":{"cmd-p":"custom"}}',
            'settings.json': '{"zoom":2}',
            'data/sixfold/workspace-pins.local.json': '{"spaces":[{"id":"my-id"}]}',
            'layouts/sixfold.json': '{"custom-monitor":true}',
            'themes/sixfold-night.json': '{"personal-color":true}',
            'themes/win98.json': '{"personal-reference":true}',
            'mods/sixfold-desk/local-helper.js': 'custom helper',
        }
        for name, text in custom.items():
            p = self.app/name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        (self.repo/'mods/sixfold-desk/model.js').write_text('export const value=2;')
        (self.repo/'layouts/sixfold.json').write_text('{"new-layout":true}')
        for _ in range(2):
            install.install(self.repo, self.app, update=True)
        self.assertEqual((self.app/'mods/sixfold-desk/model.js').read_text(), 'export const value=2;')
        for name, text in custom.items():
            self.assertEqual((self.app/name).read_text(), text, name)

    def test_update_refreshes_unmodified_managed_layout(self):
        install.install(self.repo, self.app)
        (self.repo/'layouts/sixfold.json').write_text('{"new-layout":true}')
        install.install(self.repo, self.app, update=True)
        self.assertEqual((self.app/'layouts/sixfold.json').read_text(), '{"new-layout":true}')

    def test_update_legacy_install_preserves_existing_layout_without_manifest(self):
        (self.app/'layouts').mkdir(parents=True)
        (self.app/'layouts/sixfold.json').write_text('{"legacy-custom":true}')
        install.install(self.repo, self.app, update=True)
        self.assertEqual((self.app/'layouts/sixfold.json').read_text(), '{"legacy-custom":true}')
        self.assertTrue((self.app/'mods/sixfold-desk/main.js').exists())
