#!/usr/bin/env python3
"""Task difficulty tiers (low|mid|high|max) and the model + reasoning effort each runs on (ADR-0008).

Rules shared by new workspaces, collaborate.py and route.py (the harness dispatch keeps
its own copy of the same rules):
  - no tier given → high; a review or check → always high; max only when asked for by name
  - same tier first, then a higher one; never a lower one than asked; falling back stops at high
  - a session's tier comes from its model and effort; an unknown model counts as high
  - the tier → {model, effort} map has defaults here and is overridden per machine in
    site.local.json "model_tiers" (a bare string = a model at the CLI's effort; null turns a
    default tier off; high with no model = the CLI default)
"""
import json
import os
from pathlib import Path

import site_config

TIERS = ('low', 'mid', 'high', 'max')
LADDER_TOP = 'high'
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max', 'ultra')
# Models the CLIs list today. Claude high is left to the CLI default so an untiered pane opens as before.
DEFAULT_MODELS = {
    'claude': {'low': {'model': 'claude-haiku-5-5'}, 'mid': {'model': 'claude-sonnet-5-5', 'effort': 'medium'},
               'max': {'model': 'claude-opus-5-5', 'effort': 'xhigh'}},
    'codex': {'low': {'model': 'gpt-6-luna', 'effort': 'low'}, 'mid': {'model': 'gpt-6.1-sol', 'effort': 'medium'},
              'high': {'model': 'gpt-6.1-sol', 'effort': 'high'}, 'max': {'model': 'gpt-6-astra'}},
}


def family(agent):
    return 'claude' if agent in ('claude', 'claude-code') else agent


def tier_name(value):
    """A valid tier; None and '' mean high."""
    value = (value or 'high').strip().lower()
    if value not in TIERS:
        raise ValueError(f'tier는 {"|".join(TIERS)} 중 하나입니다: {value}')
    return value


def _entry(value):
    if isinstance(value, str) and value:
        return {'model': value, 'effort': None}
    if isinstance(value, dict) and isinstance(value.get('model'), str) and value['model']:
        return {'model': value['model'], 'effort': value.get('effort') if value.get('effort') in EFFORTS else None}
    return None


def mapping(site=None):
    """family → {tier: {'model', 'effort'}}: defaults overlaid with site.local.json model_tiers."""
    local = (site if site is not None else site_config.load()).get('model_tiers') or {}
    result = {}
    for name in set(DEFAULT_MODELS) | set(local):
        merged = {**DEFAULT_MODELS.get(name, {}), **(local.get(name) or {})}
        result[name] = {t: e for t, e in ((t, _entry(v)) for t, v in merged.items() if t in TIERS) if e}
    return result


def model_for(agent, tier, models=None):
    """(tier, entry) actually used: the asked tier, else the next higher one up to high that has a
    model. max is used only when asked. entry None = the CLI's own model and effort."""
    table = (models if models is not None else mapping()).get(family(agent), {})
    tier = tier_name(tier)
    top = TIERS.index('max' if tier == 'max' else LADDER_TOP)
    for name in TIERS[TIERS.index(tier):top + 1]:
        if table.get(name):
            return name, table[name]
    return 'high', None


def flags(agent, entry):
    """argv that selects model and effort: Claude `--model M --effort E`, Codex `-m M -c model_reasoning_effort=E`."""
    if not entry:
        return []
    model, effort = entry['model'], entry.get('effort')
    if family(agent) == 'claude':
        return ['--model', model] + (['--effort', effort] if effort else [])
    if family(agent) == 'codex':
        return ['-m', model] + (['-c', f'model_reasoning_effort={effort}'] if effort else [])
    return []


def tier_of(agent, session, models=None):
    """Tier of a running session from {'model', 'effort'} (or a bare model id).
    Unknown model → high; the highest tier on that model whose effort it meets; below all → one
    under the lowest; unknown effort reads as medium (the CLIs' default)."""
    model, effort = (session.get('model'), session.get('effort')) if isinstance(session, dict) else (session, None)
    table = (models if models is not None else mapping()).get(family(agent), {})
    on_model = [t for t in TIERS if model and (table.get(t) or {}).get('model') == model]
    if not on_model:
        return 'high'
    have = EFFORTS.index(effort if effort in EFFORTS else 'medium')
    met = [t for t in on_model if not table[t]['effort'] or have >= EFFORTS.index(table[t]['effort'])]
    return met[-1] if met else TIERS[max(0, TIERS.index(on_model[0]) - 1)]


def session_models(app_home=None):
    """address → {'model', 'effort'}, as the pane headers show it (agent-usage.shares in shared.json)."""
    home = Path(app_home or os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
    try:
        shared = json.loads((home / 'shared.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    terminals = ((shared.get('agent-usage.shares') or {}).get('terminals') or {}) if isinstance(shared, dict) else {}
    return {address: {'model': value['meta'].get('modelId'), 'effort': value['meta'].get('effort')}
            for address, value in terminals.items() if isinstance(value, dict) and isinstance(value.get('meta'), dict)}


def rank(tier, session_tier):
    """Sort key for a candidate, or None when its model is lower than the task needs."""
    want, have = TIERS.index(tier_name(tier)), TIERS.index(session_tier)
    return None if have < want else have - want
