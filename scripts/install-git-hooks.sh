#!/bin/sh
# Make this clone's pre-push hook run scripts/pre-push (once per clone; worktrees share it).
# A pre-push hook that is not ours is kept as pre-push.local and runs first.
# A herdr-harness hook already runs scripts/pre-push itself, so it is left alone.
set -eu
hooks=$(git rev-parse --path-format=absolute --git-path hooks)
target="$hooks/pre-push"
mark='# prepush-tests hook'
mkdir -p "$hooks"
if [ -f "$target" ] && grep -q '# herdr-harness hook' "$target" && grep -q 'scripts/pre-push' "$target"; then
  echo "kept: $target (herdr-harness hook, already runs scripts/pre-push)"
  exit 0
fi
if [ -f "$target" ] && ! grep -q "$mark" "$target"; then
  [ -e "$target.local" ] && { echo "refused: both $target and $target.local exist; merge them by hand" >&2; exit 1; }
  mv "$target" "$target.local"
  echo "kept the existing hook as $target.local (runs first)"
fi
cat >"$target" <<'EOF'
#!/bin/sh
# prepush-tests hook: installed by scripts/install-git-hooks.sh
input=$(cat)
here=$(dirname "$0")
if [ -x "$here/pre-push.local" ]; then
  printf '%s\n' "$input" | "$here/pre-push.local" "$@" || exit $?
fi
top=$(git rev-parse --show-toplevel) || exit 1
[ -f "$top/scripts/pre-push" ] || exit 0
printf '%s\n' "$input" | sh "$top/scripts/pre-push" "$@"
EOF
chmod +x "$target"
echo "installed: $target"
