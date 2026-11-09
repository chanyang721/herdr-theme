# Herdr Theme

Coordinate coding agents across projects and computers from one live sidebar. See workspaces, agent states and shared work across computers; browse project documents; and keep CPU/RAM, MCP connections, account CLIs, plan limits and per-session token use beside your terminals. Message animations are available when the app and core supply message events.

![Herdr Theme on Windows: two computers, shared work on Storefront, the monitor strip](preview.gif)

[한국어](README.ko.md)

The looping GIF and screenshots illustrate the collaboration display in the real app on Windows 11 with labelled demo workspaces. Only the second computer, "worker", and its sidebar data (including send events) are synthetic. The monitor strip shows the capture machine's real readings. The 12-second loop follows a send into the collaboration-border comet and back to breathing. The feature list and requirements below describe current functionality and event support. [Still image](preview.png).

## What you get

Herdr Theme is the layout and sidebar. The installer also adds [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods) at a pinned release, so the monitor strip works out of the box. Both repositories stay separate; this README covers them together.

This README describes the current `main` branch. The bundled helper is the native Rust executable `herdr-theme`. Local task delegation, session sleep/cleanup and other automation policies are supplied separately by their owners; the theme displays their optional data through [local integrations](#optional-local-integrations).

| Part | What it shows |
| --- | --- |
| Sidebar (this repo) | Computers with per-computer status, workspaces and their agents, unread messages, animated sends, shared work across computers, subagent trees, [pixel-art row states](#row-states-and-their-pixel-effects) |
| [Project documents](#project-documents) | Workspace document search and an optional persistent **문서** tab, with pins and previews |
| [System Metrics](#system-metrics) | CPU and RAM with recent-sample bars |
| [MCP Status](#mcp-status) | Each MCP server's connection, Claude and Codex merged |
| [CLI Status](#cli-status) | Sign-in state of AWS profiles, GitHub, kubectl and Docker |
| [Plan Usage](#plan-usage) | Codex and Claude 5h / 7d limits, Codex limit resets |
| [Agent Usage](#agent-usage) | Session tokens, model, effort, permission mode and weekly share; pane-header cats reflect agent state |
| [Local integrations](#optional-local-integrations) (optional) | Producer-supplied badges, question/permission cards, document views and session reports |
| [Document Viewer](#document-viewer) (optional) | Project files and Markdown beside your terminals |

## Platform support

The table describes supported behavior and the previous release's checks. Native migration evidence and remaining platform checks are tracked in [Native helper migration](docs/native-rust-migration.md).

| Part | macOS | Windows |
| --- | --- | --- |
| Sidebar, computers, message flow, shared-work display | yes | yes |
| System Metrics, MCP Status, CLI Status, Plan Usage, Agent Usage | yes | yes |
| Workflow collector (subagent trees) | yes | yes (Task Scheduler snippet below) |
| Document Viewer: Markdown | yes | yes |
| Document Viewer: HTML preview | yes (WebKit snapshot) | no — HTML opens on its source; the HTML tab says the preview needs macOS |
| Document Viewer: refresh when a file is saved | yes | yes |
| Voice | yes | no (the installer skips it) |
| Optional live TUI relay | yes (POSIX terminal APIs; also Linux) | no |
| Local integration displays | yes, with a configured producer | yes, with a configured producer |

Linux has native helper and POSIX relay paths, but its desktop UI was not checked for this release. The macOS WebKit renderer and voice installation are macOS-specific. Session sleep/cleanup services are maintained outside this theme release; their platform support is determined by the service you install.

## Requirements

- Herdr app 0.1.11 or newer, a compatible herdr-core and Git. Computer lists and remote workspaces need machine-layout support. Building the native helper also needs stable Rust and a C compiler; on Windows, use the MSVC C/C++ Build Tools or a complete GNU-compatible toolchain. Bundled theme helpers do not require Python.
- Message animations are capability-dependent: the app must expose compatible `messageEvents()` metadata and the relevant cores must emit the underlying send events. The theme uses the API when present and otherwise has no live send animation. Installing this theme does not install or replace the app or core; use a mutually compatible app/core build if you need this feature.
- Agent Usage reads the local store of the [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights) mod (install it separately; it needs Node.js).
- The local **+ Space** dialog starts one Claude session and checks that the Claude CLI is installed. Remote workspaces start with a terminal. Existing sessions and the monitor strip can be used independently of workspace creation.

## Install

macOS / Linux:

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
./rust/target/release/herdr-theme install
herdr-app do layout.switch --name sixfold
```

Windows (PowerShell, using the native executable):

```powershell
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
.\rust\target\release\herdr-theme.exe install
herdr-app do layout.switch --name sixfold
```

The installer:

- installs the theme's mods, layouts, palettes and native helper into the app home (`~/.config/herdr-app` on every platform; `HERDR_APP_HOME` overrides it);
- fetches Herdr Workspace Mods at the commit pinned in [`workspace-mods.lock.json`](workspace-mods.lock.json) into `~/.local/share/herdr-sixfold/vendor/herdr-workspace-mods/<commit prefix>` (one folder per commit, made only once the checkout succeeds), checks it is exactly that commit with no local changes, and installs the files that commit tracks for `system-metrics`, `mcp-status`, `cli-status`, `plan-usage` and `agent-usage` with the theme. The installed release is recorded in `data/sixfold/workspace-mods.json`;
- installs the pinned Document Viewer assets through the native installer when a layout with a Files panel exists (Herdr creates `main` on first start); otherwise it prints that command to run later. Off macOS it installs Markdown only;
- refuses to replace existing files or an existing `layout:sixfold` key section, and preserves other layouts, settings and key bindings. `--update` refreshes what it installed before and keeps layouts and palettes you changed.

Options: `--without-workspace-mods` installs the theme alone (the `sixfold` layout's monitor strip then needs those mods installed some other way); `--workspace-mods-source PATH` installs from a local checkout already at the pinned commit instead of fetching. On a wide screen the `sixfold` layout puts the whole strip in one row; on a smaller Windows window use the two-row variant in [`extras/windows-layout`](extras/windows-layout/README.md), which the screenshots use.

### Updating an installation

After the first install, **use only `herdr-theme update-install`; never copy files into the running app by hand.** List the theme files you reviewed; the pinned Workspace Mods are brought to the pinned release in the same run (unchanged files are skipped, so nothing reloads needlessly):

```sh
herdr-theme update-install mods/sixfold-desk/main.js mods/sixfold-desk/model.js
herdr-theme update-install            # only bring the Workspace Mods to the pinned release
```

The examples assume the built executable is on PATH; alternatively use `./rust/target/release/herdr-theme` or `.\rust\target\release\herdr-theme.exe`. `--without-workspace-mods` leaves the pinned mods as installed; a run that lists only `voice` never touches them. Include `scripts/herdr-theme` (`scripts/herdr-theme.exe` on Windows) when updating native helper code.

The updater locks `data/sixfold/install.lock`, builds complete affected mod trees outside `mods/`, runs `herdr-app check` on each, keeps full backups under `backups/sixfold-update-*/`, then exchanges each mod directory. On macOS and Linux the exchange is atomic; Windows has no directory swap, so the mod path is missing for a moment and a failed move puts the installed tree back. It then requires `status.errors` to stay empty for one second with space, tab and focus unchanged, and rolls back otherwise (a later concurrent writer is preserved and reported). The receipt in the backup records what happened. A clean status is not a visual check: also look at `herdr-app shot`.

Install a reviewed group of files in one run: each swap reloads a mod, so this avoids unnecessary reloads. Use a separate git worktree per editing session, and let one session install a reviewed candidate. **Never duplicate an installed mod into `mods/*-recovery`.** `--allow-unhealthy-before` permits initial errors for an authorized repair (final errors must still be zero); `--verify-timeout 30` gives hot reload more time. The updater never quits or restarts Herdr or herdr-core. When running the installed copy in `scripts/sixfold/`, pass `--repo /path/to/reviewed-worktree`.

## Keys

These bindings apply only while the `sixfold` layout is selected; other Herdr bindings stay available.

| Key (macOS) | Action |
| --- | --- |
| Cmd+[ / Cmd+] | Previous / next pane in the current tab |
| Cmd+Option+1…6 | Focus a numbered pane |
| Ctrl+Shift+arrows | Focus a neighbour |
| Cmd+Shift+Up / Down | Previous / next workspace |
| Cmd+Shift+J / U | Next blocked / completed agent |
| Cmd+Ctrl+1…9 | Select a computer |
| Cmd+Option+F | Expand and search the active workspace's documents |
| Ctrl+Shift+N | New workspace on the selected computer |
| Cmd+R | Rename tab |
| Cmd+X | Close the app pane |
| Cmd+W / Cmd+Shift+W | Intentionally do nothing, to avoid accidental closure |

On Windows and Linux, adjust the layout-scoped fragment in `keys.json` to your keyboard.

## Computers and remote agents

The sidebar lists this computer and persistent `hc machine` connections. Selecting a computer shows only its workspaces and agents, with its attention counts and next-blocked/next-done navigation; switching back returns to its last workspace. The list follows focus: moving focus to a session on another computer switches to that computer, and a manual pick holds until focus moves again. Selecting a computer never moves terminal focus or starts a connection.

Each computer row shows its working / done / needs-you counts (only non-zero ones; the tooltip has all of them) and ↑N ↓N, the sends to and from other computers in the **last ten minutes**.

Local and connected/connecting computers are shown by default. Disconnected remotes and unregistered Tailscale peers are hidden until you expand the list with the arrow beside **COMPUTERS**. **+ Space** and **Ctrl+Shift+N** target the selected computer: locally one coordinating Claude session, remotely one terminal in that computer's home (or its configured folder). Additional panes and their lifecycle are managed manually or by a separately configured tool.

From the main computer, `hc send worker/t7 "message"` sends to that computer's terminal (use the qualified address from `hc ls`). A successful send is not a read receipt. The theme does not configure SSH, Tailscale, firewall rules or agent credentials.

### Local task tracking

An optional [local task feed](docs/panel-feed.md) shows one-line tasks, four-stage bars, parent/child trees, issue groups, sharing links, message packets and four closing stages. Issue groups and large child lists expand with **+N**. Completed tasks show a check; blocked work, missing reports, unread messages, remote work and usage limits have separate indicators.

Rows display the supplied work title. Producers should supply the current task or subtask name. Completed child tasks leave both their tree and its **+N** count; independent root tasks keep their own closing lifecycle.

The stage bar follows the task and the status mark follows the pane's own observed state, so a pane can still read as working after its task is complete. A changed stage or a new event (a dispatch, review request, verdict, acceptance or closing step) shows the event's label in place of the bar for 1.7 seconds without moving the title.

Click the Linear or Jira area to open an issue popover on the right. Search **이번 주** (this week), **마일스톤** (milestones) or **전체** (all), then bring individual cached issues into the workspace. Local requests change the displayed issue selection. The theme does not accept work or close sessions. Task rows appear inside the selected computer's native workspace cards, alongside workspace badges, document controls and local question cards. **작업** toggles the task rows while preserving computer navigation. Motion off and the supplied system reduced-motion preference keep state updates without movement.

Explicit same-computer space partners show matching name chips and a stationary purple bracket with square endpoints. Same-task agent brackets are stationary gray; dashed sharing routes identify other computers.

A new message rides the line that already joins its two ends: the computer's dashed pipe for another computer, the collaboration lane between partner spaces, and otherwise the inner message lane. All of these lines share one fixed 72 px gutter on the right of the sidebar. Each is a thin right-angle stroke with rounded corners. The packet, a small white head with two teal tail pieces, moves out, along, then in, so it never leaves the drawn line, and it lands with a single square ping. Bursts are staggered over two lanes, with at most eight routes scheduled; missing endpoints are skipped. Delivery counters explicitly marked as counts are not network rates. Initial history is never replayed after reload.

See the [native fixture gallery and measurements](docs/panel-validation.md) for 24 combinations (4 sharing modes × 3 tool choices × 2 Slack states), each captured in dark and light themes: 48 matrix images, plus interaction examples and update checks.

![Task panel and issue popover rendered by the app with synthetic local data](docs/images/panel-feed/issues-milestone.png)

#### Row states and their pixel effects

![The seven row-state images enlarged five times, in the dark and light palettes](docs/images/session-states.gif)

When the feed gives a row an optional `state`, the row's status mark becomes one of seven small pixel-art images. Each state has its own shape, so colour is never the only difference.

| `state` | Label | Image | Effect |
| --- | --- | --- | --- |
| `working` | 작업 중 | ring of eight dots | a bright dot circles the ring (0.8 s loop) |
| `idle` | 쉬는 중 | empty ring | still |
| `needs_human` | 확인 필요 | orange diamond with `!` | swells with a glow once, then holds (1.6 s loop) |
| `unseen_result` | 결과 안 봄 | check mark with a new-result dot | a light sweeps along the check (2.4 s loop) |
| `cleanup_wait` | 정리 대기 | moon | a `z` rises and fades (3 s loop) |
| `closing` | 닫는 중 | open tray | a drop falls into the tray and splashes (1.2 s loop) |
| `closed` | 닫힘 | closed box | still; the row is dimmed |

How they play:

- The images are packaged files in [`mods/sixfold-desk/icons/status/`](mods/sixfold-desk/icons/status): a still PNG and a lossless animated WebP per state, at 12 and 16 px, for dark and light palettes. `manifest.json` lists each file's frame count, timing and hash. The app's native image decoder plays the WebP; the theme runs no renderer and no script timer for them.
- **Motion off**, the feed's `reduced_motion` or a hidden window shows the still PNG. While an event label is showing on that row (the 1.7 seconds above), the image also holds still.
- An error (`!`) or usage-limit (`◷`) mark takes the slot first. Child rows keep their small dot. A row without a known `state` keeps the earlier four-status mark, so older producers render as before.
- A second line under the title gives the reason: the producer's `keep_reason`, the closing step (보고 작성 → 경험·결정 저장 → 기억함 제안 → 닫힘), or, for `cleanup_wait` and `unseen_result` rows with `cleanup` data, a countdown such as `30분 쉬면 닫힘 (남은 12분)`. The minutes are counted from the producer's `due_at` on the local clock, and only that row redraws, once a minute; after `due_at` it reads `다음 정리 때 닫힘`.
- All of it is display only. The theme never decides whether a session is kept or closed. Field details are in the [feed contract](docs/panel-feed.md).

The frames were rendered with [pixelfx](https://github.com/patch-gg/pixelfx) (MIT; see the folder's [NOTICE](mods/sixfold-desk/icons/status/NOTICE.md)). The GIF above is built from the shipped 16 px files with their own frame timings, enlarged five times.

### Shared work across computers

Workspaces belong to the same project when their names match; a trailing `(computer name)` naming the workspace's own computer is ignored, so `Docs (worker)` on `worker` matches `Docs` here. Unnamed workspaces (`~`) are skipped.

- **A partner is always visible:** whenever that project has a workspace on another computer, its header shows a 14px computer icon and the partner's name at 12px, even with no work in progress. With more partners it reads, for example, `worker +1`; the tooltip lists every partner and its working-agent count. The default collaboration colour is periwinkle: `#A9B8FF` on dark themes, `#3346B8` on light themes, adjusted for at least 4.5:1 text contrast on the header (win98 uses `#3043AF`).
- **Working together now:** when this computer and at least one partner both have working agents on the project, the workspace gets a **2px solid outline, a 10% tint and a filled ⇄ badge** on its top edge. `⇄2`, `⇄3` … count the other computers working on it. These are overlays, so the layout stays still. When shared work ends, the workspace returns to its usual appearance with the partner name still visible; the badge fades with motion on.
- **Border flow:** while shared work is active, the outline gently breathes. A send between that group's computers continues into a comet around the workspace border after the 1.6-second packet travel: two 3.6-second laps, then breathing again. Active group borders, badges and computer-row pipes use one of four theme-aware colours with staggered breathing periods; colours repeat beyond four groups. At most three groups show comets at once. **Motion off** keeps the border still, and ending shared work removes the animation.
- **Find the other side:** hover a workspace to outline and tint its partner computer rows; hover a computer row to highlight its partner workspaces. Workspace partner names and shared-work marks are independent of the computer-list pipes' four-link limit. Orange needs-you / approval-waiting marks remain visible.

The computer list separately draws up to four right-angle dashed pipes in a fixed right margin: for shared work, or for a pair of computers for **five minutes after their last send**. The ↑/↓ counts still cover the **last ten minutes**. A shared-work mark shows simultaneous activity on the same project; a send link shows a send event. Neither proves that a particular message was delivered or read.

| One shared project · dark | One shared project · light |
| --- | --- |
| ![One shared Storefront project in the dark theme](docs/images/collab-single-dark.png) | ![One shared Storefront project in the light theme](docs/images/collab-single-light.png) |

| Multiple project groups · dark | Multiple project groups · light |
| --- | --- |
| ![Several shared projects and an idle Notes partner in the dark theme](docs/images/collab-multi-dark.png) | ![Several shared projects and an idle Notes partner in the light theme](docs/images/collab-multi-light.png) |

Native app captures during border flow on Windows 11, using `sixfold-night` / `sixfold-day` and demo workspaces. Only the `worker` computer and its sidebar data (including send events) are synthetic. In the multiple-group views, Notes has a partner but no shared work in progress, so its header keeps the partner name without an active border or badge.

### Sends between computers

A send whose ends are on different computers runs its pipe from the visible row up to the top of the workspace list. The other computer's row lights up in the route colour with ⇡ (sent) or ⇣ (received), and the footer adds a ⇄ chip naming the far computer. An endpoint's computer comes from its terminal address (`machine/` prefix), so background remote terminals count too.

### Names, folders and discovery

Friendly names and default folders live only in `~/.config/herdr-app/data/sixfold/computers.local.json`:

```json
{
  "local": { "label": "Home" },
  "machines": {
    "worker": { "label": "Build computer", "folder": "/home/user/projects" }
  }
}
```

Keys match `hc machine ls`. Without the file, native names are shown (this computer reads "This computer", "This Mac" on macOS). `"tailscale": true` in the same file lists Tailscale peers from the local `tailscale status --json` every 15 seconds; those rows are passive and "online" does not mean SSH or Herdr is reachable. Registering a remote needs a noninteractive SSH connection (or a byte-preserving `--via` command) and a compatible `hc` there; for a Windows target enable OpenSSH Server, key authentication and a TCP 22 rule scoped to your Tailscale address, then `hc machine add user@TAILSCALE_IP --name HOST`.

## Message flow

There is no permanent message panel. A new send shows a sender → recipient notice for about four seconds; colours and lanes separate concurrent routes, and repeated sends keep their own packets with a grouped count. Unresolved queued/error/held deliveries stay in a compact footer row until resolved. Motion off disables travel.

The sidebar reads sends from the app's in-memory `messageEvents()` (see [Requirements](#requirements)); events carry sender, recipient, time and the observed `started` result, never message text. Send with the core CLI directly: `hc send TARGET "message"`.

**Removing the old tracing launcher.** Earlier versions shipped a Python launcher; it has been removed. If you installed it, remove `~/.local/share/herdr-sixfold/bin` from your PATH, stop calling `hc_trace.py`, check that `hc` resolves to the core CLI (`Get-Command hc -All` / `command -v hc`), restore a `~/.local/bin/hc` symlink that points at the launcher, delete `hc_trace.py`, `bin/hc` and `bin/hc.cmd` under `~/.local/share/herdr-sixfold/`, and update installed `herdr-theme route` and `herdr-theme collect-workflow`.

## Subagent trees and the workflow collector

Subagents expand under their parent with `▸ N`; new delegations open the tree and animate a pipeline. `herdr-theme collect-workflow` reads Claude metadata, the read-only Codex database and hc parent links into `data/sixfold/workflow.json` (`--once`, or every three seconds writing only changes). It runs on macOS, Linux and Windows (on Windows without opening console windows).

The installed native helper includes the collector, but does not register or start it in the background. For a one-time snapshot, run `herdr-theme collect-workflow --once`. Continuous collection scans local session records every three seconds and consumes resources; register it only if you need a continuously refreshed subagent tree. Stopping it leaves the last saved snapshot, not live subagent status.

On Windows you can run it at logon, hidden, one instance at a time:

```powershell
$home_ = "$HOME\.config\herdr-app"
$collector = "$home_\scripts\sixfold\herdr-theme.exe"
$command = "Start-Process -WindowStyle Hidden -Wait -FilePath '$collector' -ArgumentList 'collect-workflow'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $home_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Herdr Theme workflow collector'
```

Stop the task with `Stop-ScheduledTask`, verify that its `herdr-theme.exe collect-workflow` child has exited, then remove the registration with `Unregister-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Confirm:$false`. The hidden PowerShell launcher can leave its collector child running; stop only that identified collector, not other native helpers.

## Workspace Mods

These come from [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods) and are installed with the theme; each also works on its own (see that repository). The strip's helpers are native commands started by the mods; on Windows they run without console windows, and click-to-copy uses `Set-Clipboard` (macOS `pbcopy`, Linux `wl-copy`/`xclip`). Labels in the strip are Korean.

### System Metrics

![System Metrics](docs/images/system-metrics.png)

CPU and RAM of the computer the sidebar shows, with a bar of recent samples, refreshed every few seconds. A remote computer is read through `hc` on that machine. An unavailable reading shows as unavailable, never as zero.

### MCP Status

![MCP Status](docs/images/mcp-status.png)

One chip per MCP server from `claude mcp list` (and `codex mcp list`, merged by name): a state dot, a service-colour badge and a short name. Green = connected; an orange ring = needs sign-in or approval; red = failed; grey = unknown. It checks every three minutes, and again after 30 s, 1, 2 and 5 minutes when a server drops; the tooltip says when it dropped and recovered and how many running Claude sessions may need `/mcp`. Clicking a chip copies the sign-in step (`/mcp` or `codex mcp login <name>`) and never signs in by itself. Rename, re-icon or hide servers in `data/sixfold/mcp-status.local.json`. When the block is too narrow for every server, it shows those that fit — servers needing attention first — and counts the rest on a `+N` chip whose tooltip names them.

### CLI Status

![CLI Status](docs/images/cli-status.png)

Square tags for AWS profiles (one per profile, when the AWS CLI is installed), GitHub (`gh auth status`, account count per host), the kubectl context (no cluster connection is made) and the Docker daemon. Coloured when signed in or running, greyscale when expired, missing or stopped. Checks every four minutes, with the same drop rechecks; a click copies the login command. No tokens, user names or full account IDs are kept. Choose what to show in `data/sixfold/cli-status.local.json`.

### Plan Usage

![Plan Usage](docs/images/plan-usage.png)

Codex and Claude limits as brand icons, bars and percentages: 5-hour and 7-day windows, reset times and countdowns, model-scoped weekly windows when the provider reports them (`Fable 7d`), and `↺ N`, the Codex limit resets left, with a confirm-first button to use one. A Codex workspace that ran out of credits or hit its spend limit is shown even when the personal windows read low. Limits refresh every two minutes; when the provider rate-limits the check, the pill shows an error until the next successful read.

### Agent Usage

![Agent Usage](docs/images/agent-usage.png)

Token use of each live Claude/Codex session the core reports, grouped by workspace: the session total, uncached input / output / cache, this week's share and the model. A session is matched to its terminal on Windows through `~/.claude/sessions/<pid>.json` (Claude) or the rollout file its process holds open (Codex); an unmatched session shows `—`, not zero. It needs the Insights store (refreshed at most every five minutes) and lives in a layout pane, not an overlay. The theme's pane headers show the same session's model, speed, effort, permission mode and weekly share:

![Pane header](docs/images/pane-header.png)

The pane-header cat runs while the agent works, sits when it needs attention or has completed, and sleeps when idle. **Motion off** stops its animation. Model, effort, permission and usage labels describe the matched session; unknown usage is not inferred from the cat or another pane.

The header's weekly share is a price-weighted estimate from local session records. Its tooltip can apportion the provider's weekly usage approximately; it is not a separate remaining quota for that session. Account-level limits and reset times are shown by Plan Usage.

### Document Viewer

![Document Viewer](docs/images/document-viewer.png)

A project file tree and a preview panel for Markdown (and on macOS images, PDFs and local HTML as a read-only WebKit snapshot), with Source and Open. It installs into a layout with a Files panel and fetches its reviewed upstream (Preview Plus / Files Plus) at a pinned commit. On Windows HTML opens on its source, and its HTML tab says the preview needs the macOS renderer; Markdown preview and save-to-refresh work.

## Project documents

Expand the arrow beside a workspace to browse its configured document folders. Search filters filenames inside that workspace, Enter opens the first match, and **Cmd+Option+F** focuses the same search. Archive paths are hidden until requested; original documents are preserved. Configure sources in `data/sixfold/project-docs.json` or the document-tab rules in `data/sixfold/project-docs-pins.json`.

The optional **문서** tab is a terminal-free project document view, separate from the Files/Preview panel. It provides pins, grouped document lists, search and read-only Markdown previews. Installing it adds tabs to local workspaces while preserving existing development tabs and selection:

```sh
herdr-theme install-doc-tabs             # show a read-only plan
herdr-theme install-doc-tabs --install   # check/install the mod and add document tabs
```

Repeat `--install` after creating more local workspaces. Document rules are keyed by actual space ID; missing configuration is shown instead of guessed. Optional local document views use the producer contract described below. See [project document tracking](docs/project-documents.md) for source rules, supported previews and platform limitations.

## Optional local integrations

These displays consume files supplied by a separately configured local producer under the app home's `data/sixfold/`. They are hidden when no usable input is available. The producer owns task policy and action validation; installing the theme does not discover or install that tool. See the [integration contracts](docs/local-integrations.md).

**Workspace badges.** Other mods and tools can put up to four small badges beside a workspace name via shared state `sixfold.workspace.badges` or `data/sixfold/workspace-badges.json`:

```json
{ "<machine>|<space id>": [ { "id": "open", "text": "! 2", "tone": "blocked", "tooltip": "Two open items",
  "open": { "mod": "my-mod", "props": { "x": 1 }, "kind": "window", "key": "my-mod-x", "width": 800, "height": 600 } } ] }
```

`<machine>` is empty for this computer. Tones: `blocked`, `working`, `done`, `accent`, `dim`. A click opens `open` as that mod's overlay or runs `command`. Twelve characters each; malformed entries are ignored; shared state wins over the file. The theme publishes none itself.

**Question and permission cards.** An optional local tool publishes generic cards in `data/sixfold/cards.json` and its command prefix in `data/sixfold/bridge.json`. Buttons create a new JSON action file and pass only that file path to the configured command. The theme displays supplied titles, choices and actions; validation and execution belong to the external tool. Missing files keep the section hidden. See [local integrations](docs/local-integrations.md).

**Channel alerts.** New channel messages listed in `data/sixfold/project-alerts.json` appear on a line under the workspace title; the `sixfold-slack-inbox` mod shows mentions from `data/sixfold/slack-mentions.json` grouped by thread. Collecting from Slack is a separate tool.

**Local document views and session reports.** A producer can publish workspace document metadata in `local-views/workspaces/index.json` and display-only summaries in `session-reports.json`. Clicking a report can focus its terminal; reports do not close, resume or otherwise manage sessions. Task-tracking and lifecycle services are external integrations, not bundled theme services.

## Workspace controls

**Grids and new workspaces.** `herdr-theme balance-grid` equalises six-terminal tabs without restarting anything; `herdr-theme workspace "Example" /path` creates a workspace like **+ Space** with one coordinating session (`--shells` for a plain shell; `--tiers high` opens that one session on the model for the given task tier, default `high`, see `rust/src/automation/tiers.rs`). Additional panes can be created independently. Creating a workspace leaves the window showing what you were looking at: the selection is put back if the new space took it (a pane or tab you chose yourself is left alone). Known limit: if the creation fails midway and another process makes a terminal at the same moment that you then select, the earlier selection is restored over it.

**Pins, icons and local settings.** `data/sixfold/workspace-pins.local.json` (`{"spaces":[{"id":"…","machine":null}]}`) marks exact workspaces with a pin and accent border. `herdr-theme set-workspace-icon 'ID or name' icon.png` sets a project icon (SVG/PNG/JPEG/WebP). Per-person names, colours, folders and the Slack address live in `data/sixfold/site.local.json` (start from `config/site.example.json`); `"pane_header_index": true` brings back pane numbers. `*.local.json` is git-ignored.


Message routing between a common workspace and project slots: [COMMON_ROUTING.md](COMMON_ROUTING.md). Collaboration under overload: [docs/overload-collaboration.md](docs/overload-collaboration.md). Project document tracking: [docs/project-documents.md](docs/project-documents.md).

## What it runs

The UI uses Herdr's workspace/agent APIs. Native helpers run `hc`, `herdr-app` and account CLIs locally; installers run Git to fetch pinned releases. Existing provider-usage network requests remain in the native collectors. Optional external adapters use the command their owner configures. No private configuration, account data or session mapping belongs in this repository.

## Development

```sh
npm test
cargo test --manifest-path rust/Cargo.toml --locked --jobs 1 -- --test-threads=1
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

Run `sh scripts/install-git-hooks.sh` once per clone: every `git push` then runs the `node --check` lines, `cargo fmt --check`, `cargo test` and then `npm test` against the executable that `cargo test` built, and a failure stops the push (skip on purpose with `git push --no-verify`). The build output stays in `.git/prepush-target` between pushes and is emptied when it is over 8 GiB; pushes from the same clone run their checks one at a time (`.git/prepush-lock`; a lock left by a push that is no longer running is taken over). The macOS voice tests run by hand or weekly (`Voice (macOS)` workflow), not on every push.

`herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` next to a mod; do not commit them. Verify layout changes on the real screen, not only with tests. To move to a newer Workspace Mods release, change `commit` (and `tag`) in `workspace-mods.lock.json` and run the updater. Work on a short branch from `main`; the installed copy tracks `main`. [RECIPE.md](RECIPE.md) is the design brief. Apache-2.0.
