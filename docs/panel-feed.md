# Local task display

The sidebar can render a local version 1 panel feed. Shared native folder-change
notifications deliver updated display data; it does not derive task stages, connect to issue trackers, send
messages, accept work, or close sessions. Those operations belong to the feed
producer. Without a valid feed, the existing workspace sidebar remains available.
The **목록** button returns to the normal workspace navigator; **작업** opens
tracking again. Cards and rows navigate only through explicit `nav.space_id`
and `nav.pane_id` targets, including their supplied machine. Missing targets are
disabled. Opaque display IDs are never guessed into navigation targets or shown
as native addresses in tooltips.

The file is `data/sixfold/task-feed.json` below the app home. No other producer
directory is searched. Repeated snapshots preserve the event watermark. The
native `herdr-theme panel-feed --path FILE` command reads at most
2 MiB and reports `ready`, `missing`, or `invalid`, plus the producer's supplied
`reduced_motion` preference. It does not query or change system settings.
Interrupted writes and read failures preserve the last valid display; an
unchanged data timestamp is not treated as a disconnected producer.

The display contract contains `v`, `at`, `computers`, `spaces`, `links`, and
`events`, and optional `reduced_motion`. IDs and bundle IDs are opaque. Computer traffic can be `null` when
unmeasured. Optional `traffic.unit: "deliveries"` identifies confirmed delivery counts, not bytes or network rates. Spaces provide their sharing mode, optional Slack and work-tool
labels, issue groups, memory proposal count, and agent rows. Unknown fields and
versions are ignored. Each space names its `computer` ID. Unknown traffic and
unconnected tool fields remain visibly unmeasured or disconnected. No command
or executable supplied in a feed is run.

Agent stages 1–4 fill the distribution, work, review and acceptance slots. Stage
0 is unstarted; stage 5 shows a check without a bar. A new event briefly replaces that bar
with its supplied label without moving the task title. Initial history is not
replayed. A newly observed message gets a bright eight-pixel packet and fading tail along a right-side Bezier arc, with square departure and arrival pings. A reserved 72px gutter separates messages from stationary purple collaboration brackets and outer computer dashes. Arc width scales with row distance within that gutter; upward sends curve upward. Two message lanes stagger bursts, with at most eight scheduled routes. Native interpolation uses eight finite curve targets rather than a JavaScript frame loop. Known remote endpoints project only to their explicit computer anchor; the packet curves toward its dashed lane and follows it. Unknown endpoints are skipped. Optional `animate: false` retains static labels but suppresses packets and connections. Initial history and hidden-window backlogs are never replayed. Dashed routes identify
cross-computer sharing: a whole space uses a hollow square, and one shared agent
uses a filled circle. Same-task agent brackets are stationary gray solid lines.
An explicit `links` entry with `kind: "collaboration"` and two space IDs in `a`
and `b` connects distinct spaces on the same known computer. These partners show
each other's names and a stationary purple solid bracket with hollow square
endpoints. Names, bundle IDs and messages alone never create a partnership.

Issue groups and flat rows sort blocked, working, review, waiting and done.
Within a state, producer ordering is preserved. More than four issue groups show
three and an expandable **+N**; agents inside an issue are not truncated. Explicit
`parent_id` relationships form trees within the same issue. More than four child
branches show three and their own **+N**. Child rows use a compact status dot,
without another stage bar. Agents without an issue follow the issue groups.
The supplied `title` is the current task or subtask work name; role, session or
workspace labels should be used only when that work name is unavailable.
An explicitly completed child (`status: done` or `stage: 5`, without blocking
state) is removed before tree projection and does not count toward **+N**.
Active descendants remain visible. Different issue/space bindings remain
independent roots, with their own completion and closing lifecycle.
Explicit closing data uses four teal stages. Its final label remains briefly
before the row disappears; a supplied blocking reason keeps the row visible.
Optional closing `memory` data distinguishes pending storage, saved memory and
proposals; a separate memory event carries its packet to the workspace badge.

The Linear/Jira metadata opens a native right-side issue popover. Its three tabs
read `issue_catalog.week`, `.milestone` and `.all`; search filters those local
lists. The producer supplies the workspace's current-week and explicitly selected
issues in `spaces[].issues`. Natural week items stay included. The popover sends
explicit per-issue requests through the fixed `panel-issue-requests` directory
beside the selected feed, using a unique file per request. Producer results match
the request ID and report local inclusion or rejection. Opening or searching the
popover never sends an external service request.

Optional issue fields `week`, `pinned` and `milestone_id` preserve the producer's
selection. Milestone metadata supplies its name, optional `YYYY-MM-DD` due date
and a numeric progress percentage from 0 to 100. Missing dates or progress are
left blank. Per-scope cache metadata distinguishes stored, stale and uncollected
lists; it does not claim the external service is currently connected.

A request is a local selection change:

```json
{"v":1,"id":"request-demo-1","space":"s-0000000000000001","tool":"linear","keys":["DEMO-12"],"action":"import"}
```

`action` defaults to `import`; `remove` clears an explicit selection. Natural
week items cannot be removed. A producer rejection with `code: "weekly_required"`
explains that restriction. Results retain `status: "imported" | "rejected"`;
a successful removal uses `action: "remove"`, `code: "removed"`. Each filename
is reserved exclusively, then its empty reservation is atomically replaced with
the complete JSON. Producers must retry empty or incomplete files without
acknowledging or deleting them. Request IDs let producers prevent duplicate
processing when the same request is observed again.

`sixfold.motion = false` or a supplied `reduced_motion: true` removes loops
and packet movement while labels, counts and state still update. On systems
where the producer cannot read the preference, it supplies `null`.
On hosts with `window().visible`, the existing command receiver handles
`window.visibility` immediately, including hidden copies. It cancels motion
timers and memory sampling, retains the latest snapshot, and resumes without
replaying hidden messages. Windows reports visible/non-minimized state; full
coverage by another window is not detected. Focus is independent of visibility.

The file adapter shares a native watch per root across copies and windows. The
SDK batches changes for 150 ms. Hash-identical data retains parsed values and
derived groups. The new panel retains native space and agent entities; a title
change invalidates its row rather than recreating the list. The normal workspace
navigator also retains its workspace cards. A native command delivery resumes
each receiving copy in its own application context before updating its entities.

Hosts exposing `herdr.readJsonFile` perform bounded reads, metadata/hash caching,
and JSON parsing in a native worker. On older hosts a compatibility reader uses
`readTextFile` and parses changed text in JavaScript; its diagnostics explicitly
report `backgroundJson: false`. This fallback does not satisfy an off-UI parsing
guarantee. There is no recurring file-read poll.
Missing optional files use `read_error` with `errorKind: "not_found"`; other read
errors preserve the last valid state. Configured external card directories share
one additional watch per distinct root. Pending snapshots coalesce by subscriber;
directory changes retain a bounded union of paths. Unsubscribing releases queued
values immediately.

`tests/panel-fixtures.mjs` supplies the same 24 sharing/tool/Slack combinations
to model, renderer and isolated native screenshot checks. It also supplies
dispatch, spawn, message, review, verdict, acceptance, closing and memory
transitions. All example identities and task names are synthetic.
See the [native gallery and validation measurements](panel-validation.md).
