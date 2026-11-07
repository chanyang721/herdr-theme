# Native helper migration

The theme's helper implementation is in [`rust/`](../rust/). The JavaScript/GPUI views and their retained state remain in `mods/`. The native command is `herdr-theme <helper> [arguments]`; helper names keep their former script stems, and hyphens are accepted in place of underscores.

Build with a stable Rust toolchain and a C compiler:

```sh
CARGO_BUILD_JOBS=1 cargo build --manifest-path rust/Cargo.toml --locked --release --jobs 1
```

On Windows use the MSVC Rust toolchain with its C/C++ Build Tools, or a complete GNU-compatible toolchain. The executable is `rust/target/release/herdr-theme.exe` on Windows and `rust/target/release/herdr-theme` elsewhere. SQLite, compression and the vendored FFT adapter compile locally; no Python interpreter is needed to build the native helper.

## Implementation map

| Former area | Native implementation |
| --- | --- |
| Agent environment, workspace creation, model tiers, grids, JSON-RPC | `rust/src/automation/{mod,tiers}.rs` |
| Project routing, durable holds, collaboration leases and aggregation | `rust/src/automation/{routing,collaboration}.rs` |
| Subagent lifecycle collection and process/session identification | `rust/src/automation/workflow.rs` |
| POSIX TUI relay and escape-sequence boundaries | `rust/src/automation/bridge.rs` |
| Local and remote system counters | `rust/src/automation/metrics.rs` |
| Document catalog, routing, pin resolution and opening | `rust/src/documents/{catalog,routing,pins}.rs` |
| HTML/Mermaid cache control, media metadata and desktop actions | `rust/src/documents/render.rs` |
| Installation, staged updates, verification and rollback | `rust/src/documents/{install,update}.rs` |
| Explicit disposable UI/process probes | `rust/src/observers/native*.rs` |
| Voice focus, submit policy, recovery, enrollment, VAD and offline evaluation | `rust/src/voice/` |
| Pinned usage, account CLI and MCP collectors | `rust/src/documents/pinned/` |
| Windows helper-lock compatibility | `rust/src/locking.rs` |

The pinned Workspace Mods source remains pinned by `workspace-mods.lock.json`. Its visual assets are installed with native command adapters; the native ports preserve the collectors instead of omitting their features. Native WebKit and Mermaid rendering still use the existing Swift helpers on macOS. Voice uses the same model assets through the sherpa-onnx C API and PortAudio, with native runtime libraries installed by its installer.

## Source inventory

The baseline contained 97 tracked Python files: 48 runtime files and 49 tests/tools. All are removed from the native release. Their replacements are the Rust modules above, frozen original-output corpora, and native filesystem/subprocess/PTY tests. The former extensionless `voice/focusq` entry point is a shell wrapper around the native command.

The [file-by-file inventory](native-migration-inventory.json) maps all 97 paths, the extensionless wrapper and the pinned external helpers to implementation and verification areas. It distinguishes fixture coverage from an original test executed end to end.

Workspace creation also incorporates the subsequent upstream focus changes through `fb3c2343843254ae7aee81fb6de3b014b7597d60`. Their additional Python test is tracked separately in the inventory. All ten original focus scenarios and 71 helper calls have frozen outputs, with native subprocess checks for successful creation, partial failure and concurrent selection. The upstream ambiguity for an ID-less failed creation and a concurrently selected new terminal remains documented and tested.

| Baseline runtime files | Replacement |
| --- | --- |
| 37 files under `scripts/` | 30 helper command stems plus seven imported APIs in `automation/`, `documents/`, `observers/`, and `locking.rs` |
| 10 files under `voice/` | Seven helper command stems plus the backend, policy and settings APIs in `voice/` |
| `extras/system-metrics/mods/system-metrics/sample.py` | `herdr-theme system_metrics` |
| Pinned agent-usage, plan-usage, CLI-status, MCP-status and system-metrics Python helpers | `pinned_*` native adapters; installation omits upstream Python files and rewrites their bundled JavaScript commands |

Library-only modules still expose their Rust APIs and have the same no-op direct invocation behavior. The three manual native UI probes use `native_collaboration`, `native_doc_tabs`, and `native_ui_reload`. Voice diagnostic/evaluation tools retain their original stems and also accept the documented `voice_*` aliases.

The remaining interpreter references are confined to explicit user-owned external command adapters, migration recognition of old settings, pinned-source provenance, and isolated validation references. They do not install a Python runtime or invoke a theme-owned Python implementation. `node scripts/check-native.mjs` checks the tracked release inventory, including extensionless shebangs.

Native numerical dependencies retain their licenses and immutable provenance: [OpenBLAS carriers](../voice/native-blas-assets.json), [model and C API assets](../voice/tests/model-probe-assets.json), and the [PocketFFT source manifest](../rust/vendor/pocketfft/provenance.json). PocketFFT is the exact revision used by the pinned SciPy 1.16.0 reference; its C++ adapter preserves the original mixed float32/float64 convolution. See [native BLAS](../voice/docs/native-blas.md) and [evaluation equivalence](../voice/docs/offline-evaluation-validation.md).

## Compatibility and external commands

Implementation responsibilities follow the four domains above. Shared command
construction, byte serialization, lock primitives and error/exit handling live
in common modules. Dictation, updater transactions and workflow identification
each have one production body with injected device/process/clock boundaries for
the original tests; the tests do not maintain a second implementation.

Similar-looking operations retain separate policies when their contracts differ:
checked versus unchecked SDK calls, locale versus explicit UTF-8 text, JSON
spacing, explicit versus unbounded deadlines, and atomic replacement versus
in-place writes through a symlink. Combining those policies would change behavior.

Remaining structural debt includes the large lifecycle and installer modules
and several domain-specific IO facades. These are explicit future refactoring
areas, with the original-case correspondence table as their regression baseline;
they are not additional release gates.

The default installed theme helpers use the native executable. User-owned resolver/renderer commands and an optional external local-card bridge remain configurable. A legacy custom Python script outside this repository still needs its owner's interpreter; it is an optional external adapter, not a bundled theme implementation. Native command arrays can be configured instead.

The native updater preserves staging, complete mod backups, status/focus verification, rollback and concurrent-writer protection. Moving to Git or Rust does not authorize an installation or restart. No running user application was updated during migration validation.

## Validation scope

The retained original behavior mappings are in [the inventory](native-original-tests.md).
Automatic session lifecycle policies, service installers and their dedicated tests
are maintained outside this release. They are not executed or counted here.
The original source snapshots moved with that implementation for comparison.

General document, workspace, updater, usage and voice cases remain in this tree.
Local view and card tests now exercise the neutral producer protocol, including
missing-file behavior, path containment, revision changes and configured commands.
Test receipts must identify the tested commit and platform. Historical migration
counts do not describe the current release; ignored cases are not passes.
