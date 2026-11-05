"""Task tiers pick models for new panes and receivers; temporary data only (ADR-0008)."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import model_tier  # noqa: E402
import workspace  # noqa: E402

spec = importlib.util.spec_from_file_location('route_tier', Path(__file__).parents[1] / 'scripts/route.py')
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)
import collaborate  # noqa: E402

LOCAL = {'claude': {'low': 'claude-haiku-5-5', 'mid': 'claude-sonnet-5-5', 'high': 'claude-opus-5-5'}, 'codex': {}}


class TierRules(unittest.TestCase):
    def test_no_tier_is_high_and_bad_tiers_are_refused(self):
        self.assertEqual(model_tier.tier_name(None), 'high')
        self.assertEqual(model_tier.tier_name(' MID '), 'mid')
        with self.assertRaises(ValueError):
            model_tier.tier_name('medium')

    def test_mapping_is_local_and_missing_tiers_move_up(self):
        site = {'model_tiers': {'codex': {'high': 'gpt-x', 'mid': ''}, 'claude': {'low': None}}}
        table = model_tier.mapping(site)
        self.assertEqual(model_tier.model_for('codex', 'low', table), ('high', 'gpt-x'))
        self.assertEqual(model_tier.model_for('claude', 'low', table), ('mid', 'claude-sonnet-5-5'),
                         'null turns a tier off locally: its tasks move one step up')
        self.assertEqual(model_tier.model_for('codex', 'mid', model_tier.mapping({})), ('high', None),
                         'no Codex model below high: the CLI default')

    def test_flags_per_cli(self):
        self.assertEqual(model_tier.flag('claude-code', 'claude-sonnet-5-5'), ['--model', 'claude-sonnet-5-5'])
        self.assertEqual(model_tier.flag('codex', 'gpt-x'), ['-m', 'gpt-x'])
        self.assertEqual(model_tier.flag('claude', None), [])

    def test_unknown_model_is_high_and_lower_models_are_never_chosen(self):
        self.assertEqual(model_tier.tier_of('claude', None, LOCAL), 'high')
        self.assertEqual(model_tier.tier_of('claude', 'claude-something-new', LOCAL), 'high')
        self.assertEqual(model_tier.tier_of('claude', 'claude-haiku-5-5', LOCAL), 'low')
        self.assertIsNone(model_tier.rank('high', 'mid'))
        self.assertEqual([model_tier.rank('mid', t) for t in ('mid', 'high')], [0, 1])

    def test_session_models_read_the_pane_header_share(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, 'shared.json').write_text(json.dumps({'agent-usage.shares': {'terminals': {
                't1': {'meta': {'agent': 'claude', 'modelId': 'claude-sonnet-5-5'}}, 't2': {}}}}))
            self.assertEqual(model_tier.session_models(home), {'t1': 'claude-sonnet-5-5'})
            self.assertEqual(model_tier.session_models(Path(home) / 'missing'), {})


class NewWorkspace(unittest.TestCase):
    def launches(self, site):
        launches, cells = [], []
        tab = {'id': 'tab', 'name': 'Development', 'root': {'id': 'root', 'type': 'row', 'children': cells}}
        document = {'spaces': [{'id': 'space', 'name': 'Example', 'tabs': [tab]}]}

        def app(command, args):
            if command == 'space.rename':
                return {}
            launches.append((command, args))
            n = len(launches)
            cells.append({'id': f'p{n}', 'type': 'block', 'content': {'terminal': f't{n}'}})
            return {'terminal': f't{n}', 'pane': f'p{n}', 'space': 'space', 'tab': 'tab'}

        def listing(*_args, **_kwargs):
            if not launches:
                return json.dumps({'spaces': []}).encode()
            return json.dumps({'spaces': [{'id': 'space', 'name': 'Example', 'tabs': [
                {'id': 'tab', 'terminals': [{'terminal': 't1', 'pane': 'p1'}]}]}]}).encode()

        with patch.object(sys, 'argv', ['workspace.py', 'Example', '/project']), \
                patch.object(workspace, 'app', side_effect=app), \
                patch.object(workspace.subprocess, 'check_output', side_effect=listing), \
                patch.object(workspace.subprocess, 'run'), \
                patch.object(workspace, 'call', side_effect=lambda m, a: {'value': document, 'version': 1} if m == 'doc.get' else {}), \
                patch.object(workspace.site_config, 'load', return_value=site), \
                patch.object(model_tier.site_config, 'load', return_value=site), \
                contextlib.redirect_stdout(io.StringIO()):
            workspace.main()
        # Launch order: first, bottom, top2, top3, bottom2, bottom3 → back to pane order.
        argv = [args['argv'] for _, args in launches]
        return [argv[i] for i in (0, 2, 3, 1, 4, 5)]

    def test_without_the_option_every_pane_starts_as_before(self):
        from agent_env import launch_argv
        panes = self.launches({})
        self.assertEqual(panes, [launch_argv(['claude'])] * 2 + [launch_argv(['codex', '--no-daemon'])]
                         + [launch_argv(['claude'])] * 2 + [launch_argv(['codex', '--no-daemon'])])

    def test_new_space_tiers_open_lighter_models_in_the_named_panes(self):
        panes = self.launches({'new_space_tiers': ['high', 'mid', 'high', 'high', 'low', 'mid'],
                               'model_tiers': {'codex': {'high': 'gpt-x'}}})
        self.assertEqual(panes[0][-2:], ['--model', 'claude-opus-5-5'])
        self.assertEqual(panes[1][-2:], ['--model', 'claude-sonnet-5-5'])
        self.assertEqual(panes[4][-2:], ['--model', 'claude-haiku-5-5'])
        self.assertEqual(panes[5][-2:], ['-m', 'gpt-x'], 'Codex mid has no model here: one step higher')
        self.assertIn('env', panes[1][0], 'agent markers are still removed')

    def test_a_malformed_option_is_refused_before_any_pane_opens(self):
        with self.assertRaises(SystemExit):
            workspace.pane_plan({'new_space_tiers': ['high'] * 5})


class Receivers(unittest.TestCase):
    def test_collaborate_orders_same_model_then_higher_and_skips_lower(self):
        facts = {a: {'agent': 'claude'} for a in ('a', 'b', 'c', 'd')}
        models = {'a': 'claude-haiku-5-5', 'b': 'claude-opus-5-5', 'c': 'claude-sonnet-5-5'}
        self.assertEqual(collaborate.tier_order(['a', 'b', 'c', 'd'], 'mid', facts, models, LOCAL), ['c', 'b', 'd'])
        self.assertEqual(collaborate.tier_order(['a', 'b', 'c', 'd'], None, facts, models, LOCAL), ['b', 'd'],
                         'no tier = high: unknown (d) counts as high')
        self.assertEqual(collaborate.tier_order(['a', 'b'], 'low', facts, models, LOCAL), ['a', 'b'])

    def test_route_keeps_its_old_order_without_a_tier_and_never_goes_lower(self):
        spaces = [
            {'id': 'common', 'name': '공통', 'folder': '/common', 'tabs': [{'active': True, 'terminals': [
                {'terminal': 's0'}, {'terminal': 's1'}, {'terminal': 's2'}]}]},
            {'id': 'project', 'name': 'Project B', 'folder': '/project-b', 'tabs': [{'active': True, 'terminals': [
                {'terminal': 'p0'}, {'terminal': 'p1'}, {'terminal': 'p2'}]}]}]
        live = [{'address': a, 'agent': 'claude', 'state': 'live', 'status': s}
                for a, s in [('s2', 'working'), ('p0', 'idle'), ('p1', 'idle'), ('p2', 'idle')]]
        site = {**route.site_config.DEFAULTS, 'hub_space_ids': ['common']}
        with patch.object(route.site_config, 'load', return_value=site):
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B')[2], ['p2', 'p1', 'p0'])
            models = {'p0': 'claude-sonnet-5-5', 'p2': 'claude-haiku-5-5'}
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B', 'mid', models, LOCAL)[2], ['p0', 'p1'])
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B', 'high', models, LOCAL)[2], ['p1'])


if __name__ == '__main__':
    unittest.main()
