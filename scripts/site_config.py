#!/usr/bin/env python3
"""Machine-local names, paths and IDs that stay out of the public repository.

The values live in ``$HERDR_APP_HOME/data/sixfold/site.local.json`` (default
``~/.config/herdr-app/data/sixfold/site.local.json``); the repository only ships
``config/site.example.json``. Missing keys fall back to the generic defaults
below, so a fresh clone works without any local file.
"""
import json
import os
from pathlib import Path

FILE = 'site.local.json'
DEFAULTS = {
    # launchd labels are '<label_prefix>.<job>'.
    'label_prefix': 'local.herdr-sixfold',
    # Observer state, task files and logs outside Herdr's own data folder.
    'state_dir': '~/Library/Application Support/HerdrSixfold',
    # Reports written by agents (workspace records, reply drafts).
    'reports_dir': '~/Documents/HerdrReports',
    # Per-space link folders made by the project document collector.
    'projects_dir': '~/Documents/HerdrProjects',
    # Space IDs treated as the shared hub besides the names share/공통/common.
    'hub_space_ids': [],
    # Spoken or short project names mapped to a workspace name (casefolded).
    'project_aliases': {},
    # Workspaces seeded as pinned and never closed by the cleanup observer.
    'fixed_space_names': ['Share'],
    # Workspace name -> {sources, topics, folders} for the 문서 tab seed.
    'doc_tabs': {},
}
HUB_NAMES = ('share', '공통', 'common')


def app_home(home=None, app=None):
    if app is not None:
        return Path(app)
    if home is not None:
        return Path(home) / '.config/herdr-app'
    return Path(os.environ.get('HERDR_APP_HOME', Path.home() / '.config/herdr-app'))


def path(home=None, app=None):
    return app_home(home, app) / 'data/sixfold' / FILE


def load(home=None, app=None):
    """Defaults overlaid with the local file; a broken file is ignored, not fatal."""
    try:
        value = json.loads(path(home, app).read_text())
    except (OSError, ValueError):
        value = {}
    return {**DEFAULTS, **(value if isinstance(value, dict) else {})}


def expand(value, home=None):
    text = str(value)
    if text == '~' or text.startswith('~/'):
        return Path(home or Path.home()) / text[2:]
    return Path(text)


def folder(key, home=None, config=None):
    return expand((config or load(home))[key], home)


def label(job, home=None, config=None):
    return f"{(config or load(home))['label_prefix']}.{job}"


def is_hub(space, config=None):
    config = config or load()
    return space.get('id') in config.get('hub_space_ids', []) or \
        str(space.get('name', '')).casefold() in HUB_NAMES
