#!/usr/bin/env bash
# One-shot voice setup on a Mac from a Herdr Theme checkout: tools, plugin,
# F8 key, Codex focus, voice gate. Extra arguments go to the native installer
# (e.g. --enroll); run it in a shell pane so enrollment can read the terminal.
#   bash voice/install.sh [--enroll]
set -euo pipefail

[ "$(uname)" = Darwin ] || { echo "macOS 전용입니다." >&2; exit 1; }
command -v brew >/dev/null || { echo "Homebrew 가 필요합니다: https://brew.sh" >&2; exit 1; }
for tool in herdr portaudio; do
  command -v "$tool" >/dev/null || brew install "$tool"
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/../rust/target/release/herdr-theme"
[ -x "$BIN" ] || { echo 'Build first: CARGO_BUILD_JOBS=1 cargo build --manifest-path rust/Cargo.toml --release' >&2; exit 1; }
exec "$BIN" voice_install "$@"
