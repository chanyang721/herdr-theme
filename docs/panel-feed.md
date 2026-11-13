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
0 is unstarted; stage 5 completes the task bar. The observed session `status`
is separate: a pane can still be working after its last task reached stage 5.
A changed stage or a new
event replaces that bar with a label for about 2.5 seconds without moving the task
title. Initial history is not replayed. A message and a task event share one pixel-art
packet: a 1px right-angle line with stepped one-pixel corners and a 3x3 block
without tail or glow, on whole device pixels at any zoom. Both travel for 2.4
seconds and open a square 1px ring at departure and arrival. All lines occupy the same 72px gutter:
message lanes run 20px and 24px beyond the card, stationary purple links
use 30px, and remote-computer pipes start at 40px with 8px spacing. Explicit
row endpoints stay on their rows; space-wide endpoints use their headers.
Two message lanes stagger bursts, with at most eight scheduled routes. A send
past those eight is not dropped silently: it joins one **메시지 +N** bundle for
its sender and receiver, which travels after the queued sends (a later send never
overtakes it) and tags the sender row with the count. At most eight bundles wait
at once, counting bundles that have already arrived and are still pinging or
fading, each keeping the IDs of at most 32 sends; sends past that are only
counted, so memory stays bounded. A correction (`animate: false`, or a lost
endpoint) takes its send back out of the bundle, before or after it starts: the
count drops, and a bundle with nothing left is not drawn. A message
whose `from` is not an agent row (no caller, or only its space or computer) is
never drawn as an agent's send: its receiving row reads **← 발신 미확인**. Native
interpolation uses finite targets rather than a JavaScript frame loop. A remote
packet follows its computer-coloured dashed pipe, and its receiving row briefly
shows that computer's name. Motion off omits message lines and packets while
counts and receiving-row information still update. Unknown endpoints are skipped.
Optional `animate: false` retains supplied labels but suppresses packets and
connections. Initial history and hidden-window backlogs are never replayed. Dashed routes identify
cross-computer sharing: a whole space uses a hollow square, and one shared agent
uses a filled circle. Same-task agent brackets are stationary gray solid lines.
An explicit `links` entry with `kind: "collaboration"` and two space IDs in `a`
and `b` connects distinct spaces on the same known computer. These partners show
each other's names and a stationary purple solid bracket with hollow square
endpoints. Names, bundle IDs and messages alone never create a partnership.

Issue groups and flat rows sort blocked, working, review, waiting and done.
Within a state, producer ordering is preserved. Issue groups never fold: every
issue the producer lists (all issues to work on) is drawn, each with its panes
right under it, and there is no issue **+N** row. A space takes up to 512 issues.
Agents inside an issue are not truncated. Explicit
`parent_id` relationships form trees within the same issue. More than three child
branches show three and their own **+N**. Child rows use a compact status dot,
without another stage bar. Agents without an issue follow the issue groups.
The supplied `title` is the current task or subtask work name; role, session or
workspace labels should be used only when that work name is unavailable.
An explicitly completed child (`status: done`, without blocking state) is
removed before tree projection and does not count toward **+N**. Stage 5 alone
does not remove a child whose producer status remains idle or working.
Active descendants remain visible. Different issue/space bindings remain
independent roots, with their own completion and closing lifecycle. A newly
allocated row first shows a dotted placeholder; its content appears at packet
arrival, or immediately when motion is off.
Explicit closing data uses four teal stages. Its final label remains briefly
before the row disappears; a supplied blocking reason keeps the row visible.
Optional closing `memory` data distinguishes pending storage, saved memory and
proposals; a separate memory event carries its packet to the workspace badge.

Optional agent `state` names one of seven row states: `working`, `idle`,
`needs_human`, `unseen_result`, `cleanup_wait`, `closing` or `closed`. Each has
its own shape (dot ring, empty ring, diamond with `!`, check, moon, open box,
closed box), so colour is never the only difference; motion off shows still
frames. A row without a known `state` keeps the four-status mark. Optional
`keep_reason` is one producer sentence on why the session stays open or when it
closes, retained verbatim in the row tooltip. Rows stay compact instead of
adding a second line for every reason. Optional `cleanup`
(`{idle_since, limit_s, due_at}`, absolute times) adds a countdown to
`cleanup_wait` and `unseen_result` rows: the sidebar counts the remaining
minutes on its own clock and redraws only that row once a minute. After
`due_at` it reads "다음 정리 때 닫힘". All three fields are display data only;
the sidebar never decides whether a session is kept or closed.

Policy acceptance, role completion and physical removal are separate. A last
pane can finish recording and learning while its row remains visible; space
cleanup is a separate producer operation. See the
[cross-repository lifecycle contract](workflow-lifecycle.md) for the field
mapping and verification matrix.

A row whose `state` is one of the cleanup states also carries a short label in
its stage slot, so the cleanup progress reads without hovering and the row
stays one line: `cleanup_wait`, and `unseen_result` with a `cleanup` timer,
→ **정리 대기** with the minutes (or hours) left
until `due_at` on the sidebar clock, and no time once it has passed; `closing`
step 1 (close requested, the session is saving its report) → **보관 중**;
`closing` steps 2 and 3 (report saved, or a memory proposal pending; the pane
closes next) → **닫는 중**; `closed` → **닫힘**. The label takes the slot the
stage segments use, at the same width, and an event tag still takes precedence.
A closing with a `blocked_reason` and a feed without `state` get no label.

The Linear/Jira metadata opens a native right-side issue popover. Its three tabs
read `issue_catalog.week`, `.milestone` and `.all`; search filters those local
lists. The producer supplies the workspace's current-week and explicitly selected
issues in `spaces[].issues`. Natural week items stay included. The popover sends
explicit per-issue requests through the fixed `panel-issue-requests` directory
beside the selected feed, using a unique file per request. Producer results match
the request ID and report local inclusion or rejection. Opening or searching the
popover never sends an external service request. Only one space's popover is
open at a time; search and pending-selection state remain local to each space.
An optional `work.url` enables the explicit **open in tool** action. Only a
provided HTTP(S) URL without embedded credentials is accepted; no URL is guessed
from an issue key. Without it the footer states that the link is unavailable.

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
