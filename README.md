# Herdr Theme

A compact Herdr layout for people who keep several coding agents visible at once.
Workspace navigation, agent attention, numbered panes and a clear input target share one calm frame.

![Herdr Theme](preview.png)

[한국어](README.ko.md)

## What it does

- Keeps the active tab's real split tree; six terminals work particularly well as a 3 × 2 grid.
- Shows every workspace and its agents together, independent of the selected workspace.
- Prioritizes blocked, done, working and idle agents within each workspace. Custom monochrome Claude/Codex icons gain color and move subtly while active; sidebar rows have no numbers.
- Reorders workspace headers by drag and drop using the app’s persisted space order.
- Shows incoming message counts live, without switching workspaces.
- Makes keyboard focus visible with a 2 px cyan border and an input-target footer.
- Keeps blockers and unseen completions visible; navigation is explicit, never triggered by a new status.
- Offers Korean/English labels and matching light/dark palettes.
- Keeps Files and Changes behind an optional panel instead of consuming terminal space by default.
- Optionally displays existing Herdr TUI terminals through a live bridge without restarting their agents.

The preview uses explicitly labelled demo programs. It contains no real projects, conversations or usage metrics.

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
| Cmd+Shift+R | Toggle the side panel |
| Cmd+R | Rename tab |
| Cmd+X | Close the app pane; a bridged TUI agent remains in its source server |
| Cmd+W / Cmd+Shift+W | Intentionally do nothing, to avoid accidental closure |

Non-macOS users can edit the layout-scoped fragment in `keys.json` to suit their keyboard.

## Equal grids and new workspaces

```sh
python3 scripts/balance_grid.py
python3 scripts/workspace.py "Example" /path/to/your/project --agents
```

`balance_grid.py` uses the core's version-checked document API. It changes six-terminal tabs to equal
rows and columns while retaining every existing pane ID and terminal address. It never restarts a program.
The workspace helper starts four Claude and two Codex sessions when `--agents` is requested.
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
only sender, recipient and time to a local bounded log (32 events); message text is never stored.
Herdr Theme connects the actual sender and recipient rows with an elbow pipe, moves a dot along it, highlights its endpoints,
and shows unread counters until the target is focused. Motion can be disabled in the toolbar.
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

Incoming message badges reconcile every 500 ms without changing workspace or focus; unchanged snapshots do not redraw. See [COMMON_ROUTING.md](COMMON_ROUTING.md) for Common-to-project slot routing, protected composers and idle fallback. Run `python3 scripts/route.py --enable` to connect this checkout to the sidebar queue drain. The optional common alerts section reads `data/sixfold/alerts.json`; its collector is separate.

Subagents expand under their parent agent with `▸ N`; parents without children remain visible. New observed delegations expand the corresponding tree and animate a native Bezier pipeline. Counts remain on agent rows, not workspace headers. `scripts/collect_workflow.py` reads Claude metadata, the read-only Codex database and hc parent links to publish `data/sixfold/workflow.json`. It supports `--once`; otherwise it reconciles every three seconds, writing only changes. Estimated activity is labelled. Startup history does not animate, and persistent collector registration is separate.
