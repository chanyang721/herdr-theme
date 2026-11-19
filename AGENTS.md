# Agent instructions

## Optional task feeds and extensions

Task allocation, review and cleanup policy are not part of this theme. The theme only
renders what an optional local producer writes (see [docs/panel-feed.md](docs/panel-feed.md),
[docs/task-lifecycle.md](docs/task-lifecycle.md) and [docs/local-integrations.md](docs/local-integrations.md)).
Keep those integrations behind generic extension points: `herdr-theme <name>` forwards to an
installed `herdr-theme-<name>` executable, the sidebar shows `sidebar-notices.json`, and
`site.local.json` holds machine-local names and presets. Do not add producer-specific
policy, names or private links to this repository. A response ending is not task completion.

## Performance rules

GPUI redraws the whole window on every frame while a loop, spin or frame cycle runs, and on every
`cx.notify` or `setShared`. `tests/motion.test.mjs` and `tests/cpu-guards.test.mjs` scan `mods/`
and fail with the fix to use; an allowlist entry needs a reason and is a last resort.

- Bound motion with `mods/sixfold-desk/motion.js` (brief windows), never a forever animation.
- Periodic work runs at 1000 ms or slower, skips while the window is hidden and never overlaps:
  use `createPoll` and `changeGate` from `mods/sixfold-desk/poll.js`, or a file subscription.
  A `timer.after` that schedules itself again is a periodic timer too, and is checked as one.
- Shared state from a timer or subscription goes through `createSharedPublisher`
  (`mods/sixfold-desk/shared-publish.js`) or a same-value check.
