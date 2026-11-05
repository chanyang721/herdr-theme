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
| Installation, staged updates, verification and rollback | `rust/src/documents/{install,update,observers}.rs` |
| Idle-session and space observers, job evidence, resume stub | `rust/src/observers/` |
| Voice focus, submit policy, recovery, enrollment, VAD and offline evaluation | `rust/src/voice/` |
| Pinned usage, account CLI and MCP collectors | `rust/src/documents/pinned/` |
| Windows helper-lock compatibility | `rust/src/locking.rs` |

The pinned Workspace Mods source remains pinned by `workspace-mods.lock.json`. Its visual assets are installed with native command adapters; the native ports preserve the collectors instead of omitting their features. Native WebKit and Mermaid rendering still use the existing Swift helpers on macOS. Voice uses the same model assets through the sherpa-onnx C API and PortAudio, with native runtime libraries installed by its installer.

## Source inventory

The baseline contained 97 tracked Python files: 48 runtime files and 49 tests/tools. All are removed from the native release. Their replacements are the Rust modules above, frozen original-output corpora, and native filesystem/subprocess/PTY tests. The former extensionless `voice/focusq` entry point is a shell wrapper around the native command.

The [file-by-file inventory](native-migration-inventory.json) maps all 97 paths, the extensionless wrapper and the pinned external helpers to implementation and verification areas. It distinguishes fixture coverage from an original test executed end to end.

Workspace creation also incorporates the subsequent upstream focus changes through `fb3c2343843254ae7aee81fb6de3b014b7597d60`. Their additional Python test is tracked separately in the inventory. All ten original scenarios and 71 helper calls have frozen outputs, with native subprocess checks for successful creation, partial failure and concurrent selection. The upstream ambiguity for an ID-less failed creation and a concurrently selected new terminal remains documented and tested.

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

The default installed theme helpers use the native executable. User-owned resolver/renderer commands and an optional external prompt-card/lifecycle bridge remain configurable. A legacy custom Python script outside this repository still needs its owner's interpreter; it is an optional external adapter, not a bundled theme implementation. Native command arrays can be configured instead.

The native updater preserves staging, complete mod backups, status/focus verification, rollback and concurrent-writer protection. Moving to Git or Rust does not authorize an installation or restart. No running user application was updated during migration validation.

## Validation status

The frozen differential corpora and sandbox tests are in [`rust/tests/`](../rust/tests/) and module test sections. Their provenance is described in [`rust/tests/fixtures/README.md`](../rust/tests/fixtures/README.md). Expected values come from the original helpers at theme commit `8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8` and Workspace Mods commit `9aa50108fc3cc3c3af0fb376f0bb1760c90af3a6`. Personal paths in inputs were replaced with synthetic fixtures before recomputing original outputs.

Run the checks serially:

```sh
npm test
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
CARGO_BUILD_JOBS=1 cargo test --manifest-path rust/Cargo.toml --locked --jobs 1 -- --test-threads=1
node scripts/check-native.mjs
```

At this working checkpoint, Windows ran 178 native tests successfully, including five opt-in comparisons against unchanged original automation, RPC, icon/seed, embedded image and upstream workspace CLIs. They matched the relevant stdout, stderr, exit status, durable receipts, cache/file bytes and document mutations. The RPC comparison exposed an extra `children: null` field in native leaf nodes; the corrected implementation preserves absent keys and passes the original comparison. JavaScript ran 172 tests successfully with four macOS installer tests skipped. Removing the unused former decoder dependency was followed by another successful 125-test library run and executable build.

The real Windows speaker/VAD model comparison matched every VAD waveform float32 bit, embedding, and all 24 duration/threshold decisions in two configurations. Matrix, mean and voiceprint-build probes also matched with zero numeric drift and identical threshold masks. The native runtime uses the same hash-pinned OpenBLAS backend as the original NumPy implementation, including its exact threshold comparisons. After correcting convolution precision and PocketFFT selection, the full evaluation comparison matched all 28 model metrics with zero drift, VAD JSON/stdout, gate stdout for 384 synthetic scenes, and output-file bytes. Independent time and memory measurements are retained separately. Native libsndfile comparisons matched every float32 sample bit for 22 formats (including MP3), six rejected inputs, and nine Parquet identifier types. Native child processes had an empty PATH throughout these comparisons. See [offline model validation](../voice/docs/offline-model-validation.md) for immutable inputs and the test runners.

Linux and both macOS architectures still require CI execution. macOS CI explicitly exercises scratch-only installation and the actual Swift/WebKit renderers; ignoring those tests is not a pass. Physical microphone capture, Accessibility permissions, native credential stores and external-provider acceptance remain unverified. No running application, service or user installation was changed by these checks.

The [physical Mac checklist](../voice/docs/manual-macos-acceptance.md) binds later device evidence to the reviewed commit, executable and asset hashes. CI packages each tested executable in a tar archive with its commit/tree receipt, native dependency manifests and notices; the tar preserves executable permissions. CI results and physical-device results must be recorded separately.

The untouched original Windows suite ran 473 tests. With UTF-8 enabled it still had four failures, 44 errors and seven skips. The earlier default-encoding run had four failures, 59 errors and seven skips. Those baseline failures do not count as native equivalence passes. The per-case classification is recorded in [`native-baseline-windows.md`](native-baseline-windows.md); unresolved baseline approval-fixture behavior is kept separate from clear platform limitations.

The release gate also requires a successful native source inventory, all required platform CI, and independent review of the final commit. A scaffold, type-check pass or partial fixture corpus is not completion of the migration.
