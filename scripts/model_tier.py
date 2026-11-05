#!/usr/bin/env python3
"""Task difficulty tiers (low|mid|high) and the model each tier runs on (ADR-0008).

Rules shared by new workspaces, collaborate.py and route.py (the harness dispatch keeps
its own copy of the same rules):
  - no tier given → high; a review or check → always high
  - a session whose model is unknown counts as high
  - same tier first, then a higher one; never a lower one than asked
  - the tier → model map is machine-local: site.local.json "model_tiers"
    (missing tiers fall back to the next higher one; null turns a default tier off;
    high with no model = the CLI default)
"""
import json
import os
from pathlib import Path

import site_config

TIERS = ('low', 'mid', 'high')
# Codex models differ per account and plan, so Codex has no default below high.
DEFAULT_MODELS = {
    'claude': {'low': 'claude-haiku-5-5', 'mid': 'claude-sonnet-5-5', 'high': 'claude-opus-5-5'},
    'codex': {},
}
FLAGS = {'claude': '--model', 'codex': '-m'}


def family(agent):
    return 'claude' if agent in ('claude', 'claude-code') else agent


def tier_name(value):
    """A valid tier; None and '' mean high."""
    value = (value or 'high').strip().lower()
    if value not in TIERS:
        raise ValueError(f'tier는 {"|".join(TIERS)} 중 하나입니다: {value}')
    return value


def mapping(site=None):
    """tier → model per family: defaults overlaid with site.local.json model_tiers."""
    local = (site if site is not None else site_config.load()).get('model_tiers') or {}
    result = {}
    for name in set(DEFAULT_MODELS) | set(local):
        merged = {**DEFAULT_MODELS.get(name, {}), **(local.get(name) or {})}
        result[name] = {tier: model for tier, model in merged.items() if tier in TIERS and isinstance(model, str) and model}
    return result


def model_for(agent, tier, models=None):
    """(tier, model) actually used: the asked tier, else the next higher one that has a model.
    high always exists; its model may be None (the CLI's own default)."""
    table = (models if models is not None else mapping()).get(family(agent), {})
    for name in TIERS[TIERS.index(tier_name(tier)):]:
        if table.get(name):
            return name, table[name]
    return 'high', None


def flag(agent, model):
    """argv addition that selects the model: ['--model', id] for Claude, ['-m', id] for Codex."""
    return [FLAGS[family(agent)], model] if model and family(agent) in FLAGS else []


def tier_of(agent, model_id, models=None):
    """Tier of a running session's model; unknown or unmapped → high."""
    if not model_id:
        return 'high'
    table = (models if models is not None else mapping()).get(family(agent), {})
    for name in TIERS:
        if table.get(name) == model_id:
            return name
    return 'high'


def session_models(app_home=None):
    """address → model id, as the pane headers show it (agent-usage.shares in shared.json)."""
    home = Path(app_home or os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))
    try:
        shared = json.loads((home / 'shared.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    terminals = ((shared.get('agent-usage.shares') or {}).get('terminals') or {}) if isinstance(shared, dict) else {}
    return {address: (value.get('meta') or {}).get('modelId') for address, value in terminals.items()
            if isinstance(value, dict) and isinstance(value.get('meta'), dict)}


def rank(tier, session_tier):
    """Sort key for a candidate, or None when its model is lower than the task needs."""
    want, have = TIERS.index(tier_name(tier)), TIERS.index(session_tier)
    return None if have < want else have - want
