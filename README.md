# Herdr Theme

Coordinate coding agents across projects and computers from one live sidebar. See every workspace and agent, follow concurrent messages (including sends between computers), see which projects are being worked on from more than one computer, and expand subagent trees while keeping your current terminal in view.

![Herdr Theme](preview.png)

[한국어](README.ko.md)

## What it does

| Feature | Benefit |
| --- | --- |
| Computer list with independent workspace lists | Pick a computer, then see its projects and agents. Focus on another computer's session switches the list to it. |
| Per-computer status | Each computer row counts working, done and needs-you agents, and ↑/↓ sends to and from other computers in the last ten minutes. |
| Shared work across computers | When a project has working agents on two or more computers, a quiet dashed right-angle pipe joins them and the workspace border shows ⇄. It disappears when the shared work ends. |
| Concurrent animated message routes | Follow real successful sends, including several agents, repeated messages on one route and sends to or from another computer. |
| Live status and per-agent unread messages | See which agent is working, waiting or needs your decision. |
| Expandable subagent trees | See delegation relationships and status provenance; estimated activity is labelled. |
| Workspace badges | Other mods and tools can show small clickable badges beside a workspace name. |
| Project icons, colors and group borders | Recognize each project's agents at a glance. |
| Focus that stays yours | Messages and status changes keep your current input target in place. |

The layout also provides Korean/English labels, light/dark palettes, keyboard navigation and drag ordering. It preserves the active tab's existing split tree; the default six-pane arrangement is one way to use it.

The public preview uses labelled demo programs, not real projects, conversations or usage metrics.

## Requirements

- Herdr app 0.1.11 or newer and Python 3. Computer lists and remote workspaces need machine-layout support (verified on 0.1.17).
- Message animations need the native message events: an app exposing `messageEvents()` and a core emitting `message_sent`. Until they ship in a release, build both from source: the app from the [`feat/message-sent-events`](https://github.com/chanyang721/herdr-app/tree/feat/message-sent-events) branch and the core from [herdrdev/herdr-core#90](https://github.com/herdrdev/herdr-core/pull/90). Install the app and core together, and replace the core on every computer you want to see sends from (the event is emitted by the core that delivers the message). Without them everything else works; sends simply do not animate.
- macOS, Linux and Windows. Voice and HTML document snapshots are macOS only; the live TUI bridge is macOS/Linux.

## Install

macOS / Linux:

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
herdr-app do layout.switch --name sixfold
```

Windows (PowerShell, with the Python launcher `py`):

```powershell
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
py -3 scripts/install.py
herdr-app check "$HOME\.config\herdr-app\mods\sixfold-desk"
herdr-app do layout.switch --name sixfold
```

The app home is `~/.config/herdr-app` on every platform (`HERDR_APP_HOME` overrides it). The installer refuses to replace existing Herdr Theme files or an existing `layout:sixfold` key section. It preserves all other layouts, settings and key bindings. Switch back with the layout picker.

The synchronized `sixfold` layout includes a monitor strip. Install its external `system-metrics`, `mcp-status`, `cli-status`, `agent-usage` and `plan-usage` mods from [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods) before selecting it; see [monitor layout requirements](extras/monitor-layout/README.md). This repository does not pin or install those mods.

### Updating an installation

`scripts/install.py` is only the initial installer. **For every later installation, use only `scripts/update_install.py`; never copy or rsync files into the running app by hand.** Review the diff and list the files to install:

```sh
python3 scripts/update_install.py mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

(`py -3` instead of `python3` on Windows.) The updater locks `data/sixfold/install.lock`, builds complete affected mod trees outside `mods/`, runs native checks, keeps full backups under `backups/sixfold-update-*/`, then exchanges each mod directory. On macOS and Linux the exchange is atomic (directory swap / `renameat2`). Windows has no directory swap, so the updater moves the installed mod aside, moves the checked candidate in and keeps the old tree in the stage folder: the mod path is missing for that moment, and a failed move puts the installed tree back. Unlisted installed files stay in the candidate tree; identical contents and modes are skipped to avoid unnecessary reloads. Layout/theme files and scripts are replaced individually; repository `scripts/<file>` installs into `scripts/sixfold/<file>`.

It verifies that `status.errors` stays empty for one second and that space, tab and focused pane are unchanged. Failed checks do not install; failed verification rolls back automatically, and a later concurrent writer is preserved and reported as a conflict. The receipt in the backup records before/after status, checksums and rollback results. A clean status is not a visual check: also inspect a native `herdr-app shot`.

Install several files in one run rather than one at a time: each swap reloads the mod, and a burst of reloads can exhaust the app. Use a separate git worktree and branch per editing session, and let one designated session install a reviewed candidate. **Never duplicate an installed mod into `mods/*-recovery` or point layouts at a recovery clone**; restore through the updater and keep backups outside `mods/`. For an authorized repair of an already broken app, `--allow-unhealthy-before` permits the initial errors (final errors must still be zero). `--verify-timeout 30` gives hot reload more time. The updater never quits or restarts Herdr or herdr-core. To install the updater itself, list `scripts/update_install.py`; when running that installed copy, pass `--repo /path/to/reviewed-worktree`.

Legacy `install_doc_tabs.py` and `install_preview.py` provision features; they are not alternate live-update paths. Send existing mod/layout code updates through the updater.

The manual macOS native regression probe runs in its own app/core home:

```sh
python3 tests/native_ui_reload.py --reloads 80 --install-smoke
```

## Keys

These bindings apply only while Herdr Theme is selected. Other native Herdr bindings stay available.

| Key (macOS) | Action |
| --- | --- |
| Cmd+[ / Cmd+] | Previous / next pane in the current tab |
| Cmd+Option+1…6 | Focus a numbered pane |
| Ctrl+Shift+arrows | Focus a neighbour |
| Cmd+Shift+Up / Down | Previous / next workspace |
| Cmd+Shift+J / U | Next blocked / completed agent |
| Ctrl+Shift+N | New workspace on the selected computer |
| Cmd+R | Rename tab |
| Cmd+X | Close the app pane; a bridged TUI agent remains in its source server |
| Cmd+W / Cmd+Shift+W | Intentionally do nothing, to avoid accidental closure |

On Windows and Linux, edit the layout-scoped fragment in `keys.json` to suit your keyboard.

## Computers and remote agents

The sidebar lists this computer and persistent `hc machine` connections. Selecting a computer shows only its workspaces and agents, including attention counts and next-blocked/next-done navigation. Switching back returns to its last selected workspace. A computer with no workspaces opens the new-workspace dialog; an unavailable one opens machine settings. Existing processes stay running.

The list follows focus: moving focus to a session on another computer switches the list to that computer. A manual pick holds until focus moves again. Selecting a computer or toggling the list never moves terminal focus or starts a connection.

Each computer row shows:

- working / done / needs-you counts (only non-zero ones; the full set, including idle, is in the tooltip);
- ↑N ↓N: sends to and from other computers in the last ten minutes. The counts age out on their own, even on a quiet screen.

Local and connected/connecting Herdr computers are shown by default. Disconnected remotes and unregistered Tailscale peers are hidden while collapsed, including icons and counts; the small arrow beside **COMPUTERS** expands their list (capped at 180 units high).

**+ Space** and **Ctrl+Shift+N** target the selected computer. Local workspaces retain the six-agent default. Remote workspaces start with one terminal on that computer; an empty folder uses its home. The folder picker is local only.

From the main computer, `hc send worker/t7 "your message"` sends to that computer's terminal; use its qualified address from `hc ls`. Selecting an agent's row lets you type directly. `hc send --wait` can observe the agent's next turn, but a successful send alone is not a read receipt. This theme does not configure SSH, Tailscale, firewall rules or agent credentials.

### Shared work across computers

A project counts as shared when it has working agents on two or more computers at once. Same project means the same workspace name; a trailing `(name)` that names the workspace's own computer is ignored, so `Docs (worker)` on `worker` matches `Docs` here. Unnamed workspaces (`~`) are skipped.

- **Pipes:** right-angle, 1px dashed pipes in a fixed right margin of the computer list join the computers sharing a project, each project in its own lane and muted colour. A small dot travels along the pipe while motion is on. Nothing moves or reflows: the pipes are drawn over a reserved margin.
- **Workspace mark:** a shared workspace's border turns dashed in the pipe's colour and shows ⇄ on its top edge (⇄2, ⇄3 … for more computers). The tooltip names the other computers.
- **Ending:** when fewer than two computers are working on the project, the pipe and the mark fade out (0.6 s; at once with motion off). A name match alone never keeps a link.

This shows that two computers work on one project at the same time. It is not evidence that anything was sent between them.

### Sends between computers

A send whose ends are on different computers runs its pipe from the visible row up to the top of the workspace list, just under the computer rows. The other computer's row lights up in the route colour with ⇡ (sent) or ⇣ (received), and the transfer footer adds a ⇄ chip naming the far computer. An endpoint's computer comes from its terminal address (`machine/` prefix), so parked or background remote terminals count too.

### Names, folders and discovery

Optional friendly names and default folders live only in `~/.config/herdr-app/data/sixfold/computers.local.json`:

```json
{
  "local": { "label": "Home" },
  "machines": {
    "worker": { "label": "Build computer", "folder": "/home/user/projects" }
  }
}
```

Machine keys match `hc machine ls`. Without this file, native machine names are shown (this computer reads "This computer", or "This Mac" on macOS). Labels reload live; the optional folder applies to new workspaces. Keep private addresses, paths and credentials out of Git.

For discovery without a remote connection, set `"tailscale": true` in the same file (the helper `scripts/collect_computers.py` comes with the first install). Every 15 seconds the sidebar reads **local** `tailscale status --json`; peers appear with their Tailscale DNS hostname and online flag. These passive rows cannot open shells or workspaces, and "online" is not proof that SSH or Herdr is reachable. No ACL changes, peer probes or remote installs occur.

Native remote work needs a noninteractive SSH connection (or a byte-preserving `--via` command) and a compatible `hc` on the target; `hc machine add --help` documents `--install`. Registering a machine starts a connection, so do it only after remote access is authorized. For a Windows target, enable OpenSSH Server, start `sshd`, configure key authentication and an inbound TCP 22 firewall rule scoped to the main computer's Tailscale IP (or the intended range), install compatible herdr-core on PATH, then `hc machine add user@TAILSCALE_IP --name HOST`.

## Message flow

There is no permanent message-history panel. New sends show a sender → recipient notice for about four seconds. Colours and lanes separate concurrent routes; repeated sends keep individual packets and show a grouped count. The notice shows at most two routes and an overflow count. Unresolved queued/error/held deliveries stay in a compact status row with full details in the tooltip. Motion off disables travel.

The sidebar reads successful sends from the app's bounded in-memory `messageEvents()` list (see [Requirements](#requirements)). Direct `hc send` and RPC sends use the same path; no launcher or per-message log write is needed. Events carry sender, recipient, time and the observed `started` result, never message text. An animation is a send event, not a read receipt or proof that the recipient started work.

Send with the installed core CLI directly:

```sh
hc send TARGET "message"
```

Older apps can still show an existing `data/sixfold/messages.json` history, but direct sends do not add to it, and the sidebar ignores that file when the native API is available.

### Removing the old tracing launcher

Earlier versions shipped a Python tracing launcher; it has been removed. If you installed it: remove `~/.local/share/herdr-sixfold/bin` from your PATH and shell startup files, and stop calling `hc_trace.py`. Check that `hc` resolves to the core CLI (`Get-Command hc -All` in PowerShell, `command -v hc` in POSIX shells). If `~/.local/bin/hc` is a symlink to the launcher, restore its previous core target; leave unrelated launchers alone. After checking their contents, remove `hc_trace.py`, `bin/hc` and `bin/hc.cmd` under `~/.local/share/herdr-sixfold/`. Also update installed copies of `scripts/route.py` and `scripts/collect_workflow.py`, which now call `hc` directly. Existing shells may keep their old PATH until restarted.

## Subagent trees and the workflow collector

Subagents expand under their parent agent with `▸ N`; parents without children stay visible. New observed delegations expand the tree and animate a Bezier pipeline. Counts stay on agent rows, not workspace headers.

`scripts/collect_workflow.py` reads Claude metadata, the read-only Codex database and hc parent links to publish `data/sixfold/workflow.json`. `--once` collects once; otherwise it reconciles every three seconds and writes only changes. Estimated activity is labelled, and startup history does not animate. It runs on macOS, Linux and Windows (on Windows it uses a Toolhelp process snapshot and the Restart Manager instead of `pgrep`/`lsof`, and starts `hc` without opening console windows).

The first install does not include the collector, and the theme never registers it to run in the background. Install it with the updater (`python3 scripts/update_install.py scripts/collect_workflow.py`, or `py -3` on Windows); it lands in `scripts/sixfold/`. On Windows you can then run it at logon, hidden, with Task Scheduler (one instance at a time):

```powershell
$pyw = Join-Path (Split-Path (py -3 -c "import sys; print(sys.executable)")) 'pythonw.exe'
$home_ = "$HOME\.config\herdr-app"
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$home_\scripts\sixfold\collect_workflow.py`"" -WorkingDirectory $home_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Herdr Theme workflow collector'
```

`pythonw.exe` has no console window. Remove it with `Unregister-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Confirm:$false` (stop a running copy first with `Stop-ScheduledTask`).

## Workspace badges (extension point)

Other mods and tools can put small badges beside a workspace's name in the sidebar, without changing the theme. Publish them in shared state `sixfold.workspace.badges`, or write `~/.config/herdr-app/data/sixfold/workspace-badges.json` (the sidebar watches it):

```json
{ "<machine>|<space id>": [ { "id": "open", "text": "! 2", "tone": "blocked", "tooltip": "Two open items",
  "open": { "mod": "my-mod", "props": { "x": 1 }, "kind": "window", "key": "my-mod-x", "width": 800, "height": 600 } } ] }
```

`<machine>` is the remote machine's name, empty for this computer; `<space id>` has no machine prefix. Tones: `blocked`, `working`, `done`, `accent`, `dim`. A click opens `open` as an overlay of that mod, or runs `command` (`{"name": "my-mod.show", "args": {}}`). Up to four badges per workspace, twelve characters each; malformed entries are ignored. Shared state wins over the file for the same workspace. The theme publishes no badges itself.

## Channel alerts (optional)

New channel messages appear on a separate "channel alerts" line under a workspace title, with a Slack icon, apart from session counts and pins. `data/sixfold/project-alerts.json` lists tracked workspace names in `projects` and new messages (`id`, `project`, `author`, `text`, `at`, `link`) in `items`; read state is kept by message ID in `slack-alerts-read.json`. The mention popup is the `sixfold-slack-inbox` mod (`herdr-app do mod.open '{"name":"sixfold-slack-inbox"}'`), which reads `data/sixfold/slack-mentions.json`, groups mentions by thread and keeps its own read state, separate from Slack's. Collecting from Slack is a separate tool.

## Equal grids and new workspaces

```sh
python3 scripts/balance_grid.py
python3 scripts/workspace.py "Example" /path/to/your/project
```

`balance_grid.py` uses the core's version-checked document API to give six-terminal tabs equal rows and columns while keeping every pane ID and terminal address; it never restarts a program. **+ Space** and **Ctrl+Shift+N** open a name/folder dialog; locally they create one tab with a 3×2 split of four Claude and two Codex sessions (both CLIs must be installed). `workspace.py` uses the same default; pass `--shells` for six plain shells. Agent authentication and workspace trust use the agents' own interfaces.

## Workspace pins, icons and local settings

**Pins.** Configure `~/.config/herdr-app/data/sixfold/workspace-pins.local.json` with `{"spaces":[{"id":"actual-space-id","machine":null}]}` using IDs from `herdr-app ls` (remote entries need the qualified space ID and machine name). Only exact machine/ID matches get a pin icon and accent border; renaming keeps the marker, and another workspace with the same name does not inherit it. The file reloads live, keeps its last valid value on malformed JSON, and `{"spaces":[]}` clears all markers. It does not reorder or protect workspaces.

**Icons.** `python3 scripts/set_workspace_icon.py 'workspace ID or exact name' /path/to/icon.png` sets a project icon (SVG, PNG, JPEG or WebP; optional `--background '#ffffff'` and `--tint` for monochrome SVGs). Assets are copied under `data/sixfold/icons/` and refreshed without a restart.

**`site.local.json`.** Project names and aliases, sidebar marks and colours, the Slack workspace URL and mention names, report/state folders, the LaunchAgent label prefix and document-tab seeds differ per person, so they live in `~/.config/herdr-app/data/sixfold/site.local.json`, never in the repository. Copy `config/site.example.json` to start. `*.local.json` is git-ignored. Pane headers hide the position number (`01`, `02`) by default; `"pane_header_index": true` brings it back.

## Idle sessions and finished workspaces (optional, macOS)

`scripts/sleep_idle_sessions.py` puts agents to sleep that have been idle for 20 minutes with an empty input, no pending approval, no subagents or background work, and are not visible or focused. The pane stays: Enter, or an incoming `hc send`, resumes the same session with its original options. `scripts/close_finished_spaces.py` lists temporary workspaces whose agents have finished. Both start as dry-run LaunchAgents (`install_session_sleep.py --install`, `install_space_cleanup.py --install`) and act only after you review their logs and enable apply. Workspaces are never closed unless `space_close_enabled: true` is set by hand. Both recheck every condition right before acting, keep uncommitted files and worktrees, and keep a workspace whose state they cannot confirm.

## Optional live TUI bridge (macOS/Linux)

Herdr TUI and Herdr app have separate runtimes. A bridge is a live attachment, not an import: the source TUI server must keep running, and its agent, conversation, permissions and voice connection stay where they are.

```sh
python3 /path/to/herdr-theme/scripts/tui_bridge.py --session default --pane YOUR_SOURCE_PANE
```

The bridge reports source status once per second, forwards input and resize, and uses a per-source lock. It never sends an agent prompt; closing the attachment leaves the source agent alive.

## Optional voice (macOS)

`voice/` is a herdr plugin for directing agents by voice through a headset: only the focused pane records (Claude Code dictation on F8, Codex mute/unmute on F9), a finished sentence is sent after a short pause, and a local speaker check refuses dictation that was not the enrolled person's voice.

```sh
bash voice/install.sh                    # first time: also installs herdr and uv with Homebrew
python3 scripts/update_install.py voice  # later updates (or python3 voice/install.py)
```

Each person's microphones and tuned values live in their own `~/.config/herdr-app/data/sixfold/voice.local.json`. Voice data never leaves the Mac. Details: [voice/README.md](voice/README.md) (Korean).

## Optional document and usage tools

[Project Document Viewer](extras/preview/README.md) adds saved-file Markdown preview and local HTML snapshots; project document tracking is described in [configuration and collector](docs/project-documents.md). Independent mod releases (system metrics, MCP and CLI status, agent and plan usage, document viewer) live in [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods). Token history is available from [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights). Account quotas are not per-agent token totals.

Message routing between a common workspace and project slots is described in [COMMON_ROUTING.md](COMMON_ROUTING.md); run `python3 scripts/route.py --enable` to connect this checkout to the sidebar queue drain. Collaboration under overload is described in [docs/overload-collaboration.md](docs/overload-collaboration.md). A low-contrast session-pet strip below the toolbar reflects the current workspace's agents; `sixfold.pets=false` hides it and `sixfold.motion=false` stops motion.

## What it runs

The UI uses Herdr's live workspace/agent APIs and navigation commands, with no network requests. The optional bridge runs the installed `herdr` CLI; helpers use `hc` / `herdr-app` locally. No private configuration, account data or session mapping belongs in this repository.

## Development

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
node --check mods/sixfold-desk/main.js
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

`herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` next to a mod; do not commit them. Model tests are not a native UI test: verify a changed layout with `herdr-app status` and an actual screenshot. See [RECIPE.md](RECIPE.md) for the reproducible design brief. Work on a short branch from `main`; the installed copy tracks `main`. Apache-2.0.
