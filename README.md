# Herdr Theme

A workspace sidebar and terminal layout for Herdr. Follow coding agents, shared projects and messages across computers, with tools and usage limits beside your terminals.

[한국어](README.ko.md)

![Herdr Theme: workspaces, agent states and messages in the native Windows app](preview.gif)

Recorded in the native Windows app with synthetic projects, tasks and message events. [Still image](preview.png).

## Features

- **Computers and workspaces:** per-computer agent counts, shared-project indicators, unread messages and animated message routes.
- **Tasks:** optional local feeds add task trees, progress stages, issue groups, review events and seven animated pixel-art states. The feed producer manages the work; the theme displays it.
- **Terminal headers:** agent state, model, effort and session usage, with an animated cat and a motion-off option.
- **Monitor strip:** CPU/RAM, MCP connections, CLI sign-in state, Claude/Codex plan limits and session tokens, supplied by the pinned [Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods) release.
- **Documents:** workspace search, pins and a document tab; an optional file viewer previews Markdown beside your terminals.

## Install

Requires Herdr 0.1.11+, a compatible herdr-core, Git, stable Rust and a C compiler. Windows builds need MSVC C/C++ Build Tools or a complete GNU-compatible toolchain.

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
```

macOS / Linux:

```sh
./rust/target/release/herdr-theme install
herdr-app do layout.switch --name sixfold
```

Windows PowerShell:

```powershell
.\rust\target\release\herdr-theme.exe install
herdr-app do layout.switch --name sixfold
```

The installer adds the theme and pinned Workspace Mods under `~/.config/herdr-app` (`HERDR_APP_HOME` overrides it). It preserves other layouts and settings and refuses to overwrite an existing installation. Use `--update` to refresh a previous install while preserving edited layouts and palettes. See the [compact Windows layout](extras/windows-layout/README.md) for smaller windows.

For later changes, build the reviewed source and use the updater, listing the files to install:

```sh
herdr-theme update-install mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

Use the built executable's path if it is not on PATH. The updater checks affected mods, backs up installed files and verifies app health without restarting the app or core. [Native helper and update details](docs/native-rust-migration.md).

## Support and setup

The sidebar and monitor strip support macOS and Windows. Linux has native helper support; its desktop UI has not been verified. Voice and HTML snapshots require macOS. Message animations require compatible app/core message events. Agent Usage needs the separately installed [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights) mod and its local store.

Remote connections, agent credentials and optional task producers are configured separately. No task service is installed with the theme. Local customizations belong in git-ignored `*.local.json` files; start with [site.example.json](config/site.example.json).

| More detail | Guide |
| --- | --- |
| Tasks, stages and state images | [Feed contract](docs/panel-feed.md) · [Native UI gallery](docs/panel-validation.md) |
| Documents, search and pins | [Project documents](docs/project-documents.md) · [File viewer](extras/preview/README.md) |
| Badges, question cards and reports | [Local integrations](docs/local-integrations.md) |
| Layout and platform options | [Monitor strip](extras/monitor-layout/README.md) · [Windows](extras/windows-layout/README.md) · [Voice](voice/README.md) |

## Development

```sh
npm test
cargo test --manifest-path rust/Cargo.toml --locked --jobs 1 -- --test-threads=1
```

Run `sh scripts/install-git-hooks.sh` once per clone to enable pre-push checks. Validate changed mods with `herdr-app check <mod-folder>` and inspect them in the app. [Design brief](RECIPE.md) · [Apache-2.0](LICENSE).
