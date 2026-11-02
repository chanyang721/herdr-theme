# Herdr Theme

Coordinate coding agents across projects from one live sidebar. See every workspace and agent, follow concurrent messages, and expand subagent trees while keeping your current terminal in view.

![Herdr Theme](preview.png)

[한국어](README.ko.md)

## What it does

| Feature | Benefit |
| --- | --- |
| Every workspace and agent in one sidebar | Track several projects without hunting through tabs. |
| Live status and per-agent unread messages | See which agent is working, waiting or needs your decision. |
| Concurrent animated message routes | Follow real successful sends, including several agents and repeated messages on one route. |
| Expandable subagent trees | See delegation relationships and status provenance; estimated activity is labelled. |
| Project icons, colors and group borders | Recognize each project's agents at a glance. |
| Focus that stays yours | Messages and status changes keep your current input target in place. |

Message tracing and subagent collection are optional local integrations described below. The layout also provides Korean/English labels, light/dark palettes, keyboard navigation and drag ordering. It preserves the active tab's existing split tree; the default six-pane arrangement is one way to use it.

The public preview uses labelled demo programs, not real projects, conversations or usage metrics.

## Install

Requires Herdr app 0.1.11 or newer and Python 3.

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
herdr-app do layout.switch --name sixfold
```

The installer refuses to replace existing Herdr Theme files or an existing `layout:sixfold` key section.
It preserves all other layouts, settings and key bindings. Switch back with the layout picker.
To update an existing installation, review the Git diff and copy only this repository's installed files;
`scripts/install.py` is deliberately an initial installer, not an overwriting updater.

## Keys

These bindings apply only while Herdr Theme is selected. Other native Herdr bindings stay available.

| Key (macOS) | Action |
| --- | --- |
| Cmd+[ / Cmd+] | Previous / next pane in the current tab |
| Cmd+Option+1…6 | Focus a numbered pane |
| Ctrl+Shift+arrows | Focus a neighbour |
| Cmd+Shift+Enter | Zoom the focused pane |
| Cmd+Shift+J / U | Next blocked / completed agent |
| Cmd+R | Rename tab |
| Cmd+X | Close the app pane; a bridged TUI agent remains in its source server |
| Cmd+W / Cmd+Shift+W | Intentionally do nothing, to avoid accidental closure |

Non-macOS users can edit the layout-scoped fragment in `keys.json` to suit their keyboard.

## Equal grids and new workspaces

```sh
python3 scripts/balance_grid.py
python3 scripts/workspace.py "Example" /path/to/your/project
```

`balance_grid.py` uses the core's version-checked document API. It changes six-terminal tabs to equal
rows and columns while retaining every existing pane ID and terminal address. It never restarts a program.
The sidebar's **+ Space** and **Ctrl+Shift+N** open a name/folder dialog and create one tab with a 3×2 split: four Claude and two Codex sessions. Both CLIs and Python 3 must be installed. The workspace helper uses the same default; pass `--shells` for six plain shells (`--agents` remains compatible).

For an existing installation, update `mods/sixfold-new-space`, `mods/sixfold-desk/main.js`, and the theme key bindings together. Copy `scripts/workspace.py`, `scripts/core_api.py`, and `scripts/balance_grid.py` to `~/.config/herdr-app/scripts/sixfold/`. The installer places these files there for new installations. Other layouts and explicit `space.new` commands retain Herdr's own behavior.
Agent authentication and workspace trust use the agents' own interfaces.

## Optional live TUI bridge (macOS/Linux)

Herdr TUI and Herdr app have separate runtimes. A bridge is a live attachment, not a native import:
the source TUI server must keep running. Its existing agent process, conversation, permissions and
voice connection stay where they are.

Inside an available app terminal:

```sh
python3 /path/to/herdr-theme/scripts/tui_bridge.py --session default --pane YOUR_SOURCE_PANE
```

The bridge reports source status once per second, forwards input and resize, and uses a per-source lock.
It never sends an agent prompt. Closing the attachment leaves the source agent alive.
Microphone routing and automatic dictation submission are separate integrations, not features guaranteed
by a color theme. No microphone permission is granted by installing Herdr Theme.

## Optional message flow

```sh
python3 scripts/install_trace.py
# Add the printed PATH export to your shell startup file, then start a new shell.
```

The optional `hc` launcher forwards commands to `herdr-core`. Successful `hc send` calls append
only sender, recipient and time to a local bounded log (1024 events); message text is never stored.
Herdr Theme connects actual sender and recipient rows with native Bezier curves, animates each message independently, highlights its endpoints,
and shows unread counters until the target finishes working or is focused. Read positions are kept in `data/sixfold/messages-read.json`, so a restart does not recount the log. Motion can be disabled in the toolbar.
Native senders use `HC_TERMINAL_ID`; bridging older TUI senders requires your own private
`~/.local/state/herdr-sixfold/migration-map.local.json` mapping. Keep that file out of Git.
`python3 scripts/install_trace.py --default-launcher` also routes the known `~/.local/bin/hc` core
symlink through this observer, so existing shells do not need a PATH refresh. Unknown launchers
are left untouched. Direct RPC calls bypassing the launcher are not observed.
Up to four colored routes animate concurrently, each making one trip and then stopping. Recent
routes retain directional counts, and their replay control never re-sends a message. Per-row Ping
buttons and the duplicate attention panel are removed. The animation reports a successful send,
not a read receipt; inspect the agent’s actual reply for PONG. It never forces a blocked prompt.

## Optional app voice routing

With an app-compatible `herdr-focus-queue` checkout already installed:

```sh
python3 scripts/install_voice.py /path/to/herdr-focus-queue
```

This opt-in integration publishes the active app pane to a local heartbeat. The voice plugin then
routes microphones to that pane, including existing TUI attachments and native core sessions.
Background app windows do not override TUI focus. The existing speech-end submission rules remain
in the voice plugin; the theme grants no microphone permission or authentication. Existing Codex
voice connections are muted/unmuted, never toggled off. Native Codex starts voice only from an observed
empty CLI without a current connection. Remove `data/sixfold/voice-integration.json` under app home to
stop the integration; that does not disconnect a voice conversation.

## What it runs

The UI uses Herdr's live workspace/agent APIs and navigation commands, with no network requests.
The optional bridge runs the installed `herdr` CLI. Helpers use `hc` / `herdr-app` locally.
No private configuration, account data or session mapping belongs in this repository.

## Development

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
node --check mods/sixfold-desk/main.js
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

Model tests are not a native UI test. Verify a changed layout with `herdr-app status` and an actual screenshot.
See [RECIPE.md](RECIPE.md) for the reproducible design brief. Apache-2.0.

Incoming message badges reconcile every 250 ms without changing workspace or focus; unchanged snapshots do not redraw. See [COMMON_ROUTING.md](COMMON_ROUTING.md) for Common-to-project slot routing, protected composers and idle fallback. Run `python3 scripts/route.py --enable` to connect this checkout to the sidebar queue drain. The optional common alerts section reads `data/sixfold/alerts.json`; its collector is separate.

Subagents expand under their parent agent with `▸ N`; parents without children remain visible. New observed delegations expand the corresponding tree and animate a native Bezier pipeline. Counts remain on agent rows, not workspace headers. `scripts/collect_workflow.py` reads Claude metadata, the read-only Codex database and hc parent links to publish `data/sixfold/workflow.json`. It supports `--once`; otherwise it reconciles every three seconds, writing only changes. Estimated activity is labelled. Startup history does not animate, and persistent collector registration is separate.

Set a local project icon with `python3 scripts/set_workspace_icon.py 'workspace ID or exact name' /path/to/icon.png`. SVG, PNG, JPEG and WebP are supported, with optional `--background '#ffffff'` and `--tint` for monochrome SVGs. Assets are copied under local `data/sixfold/icons/`, mapped in `workspace-icons.json`, and refreshed without a theme restart. Customer logos are not bundled in the public repository.

## Optional document and usage tools

Separate mod recipes let you place document and usage tools in a personal layout. [Project Document Viewer](extras/preview/README.md) adds saved-file Markdown preview and local HTML snapshots. [System Metrics](extras/system-metrics/RECIPE.md) adds a separate CPU/memory strip. Token history is available from [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights); subscription quotas come from [Usage Bar](https://github.com/berkeatac/herdr-usage-bar). These are optional, separate installs; account quotas are not per-agent token totals.

Independent mod releases: [System Metrics](https://github.com/chanyang721/herdr-workspace-mods/tree/main/system-metrics) · [Project Document Viewer](https://github.com/chanyang721/herdr-workspace-mods/tree/main/document-viewer).

Project document tracking: see [configuration and collector](docs/project-documents.md). The base theme uses full-width terminals; configured latest documents live in the left sidebar.
