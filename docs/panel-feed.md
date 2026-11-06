# Local panel display

The sidebar can render a local version 1 panel feed. Shared native folder-change
notifications deliver updated display data; it does not derive task stages, connect to issue trackers, send
messages, accept work, or close sessions. Those operations belong to the feed
producer. Without a valid feed, the existing workspace sidebar remains available.
The **목록** button returns to the normal workspace navigator; **작업** opens
tracking again. Cards and rows navigate only through explicit `nav.space_id`
and `nav.pane_id` targets, including their supplied machine. Missing targets are
disabled. Opaque display IDs are never guessed into navigation targets or shown
as native addresses in tooltips.

The default file is `data/sixfold/harness-local/views/panel-feed.json` below the
app home. The native `herdr-theme panel-feed --path FILE` command reads at most
2 MiB and reports `ready`, `missing`, or `invalid`, plus the producer's supplied
`reduced_motion` preference. It does not query or change system settings.
Interrupted writes and read failures preserve the last valid display; an
unchanged data timestamp is not treated as a disconnected producer.

The display contract contains `v`, `at`, `computers`, `spaces`, `links`, and
`events`, and optional `reduced_motion`. IDs and bundle IDs are opaque. Computer traffic can be `null` when
unmeasured. Spaces provide their sharing mode, optional Slack and work-tool
labels, issue groups, memory proposal count, and agent rows. Unknown fields and
versions are ignored. Each space names its `computer` ID. Unknown traffic and
unconnected tool fields remain visibly unmeasured or disconnected. No command
or executable supplied in a feed is run.

Agent stages 1–4 fill the distribution, work, review and acceptance slots. Stage
0 is unstarted; stage 5 fills all slots. A new event briefly replaces that bar
with its supplied label without moving the task title. Initial history is not
replayed. A newly observed message gets one four-pixel packet along a rounded
right-side route, a receiver ping and a finite fade. Dashed collaboration links
remain while the explicit sharing relationship is present. Whole-space sharing
uses a hollow square; sharing one agent uses a filled circle.

Issue groups and flat rows sort blocked, working, review, waiting and done.
Within a state, producer ordering is preserved. More than four agent rows become
three and a remainder count; agents without an issue follow the issue groups.
Explicit closing data uses four teal stages. Its final label remains briefly
before the row disappears; a supplied blocking reason keeps the row visible.

`sixfold.motion = false` or a supplied `reduced_motion: true` removes loops
and packet movement while labels, counts and state still update. On systems
where the producer cannot read the preference, it supplies `null`.

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

`tests/panel-fixtures.mjs` supplies the same 18 sharing/tool/Slack combinations
to model, renderer and isolated native screenshot checks. It also supplies
dispatch, spawn, message, review, verdict, acceptance, closing and memory
transitions. All example identities and task names are synthetic.
