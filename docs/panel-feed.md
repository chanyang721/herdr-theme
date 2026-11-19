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

### Optional repository activity

An optional `repo_activity` object embeds the generic `repo_activity_v1` display
DTO. Its `schema`, `accounts`, `repositories`, `bindings`, `events` and `coverage`
fields are described in the panel schema. This extension only displays supplied
metadata. It does not read Git, query GitHub, discover accounts, install hooks,
open connections or enable collection. An absent/unsupported extension leaves
the original sidebar unchanged. Producer integration is a separate step.

The native sidebar shows a fixed GitHub catalog **below its workspace cards**.
Account and repository order comes from the producer's explicit configuration;
local discovery can assist that configuration but must not silently add nodes.
`accounts` supplies approved display names, personal/company classification,
connection state and source (`private_catalog` or `explicit_probe`). Configured
accounts stay `unknown`; connected/disconnected claims require `explicit_probe`.
An account mapping is independent of a repository's remote namespace. Namespace
does not identify an authenticated user or the person who pushed.

`repositories` contains opaque `id`, `account_id`, `namespace` and `name` fields.
One case-insensitive namespace/name slug has one node. The first duplicate wins;
bindings to a discarded ID become unknown, never silently reassigned. Different
worktrees of the same repository retain separate session bindings to that node.
`bindings` names an explicit `agent_id`, `repository_id` and `state`: `cwd` draws
a stationary folder relationship, `local` means a Git folder without a remote,
`unlinked` means outside the configured catalog and `unknown` means unconfirmed.
The last three have separate visible counts and no invented route. A cwd edge
proves only the observed process-folder relationship. It is not authorship, all
edited files, the current task or a later `git -C` operation's target.

The v1 DTO contains no branch/ref observation. Each node therefore shows `main ?`
(local main not observed). The tooltip distinguishes local main, remote status
and evidence source. A configured name is not a local or remote HEAD receipt.
No raw cwd, remote URL, command, commit message, output, credentials or private
catalog format belongs in this extension. Unknown properties are dropped by the
consumer. Recognizable credential/path-like labels are rejected; this does not
detect arbitrary secrets disguised as approved display names. Producers must
provide only approved metadata.

Events retain `id`, `operation_id`, `machine_id`, nullable verified `agent_id`,
`repository_id`, normalized `operation`, `phase`, `result`, `evidence` and integer
Unix-seconds `observed_at`. Sender attribution must be supplied by the producer;
the theme never guesses it from cwd or from the payload's machine ID. The phase
and evidence combinations are strict:

| Evidence | Phase/result | Display meaning |
| --- | --- | --- |
| `pre_tool` | `attempt` / `unknown` | Before execution; not proof the command ran |
| `post_tool` | `result` / `unknown` only | Observed after execution; result unconfirmed |
| `approval` | `authorization` / `unknown` | Approval only; no result or moving success |
| `process_exit` | `result` / `succeeded` or `failed` | Command exit result only |
| `head_verified` | `result` / `succeeded`, `merge` only | Verified local merge |
| `timeout`, `sensor_error` | `result` / `unknown` | Result remains unconfirmed |

`post_tool` is provider-neutral: a tool callback reported the call after it ran.
A callback name, an error flag or a missing exit field is not an exit code, so
this version accepts only `unknown`. `post_tool` with `succeeded` or `failed` is
dropped like any other invalid combination; allowing those results needs a later
contract version with its own exit fixtures. It renders `실행 후 · 결과 미확인`, a
muted label without a packet, and never replaces `process_exit`. A consumer
without `post_tool` drops only that event; a schema validator built from an
older copy of this schema rejects the whole feed, so producers should emit it
only to consumers known to include it.

The latest supplied event stays as a historical label. A push command's success
does not imply a separately observed remote ref, CI, deployment-system result or
service health. This version supplies no latter-stage evidence and renders no
deployment-success effect. Read-only status/diff/log/show are not activity events;
all declared mutation kinds share this renderer. Uninstrumented commands and
missing sources remain explicit coverage gaps rather than fabricated events.

Known visible agent rows connect to repo rows through the existing 48px gutter.
Static cwd edges are quiet. New confirmed command/local results use a 3px packet
with a finite 2.84-second lifetime. Unknown results and missing/hidden endpoints
never acquire a moving route. Motion off and producer reduced motion keep labels
and folder edges, consume the watermark and stop packet timers. Hidden updates
are consumed without a backlog on reopening. Event corrections/removal withdraw
an existing effect. No recurring timer, frame loop, filesystem scan or subprocess
is added. Bounds: 64 accounts, 256 repos, 128 bindings, 128 events, eight active
effects and a 2,048-ID watermark. Excess effects are consumed, not replayed later.
The existing 2 MiB feed limit still applies. Live installation, native screenshot
verification and cross-machine collector/transport integration are distinct from
the portable renderer and fixture checks.

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

Only the issue tracker's own status hides an issue row; who sent the work never
does. The kind comes from `status_type` first, then `closed`, then the `status`
name (a space issue sent without any of them takes its catalog row's). A
started issue (In Progress, In Review) stays in the list. A finished one
(completed, canceled, duplicate) leaves it; when its optional `done_at` (a
`YYYY-MM-DD` day or an ISO time) falls on this computer's current day it waits
in a folded **오늘 마무리 N** row at the end of the card, which expands on a
click, otherwise it is only hidden. A not-yet-started one (todo, backlog,
triage) shows only while one of its panes works. A pane that is working, drawn
as blocked (blocked status, missing report, error, blocked closing) or waiting
for a person (`needs_human`, `unseen_result`, `wait_kind: input`) keeps its
issue on screen whatever the status, and is never folded away. An issue without
a status stays visible, as before. The issue row's label counts the working
panes under it (**작업 중 N**); with none it reads **쉬는 중**, even when the
producer's issue `state` still says working. The fold is recomputed just after
local midnight.

Two changes reach feeds without any of the new fields too. Issues sort by what
their panes do now: one whose `state` is working but has no working pane sorts
with the waiting issues, and a waiting one with a working pane sorts with the
working ones. A pane whose `issue` the space does not list but whose
`issue_catalog` has that key sits under its own issue row, built from the
catalog, instead of under 이슈 없음.

Optional agent fields place and describe a row. `own_issue` (string or `null`)
is the issue the task owns itself rather than one borrowed from its parent task;
a row sits under its `own_issue`, else under `issue`. A row whose `own_issue` is
explicitly `null` and which has a `parent_id` stays under its parent, folded
behind the parent's **+N 하위 작업 · 이슈 미확인** row until the parent is
expanded. An issue an agent names that the space does not list is drawn from
the `issue_catalog` row of the same key (title and status); an explicit
`own_issue` the catalog does not know gets a key-only row, and a plain `issue`
nothing knows keeps the earlier placement under 이슈 없음. `role`
(`implement`, `review`, `integrate` or `null`) draws a **구현**, **검수** or
**통합** chip before the title, so a review row that kept the original task
title still reads as a review. `issues` (up to 20 keys, the shown one first)
lists every issue the session holds: the row stays under its current issue and
shows **+N 이슈**, with the full list in its tooltip; held issues the catalog
knows also get their own issue rows under the same status rules. Below 300px
the role and held-issue count share one shrinkable chip (**검+1**) and the title
keeps a minimum width; the full role and list stay in the tooltips. Without
these fields the rows keep their earlier placement.

An agent may also supply `profession: {"id":"custom-discipline","label":"QA"}`.
This is generic display metadata, independent of the operational `role`; no
profession catalog or implied role exists in the theme. `id` is a
1–80 character string without whitespace or ASCII control characters. `label`
is 1–48 characters of plain text, without leading/trailing whitespace or ASCII
control characters. Extra fields or malformed values drop the whole extension.
The label is rendered through a text child, never interpreted as markup or code.
It takes the existing role chip in both wide and narrow panels (below);
long text truncates, the tooltip retains the complete label, and the narrow task
title keeps its minimum width. Without valid metadata, existing role rendering
is unchanged. The theme does not infer profession from titles or read any other
source. Updates/removal follow the existing feed normalization and retained
projection; there is no additional timer or data collection.

[`schemas/herdr/panel-feed.schema.json`](../schemas/herdr/panel-feed.schema.json)
describes the compatible feed envelope and this optional `$defs.agent` extension.
Other existing fields remain open in that schema and retain this document's
display contract. Invalid optional metadata is discarded by the consumer rather
than invalidating otherwise usable rows.
A lead row (2026-11-19) carries `coordinator: true`; which rows lead is the producer's
choice, and the theme infers none. A row may also carry `role_group: {"id":"lead","label":"LEAD"}`,
a short display group with the same bounds as `profession`. The chip names a valid `profession`
first (a 2–4 letter lowercase id reads as its uppercase id, so `ops` reads **OPS**; any other id
shows its label), else `role_group`'s label, else the operational role as before
(**구현**·**검수**·**통합**, narrow **구**·**검**·**통**). The operational role stays in the chip
colour and the tooltip. Lead rows, with every row under them (`parent_id`) as their own tree
(a finished sub-task leaves), are taken out of every issue group and listed first, flat, right
under the Slack/Linear line, then one issue gap. A row under a lead stays in the lead's tree
even when it names its own issue. Their order, set and folds are part of the retained layout
key. Malformed values drop the field only.

A space may carry `role_group: {"id":"…","label":"…"}` (2026-11-19), with the same bounds as
`profession`: what the whole space is, as the producer names it. The card header shows the label
as one chip beside the space name (the name shrinks first, the chip truncates, the tooltip keeps
the full label). Its rows are unchanged. Malformed values drop the field only.

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
adding a second line for every reason. Optional `wait_kind` supplies the compact
status-slot category: `status`, `conversation`, `last_pane`, `pinned`, `in_use`,
`review_pending`, `report_delivery`, `identity`, `review`, `acceptance`, `report`,
`input` or `cleanup`. `active` preserves ordinary progress without a waiting
label. The producer classifies its own evidence; the theme never interprets
reason text. Unknown or missing categories with a reason show **상태 확인** and
keep the full tooltip. This field is display-only and grants no action authority.
When upgrading a producer/consumer pair, update the producer to emit `wait_kind`
first, so ordinary progress retains its category during the consumer upgrade.
Optional `cleanup`
(`{idle_since, limit_s, due_at}`, absolute times) adds a countdown to
`cleanup_wait` and `unseen_result` rows: the sidebar counts the remaining
minutes on its own clock and redraws only that row once a minute. After
`due_at` it reads "다음 정리 때 닫힘". All three fields are display data only;
the sidebar never decides whether a session is kept or closed.

Policy acceptance, role completion and physical removal are separate. A last
pane can finish recording and learning while its row remains visible; space
cleanup is a separate producer operation. See the
[task lifecycle mapping](task-lifecycle.md) for the field
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
selection. Optional `status` (the service's status name, up to 80 characters),
`status_type` (`triage`, `backlog`, `unstarted`, `started`, `completed`,
`canceled` or `duplicate`) and `closed` (`completed`, `canceled` or `duplicate`)
carry the service's own status of a row; other values are dropped. Optional
`parent` (the parent issue's key, e.g. `DEMO-3`) draws the list as a parent/child
tree: a row sits indented under its parent, and a parent the current list does not
show (another tab, filtered out, another milestone) is a dimmed header that is not
counted. Without `parent` (and without a newer `week-timeline.json`, which names
parents) the lists stay flat. Milestone metadata supplies its name, optional `YYYY-MM-DD` due date
and a numeric progress percentage from 0 to 100. Missing dates or progress are
left blank. Per-scope cache metadata distinguishes stored, stale and uncollected
lists; it does not claim the external service is currently connected.

`issue_catalog.source: "linear-ledger"` marks a catalog the producer made from its
local Linear ledger, the one copy both the issue window and the week band are
made from. Any other value is dropped. Such a catalog is shown as it is: a newer
`week-timeline.json` does not replace it, its milestones are its own, and its
row statuses win over the Linear project cache (which only fills a row sent
without a status). A catalog without `source` keeps the newer-copy-wins rule.

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
assign, spawn, message, review, verdict, acceptance, closing and memory
transitions. All example identities and task names are synthetic.
See the [native gallery and validation measurements](panel-validation.md).
