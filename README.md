# Herdr Theme

Coordinate coding agents across projects from one live sidebar. See every workspace and agent, follow concurrent messages, and expand subagent trees while keeping your current terminal in view.

![Herdr Theme](preview.png)

[한국어](README.ko.md)

## What it does

| Feature | Benefit |
| --- | --- |
| Computer selector with independent workspace lists | Pick a computer, then see its projects and agents. |
| Live status and per-agent unread messages | See which agent is working, waiting or needs your decision. |
| Concurrent animated message routes | Follow real successful sends, including several agents and repeated messages on one route. |
| Expandable subagent trees | See delegation relationships and status provenance; estimated activity is labelled. |
| Project icons, colors and group borders | Recognize each project's agents at a glance. |
| Focus that stays yours | Messages and status changes keep your current input target in place. |

Native message events and optional subagent collection are described below. The layout also provides Korean/English labels, light/dark palettes, keyboard navigation and drag ordering. It preserves the active tab's existing split tree; the default six-pane arrangement is one way to use it.

The public preview uses labelled demo programs, not real projects, conversations or usage metrics.

## Install

Requires Herdr app 0.1.11 or newer and Python 3.

The synchronized `sixfold` layout includes the installed monitor strip. Install its external
`system-metrics`, `agent-usage`, and `usage-bar` dependencies separately before selecting it;
see [monitor layout requirements](extras/monitor-layout/README.md). These external mod versions
are not pinned or installed by this repository.

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
herdr-app do layout.switch --name sixfold
```

The installer refuses to replace existing Herdr Theme files or an existing `layout:sixfold` key section.
It preserves all other layouts, settings and key bindings. Switch back with the layout picker.
`scripts/install.py` is only the initial installer. **For every subsequent installation, use only
`scripts/update_install.py`; never copy or rsync files into the running app by hand.** Review the diff
and explicitly list the files to install:

```sh
python3 scripts/update_install.py mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

The updater locks `data/sixfold/install.lock`, builds complete affected mod trees outside `mods/`, runs
native checks, keeps full backups under `backups/sixfold-update-*/`, then atomically exchanges each
mod directory. Unlisted installed files stay in the candidate tree. Identical contents and modes are skipped to avoid unnecessary reloads. It requires macOS directory swap
or Linux `renameat2` exchange. Windows has no directory swap, so there the updater moves the installed mod aside, moves the checked candidate in and puts the old tree in the stage folder: the mod path is missing for that moment, and a failed move puts the installed tree back. There is no partial-file fallback for mods. Layout/theme files explicitly
listed are atomically replaced individually. Repository `scripts/<file>` installs into `scripts/sixfold/<file>`
to match the initial installer; scripts are also replaced individually. It verifies `status.errors` stays empty for one second
and that space, tab and focused pane are unchanged. Failed checks do not install; failed verification
rolls back automatically. A later concurrent writer is preserved and reported as a rollback conflict.
The receipt records before/after status, checksums and rollback results. No theme settings, tabs,
terminal processes or app lifecycle commands are changed. A clean status is not a visual check: also
inspect a native `herdr-app shot` after installation.

Use a separate git worktree and branch per editing session. Only one designated session installs a
reviewed candidate; all installers must honor the same lock. **Never duplicate an installed mod into
`mods/*-recovery` or change layouts to point to a recovery clone.** Restore through the updater and
keep backups outside `mods/`. For an authorized repair of an already broken app,
`--allow-unhealthy-before` permits the initial errors; final errors must still become zero.
`--verify-timeout 30` gives hot reload more time without restarting the app. The updater never quits
or restarts Herdr or herdr-core; any necessary restart needs its own session-preservation verification.
To install the updater itself, select `scripts/update_install.py` (destination `scripts/sixfold/update_install.py`).
When running that installed copy, pass `--repo /path/to/reviewed-worktree`.
This policy covers all updates to existing UI mod/layout code. Legacy `install_doc_tabs.py` and
`install_preview.py` are feature provisioning tools, not alternate live-update paths: do not run them
against the live app while the installation owner is deploying; prepare/review their assets separately
and send existing mod/layout code updates through the updater.

The manual macOS native regression probe runs in its own app/core home:

```sh
python3 tests/native_ui_reload.py --reloads 80 --install-smoke
```

It saves four synthetic theme shots, a missing-export/restore case, reload stress results,
and two real directory-swap updates. Review the shots as well as its JSON receipt.

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

For an existing installation, use `scripts/update_install.py` to install the reviewed files from `mods/sixfold-new-space`, `mods/sixfold-desk/main.js`, and `scripts/{workspace,core_api,balance_grid}.py` together. Script destinations match `~/.config/herdr-app/scripts/sixfold/`. The updater deliberately refuses `keys.json`; review any key migration separately without replacing other bindings. Other layouts and explicit `space.new` commands retain Herdr's own behavior.
Agent authentication and workspace trust use the agents' own interfaces.

## Computers and remote agents

The sidebar lists this computer and persistent `hc machine` connections. Selecting a computer shows
only its workspaces and agents, including attention counts and next-blocked/next-done navigation.
Switching back returns to its last selected workspace. A computer with no workspaces opens the
new-workspace dialog; an unavailable one opens machine settings. Existing processes stay running.

**+ Space** and **Ctrl+Shift+N** target the selected computer. Local workspaces retain the six-agent
default. Remote workspaces start with one terminal on that computer; an empty folder uses its home.
The folder picker is local only. Run authenticated agent CLIs inside remote terminals as needed.
Remote selection and creation require Herdr app/core with machine-layout support (verified on 0.1.17).

Local and connected/connecting Herdr computers are the only rows shown by default.
Click a row to view that computer's workspaces. Disconnected remotes and unregistered
Tailscale peers are completely hidden while collapsed, including icons and counts.
A small arrow beside **COMPUTERS** expands their list, capped at 180 units high.
Tailscale online alone does not verify Herdr access, so unregistered peers stay hidden.
Selecting a computer or toggling the list does not move terminal focus or initiate a connection.

From the main computer, `hc send worker/t7 "your message"` sends to that computer's terminal;
use its actual qualified address from `hc ls`. Selecting an agent's row lets you type directly.
`hc send --wait` can observe the agent's next turn, but a successful send alone is not a read receipt.
The connection must be reachable, and the agent must already be running and authenticated.
This theme does not configure SSH, Tailscale, firewall rules or agent credentials.

Optional friendly names and default folders live only in
`~/.config/herdr-app/data/sixfold/computers.local.json`:

```json
{
  "local": { "label": "Home" },
  "machines": {
    "worker": { "label": "Build computer", "folder": "/home/user/projects" }
  }
}
```

Machine keys match `hc machine ls`. Without this file, native machine names are shown. Labels reload
live; the optional folder applies to new workspaces. Keep private addresses, paths and credentials
out of Git. For an existing installation, update both `mods/sixfold-desk/main.js` and
`mods/sixfold-new-space/main.js` together through `scripts/update_install.py`, which checks both candidate mods.

For discovery without a remote connection, set `"tailscale": true` in that same local JSON object.
Use `scripts/update_install.py scripts/collect_computers.py mods/sixfold-desk/main.js`; the helper installs
under `~/.config/herdr-app/scripts/sixfold/`. Every 15 seconds the sidebar reads **local** `tailscale status --json`;
Windows, macOS and Linux peers appear with their Tailscale DNS hostname and online flag.
These passive rows cannot open shells or workspaces. “Tailscale Online” is the local status report,
not proof that SSH or Herdr is reachable. Failed reads mark retained peers unknown.
Disabling the option hides the discovery rows. No ACL changes, peer probes or remote installs occur.

Native remote work requires a noninteractive SSH connection (or a byte-preserving `--via` command)
and a compatible `hc` on the target; `hc machine add --help` documents `--install` for copying it.
Machine registration initiates a connection, so do it only after remote access is authorized.
For a Windows target, enable OpenSSH Server, start `sshd`, configure key authentication and an
inbound TCP 22 firewall rule scoped to the Mac's Tailscale IP (or the intended Tailscale range).
Review any broader default OpenSSH firewall rule. Install compatible Windows herdr-core on PATH
and verify its availability before registering with `hc machine add user@TAILSCALE_IP --name HOST`.
The theme does not enable these services or authenticate on the target's behalf.

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

## Message flow

There is no permanent message-history panel. The original pipeline appearance, speed and
recent-route rendering are restored. New sends show a sender → recipient notice for about four seconds.
Colors and lanes separate concurrent routes; repeated sends retain individual packets and
show a grouped count. The notice shows at most two routes and an overflow count. Unresolved
queued/error/held deliveries remain in a compact status row with full tooltip details.
Motion off disables travel. Further changes to the panel/temporary notice await user confirmation.

With a Herdr app exposing `messageEvents()` and a core emitting `message_sent`,
the sidebar reads successful sends from the app's bounded in-memory event list.
Direct `hc send` and RPC sends use the same path; no Python launcher or per-message
log write is needed. Events include sender, recipient, time and the observed
`started` result, never message text. An unknown `started` result does not confirm
that the recipient began processing the message.

Use the installed core CLI directly:

```sh
hc send TARGET "message"
```

Install both matching app and core builds for native message animations. The
Python tracing launcher has been removed. Older apps can still display an existing
`data/sixfold/messages.json` history, but direct sends do not append to that file.
When the native API is available, the sidebar does not read the legacy log.
An animation indicates a send event, not a read receipt or confirmed submission.

### Updating an installation that used the tracing launcher

Remove `~/.local/share/herdr-sixfold/bin` from your PATH and shell startup files,
and stop calling `hc_trace.py` explicitly. Verify that `hc` resolves to the installed
core CLI (`Get-Command hc -All` on PowerShell, `command -v hc` on POSIX shells).
If `~/.local/bin/hc` is a symlink to the tracing launcher, restore its previous core
CLI target; leave unrelated launchers untouched. After checking their contents,
remove the old `hc_trace.py`, `bin/hc`, and `bin/hc.cmd` under
`~/.local/share/herdr-sixfold/`. Existing message history and read positions can stay.
Update installed copies of `scripts/route.py` and `scripts/collect_workflow.py` too:
they now call `hc` directly instead of the tracing launcher. Existing shells may
retain their old PATH until refreshed.

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

## Pinned workspace markers

Configure `~/.config/herdr-app/data/sixfold/workspace-pins.local.json` with
`{"spaces":[{"id":"actual-space-id","machine":null}]}` using IDs from `herdr-app ls`.
Remote entries need the app's qualified space ID and machine name. Only exact machine/ID
matches receive a pin icon and accent border. Renaming preserves the marker; another
workspace with the same name does not inherit it. No names or default pins are hardcoded.
The setting reloads live, keeps its last valid value on malformed JSON, and an empty
`spaces` array clears all markers. It does not reorder workspaces or prevent deletion,
and is independent of document pins and native terminal pins.

Project overload collaboration uses explicit task records and durable leases above existing Share routing; see [commands, safety and verification](docs/overload-collaboration.md). The sidebar drains registered collaboration work only after `collaborate.py enable`; raw terminal text is never treated as a confirmed pending queue.

A low-contrast 16px session-pet strip below the toolbar reflects the current workspace agents. `sixfold.pets=false` hides it; `sixfold.pets.motion=false` or `sixfold.motion=false` stops motion.
