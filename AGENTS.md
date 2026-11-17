# Agent instructions

## Herdr harness workflow

For harness allocation, collaboration, review, lifecycle cleanup, knowledge reuse,
and issue/panel synchronization, read [docs/harness-workflow.md](docs/harness-workflow.md) first.
Use the shared `HERDR-WORKFLOW-1` contract and record verification evidence;
a response ending is not task completion. Preserve the other repository rules.

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
