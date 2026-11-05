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

LOCAL = model_tier.mapping({})


class TierRules(unittest.TestCase):
    def test_no_tier_is_high_and_bad_tiers_are_refused(self):
        self.assertEqual(model_tier.tier_name(None), 'high')
        self.assertEqual(model_tier.tier_name(' MID '), 'mid')
        with self.assertRaises(ValueError):
            model_tier.tier_name('medium')

    def test_mapping_is_local_and_missing_tiers_move_up(self):
        site = {'model_tiers': {'codex': {'high': 'gpt-x', 'mid': None, 'low': None}, 'claude': {'low': None}}}
        table = model_tier.mapping(site)
        self.assertEqual(model_tier.model_for('codex', 'low', table), ('high', {'model': 'gpt-x', 'effort': None}))
        self.assertEqual(model_tier.model_for('claude', 'low', table)[0], 'mid',
                         'null turns a tier off locally: its tasks move one step up')
        self.assertEqual(model_tier.model_for('claude', 'high', table), ('high', None), 'Claude high = the CLI default')

    def test_defaults_name_real_models_efforts_and_max_is_only_chosen(self):
        self.assertEqual(model_tier.model_for('codex', 'low'), ('low', {'model': 'gpt-6-luna', 'effort': 'low'}))
        self.assertEqual(model_tier.model_for('codex', 'high'), ('high', {'model': 'gpt-6.1-sol', 'effort': 'high'}))
        self.assertEqual(model_tier.model_for('codex', 'max')[1]['model'], 'gpt-6-astra')
        self.assertEqual(model_tier.model_for('claude', 'high', {'claude': {'max': {'model': 'm', 'effort': None}}}),
                         ('high', None), 'falling back never climbs into max')

    def test_flags_per_cli(self):
        self.assertEqual(model_tier.flags('claude-code', {'model': 'claude-sonnet-5-5', 'effort': 'medium'}),
                         ['--model', 'claude-sonnet-5-5', '--effort', 'medium'])
        self.assertEqual(model_tier.flags('codex', {'model': 'gpt-6-luna', 'effort': 'low'}),
                         ['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low'])
        self.assertEqual(model_tier.flags('claude', None), [])

    def test_session_tier_from_model_and_effort_unknown_is_high_lower_never_chosen(self):
        self.assertEqual(model_tier.tier_of('claude', None, LOCAL), 'high')
        self.assertEqual(model_tier.tier_of('claude', {'model': 'claude-opus-5-5', 'effort': 'medium'}, LOCAL), 'high')
        self.assertEqual(model_tier.tier_of('claude', 'claude-haiku-5-5', LOCAL), 'low')
        self.assertEqual(model_tier.tier_of('codex', {'model': 'gpt-6.1-sol', 'effort': 'medium'}, LOCAL), 'mid')
        self.assertEqual(model_tier.tier_of('codex', {'model': 'gpt-6.1-sol', 'effort': 'high'}, LOCAL), 'high')
        self.assertEqual(model_tier.tier_of('codex', {'model': 'gpt-6-astra', 'effort': 'medium'}, LOCAL), 'max')
        self.assertIsNone(model_tier.rank('high', 'mid'))
        self.assertEqual([model_tier.rank('mid', t) for t in ('mid', 'high')], [0, 1])

    def test_session_models_read_the_pane_header_share(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, 'shared.json').write_text(json.dumps({'agent-usage.shares': {'terminals': {
                't1': {'meta': {'agent': 'claude', 'modelId': 'claude-sonnet-5-5', 'effort': 'medium'}}, 't2': {}}}}))
            self.assertEqual(model_tier.session_models(home), {'t1': {'model': 'claude-sonnet-5-5', 'effort': 'medium'}})
            self.assertEqual(model_tier.session_models(Path(home) / 'missing'), {})


class NewWorkspace(unittest.TestCase):
    def launches(self, site, extra=()):
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

        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        with patch.object(sys, 'argv', ['workspace.py', 'Example', '/project', *extra]), \
                patch.dict(workspace.os.environ, {'HERDR_APP_HOME': self.home.name, 'HC_TERMINAL_ID': 't9'}), \
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
        panes = self.launches({'new_space_tiers': ['high', 'mid', 'high', 'high', 'low', 'mid']})
        self.assertNotIn('--model', panes[0], 'Claude high = the CLI default: no model flag')
        self.assertEqual(panes[1][-4:], ['--model', 'claude-sonnet-5-5', '--effort', 'medium'])
        self.assertEqual(panes[4][-2:], ['--model', 'claude-haiku-5-5'])
        self.assertEqual(panes[5][-4:], ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium'])
        self.assertIn('env', panes[1][0], 'agent markers are still removed')

    def test_tiers_argument_wins_and_the_plan_is_recorded_with_who_decided(self):
        panes = self.launches({'new_space_tiers': ['high'] * 6}, ['--tiers', 'low,mid,max,high,high,low'])
        self.assertEqual(panes[2][-2:], ['-m', 'gpt-6-astra'])
        self.assertEqual(panes[0][-2:], ['--model', 'claude-haiku-5-5'])
        book = json.loads(Path(self.home.name, 'data/sixfold/space-tiers.json').read_text(encoding='utf-8'))
        plan = book['space']
        self.assertEqual(plan['by'], 't9')
        self.assertEqual([p['tier'] for p in plan['panes']], ['low', 'mid', 'max', 'high', 'high', 'low'])
        self.assertEqual(plan['panes'][2]['model'], 'gpt-6-astra')

    def test_a_malformed_option_is_refused_before_any_pane_opens(self):
        with self.assertRaises(SystemExit):
            workspace.pane_plan({'new_space_tiers': ['high'] * 5})
        with self.assertRaises(SystemExit):
            workspace.pane_plan({}, 'low,mid,high,high,low,ultra')


class Receivers(unittest.TestCase):
    def test_collaborate_orders_same_model_then_higher_and_skips_lower(self):
        facts = {a: {'agent': 'claude'} for a in ('a', 'b', 'c', 'd')}
        models = {'a': {'model': 'claude-haiku-5-5'}, 'b': {'model': 'claude-opus-5-5', 'effort': 'medium'},
                  'c': {'model': 'claude-sonnet-5-5', 'effort': 'medium'}}
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
            models = {'p0': {'model': 'claude-sonnet-5-5', 'effort': 'medium'}, 'p2': {'model': 'claude-haiku-5-5'}}
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B', 'mid', models, LOCAL)[2], ['p0', 'p1'])
            self.assertEqual(route.candidates(spaces, live, 's2', 'Project B', 'high', models, LOCAL)[2], ['p1'])


if __name__ == '__main__':
    unittest.main()
