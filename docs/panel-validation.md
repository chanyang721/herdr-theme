# Native panel fixture gallery

These are fresh native app screenshots of the current integrated computer navigator, with synthetic Studio/Worker inventory, local task data and simulated tool responses. They show the default computer selection, badges below workspace names and the two-line sidebar header. The [manifest](images/panel-feed/manifest.json) records image hashes. Each image is a lossless rectangular crop with no added UI artwork. Registered interaction handlers were invoked programmatically; physical pointer and keyboard input were not replayed. The isolated demo's files and window state were restored afterward.

These captures use the older host's compatibility reader. Actual Windows native JSON-worker and visibility integration remains pending a compatible executable.

![Native task panel and issue popover with synthetic data](images/panel-feed/issues-milestone.png)

The matrix has **24 unique combinations: 4 sharing modes × 3 tool choices × 2 Slack states**. Each combination is captured in both dark and light themes, giving **48 matrix images**. The fixture generator drives model tests, renderer tests and native captures. Each matrix cell links to its capture.

### Dark theme

| Sharing | No tool | No tool + Slack | Linear | Linear + Slack | Jira | Jira + Slack |
| --- | --- | --- | --- | --- | --- | --- |
| None | [View](images/panel-feed/matrix-none-none-no-slack.png) | [View](images/panel-feed/matrix-none-none-slack.png) | [View](images/panel-feed/matrix-none-linear-no-slack.png) | [View](images/panel-feed/matrix-none-linear-slack.png) | [View](images/panel-feed/matrix-none-jira-no-slack.png) | [View](images/panel-feed/matrix-none-jira-slack.png) |
| Same-computer spaces | [View](images/panel-feed/matrix-local-none-no-slack.png) | [View](images/panel-feed/matrix-local-none-slack.png) | [View](images/panel-feed/matrix-local-linear-no-slack.png) | [View](images/panel-feed/matrix-local-linear-slack.png) | [View](images/panel-feed/matrix-local-jira-no-slack.png) | [View](images/panel-feed/matrix-local-jira-slack.png) |
| Cross-computer space | [View](images/panel-feed/matrix-space-none-no-slack.png) | [View](images/panel-feed/matrix-space-none-slack.png) | [View](images/panel-feed/matrix-space-linear-no-slack.png) | [View](images/panel-feed/matrix-space-linear-slack.png) | [View](images/panel-feed/matrix-space-jira-no-slack.png) | [View](images/panel-feed/matrix-space-jira-slack.png) |
| Cross-computer agent | [View](images/panel-feed/matrix-agent-none-no-slack.png) | [View](images/panel-feed/matrix-agent-none-slack.png) | [View](images/panel-feed/matrix-agent-linear-no-slack.png) | [View](images/panel-feed/matrix-agent-linear-slack.png) | [View](images/panel-feed/matrix-agent-jira-no-slack.png) | [View](images/panel-feed/matrix-agent-jira-slack.png) |


### Light theme

| Sharing | No tool | No tool + Slack | Linear | Linear + Slack | Jira | Jira + Slack |
| --- | --- | --- | --- | --- | --- | --- |
| None | [View](images/panel-feed/matrix-none-none-no-slack-light.png) | [View](images/panel-feed/matrix-none-none-slack-light.png) | [View](images/panel-feed/matrix-none-linear-no-slack-light.png) | [View](images/panel-feed/matrix-none-linear-slack-light.png) | [View](images/panel-feed/matrix-none-jira-no-slack-light.png) | [View](images/panel-feed/matrix-none-jira-slack-light.png) |
| Same-computer spaces | [View](images/panel-feed/matrix-local-none-no-slack-light.png) | [View](images/panel-feed/matrix-local-none-slack-light.png) | [View](images/panel-feed/matrix-local-linear-no-slack-light.png) | [View](images/panel-feed/matrix-local-linear-slack-light.png) | [View](images/panel-feed/matrix-local-jira-no-slack-light.png) | [View](images/panel-feed/matrix-local-jira-slack-light.png) |
| Cross-computer space | [View](images/panel-feed/matrix-space-none-no-slack-light.png) | [View](images/panel-feed/matrix-space-none-slack-light.png) | [View](images/panel-feed/matrix-space-linear-no-slack-light.png) | [View](images/panel-feed/matrix-space-linear-slack-light.png) | [View](images/panel-feed/matrix-space-jira-no-slack-light.png) | [View](images/panel-feed/matrix-space-jira-slack-light.png) |
| Cross-computer agent | [View](images/panel-feed/matrix-agent-none-no-slack-light.png) | [View](images/panel-feed/matrix-agent-none-slack-light.png) | [View](images/panel-feed/matrix-agent-linear-no-slack-light.png) | [View](images/panel-feed/matrix-agent-linear-slack-light.png) | [View](images/panel-feed/matrix-agent-jira-no-slack-light.png) | [View](images/panel-feed/matrix-agent-jira-slack-light.png) |

Additional layouts: [state sorting](images/panel-feed/scenario-sorting.png), [overflow](images/panel-feed/scenario-overflow.png), [unassigned issues](images/panel-feed/scenario-no-issue.png), [cross-space](images/panel-feed/scenario-cross-space.png), and [cross-computer](images/panel-feed/scenario-cross-computer.png).

Transitions: [distribution](images/panel-feed/event-dispatch-existing.png), [new session](images/panel-feed/event-spawn.png), [message](images/panel-feed/event-message.png), [space message](images/panel-feed/event-message-space.png), [computer message](images/panel-feed/event-message-computer.png), [review request](images/panel-feed/event-review_request.png), [verdict](images/panel-feed/event-verdict.png), [acceptance](images/panel-feed/event-accept.png), [closing 1](images/panel-feed/event-close-1.png), [closing 2](images/panel-feed/event-close-2.png), [closing 3](images/panel-feed/event-close-3.png), [closing 4 after its label expires](images/panel-feed/event-close-4.png), [blocked closing](images/panel-feed/event-blocked-close.png), and [memory proposal](images/panel-feed/event-memory.png).

[Light tasks](images/panel-feed/light-complete.png), [light issue popover](images/panel-feed/light-issues.png) and [motion off](images/panel-feed/motion-off.png) retain the same information. Two motion-off captures had zero differing pixels. Transition captures illustrate message packets and new-session states; they do not measure presentation FPS. The standard sidebar is 340px wide; long titles and event labels truncate with their full text available in tooltips.

## Issue popover and child rows

The popover is 440px wide, with a 10px gap outside the 340px sidebar. Native window-edge clamping applies in smaller viewports.

| Case | Native capture |
| --- | --- |
| Three scopes | [This week](images/panel-feed/issues-week.png), [milestones](images/panel-feed/issues-milestone.png), [all](images/panel-feed/issues-all.png) |
| Local search | [Matching results](images/panel-feed/issues-search.png) |
| Cache metadata | [Uncollected](images/panel-feed/issues-missing-cache.png), [stale](images/panel-feed/issues-cache-stale.png), [missing milestone details](images/panel-feed/issues-missing-milestone.png) |
| Explicit selection | [Unpinned](images/panel-feed/issues-explicit-unpinned.png), [pending](images/panel-feed/issues-import-pending.png), [imported](images/panel-feed/issues-imported.png), [removed](images/panel-feed/issues-removed.png) |
| Natural week item | [Removal rejected](images/panel-feed/issues-week-required.png) |
| Child branches | [Folded](images/panel-feed/tree-folded.png), [expanded](images/panel-feed/tree-expanded.png) |
| Work titles and child completion | [Six active children, with +3 folded](images/panel-feed/children-active-titles.png), [two completed children removed; four remain, with no fold](images/panel-feed/children-completed-removed.png) |
| Issue groups | [Five groups expanded, including a dimmed completed issue](images/panel-feed/issues-expanded-five.png) |
| Closing memory | [Pending](images/panel-feed/closing-memory-1.png), [saved](images/panel-feed/closing-memory-2.png), [proposed](images/panel-feed/closing-memory-3.png), [final label](images/panel-feed/closing-memory-4-tag.png), [row hidden](images/panel-feed/closing-memory-4-hidden.png) |
| Other indicators | [Errors, missing report, unread messages, limits and remote work](images/panel-feed/complete.png) |

Milestones show supplied dates and percentages, including 0%; missing values are not inferred. Import pending and the week-required race created real local outbox files with simulated feed replies; the other cases are supplied display states. The rejection case makes an initially removable issue week-required before its reply arrives. Repeated snapshots retain seen event IDs and play each new ID once.

## Stationary relations and messages

| Case | Native capture |
| --- | --- |
| Solid gray same-task bracket | [Stationary relation](images/panel-feed/task-static.png) |
| Same-computer partners | [Purple bracket, square endpoints and name chips](images/panel-feed/local-collaboration.png) |
| Local message | [Teal head and fading tail](images/panel-feed/local-message.png) |
| Arrival | [Expanding square ping](images/panel-feed/local-arrival.png) |

The current captures use a 340px sidebar. Gray task relations and purple local-space relations remain separate, and message packets use native easing, a tail and a square arrival ping. A second stationary motion-off capture is compared pixel-for-pixel in the recapture evidence. Physical input and presentation FPS are not measured.

The gallery contains 99 fresh native crops from renderer source tree `15108ebea07754f9f0f63eb3b9f55b0207f45def`: 48 matrix images (24 combinations × 2 themes) and 51 state, interaction and motion examples. The child-completion pair updates the supplied work title and marks two children done while retaining them in the input feed: both disappear from the rendered tree and its folded count, without a click or manual expansion change.
Fixtures validate rendering and local request handling; a live producer/account
round trip is not covered by these captures.

## Compatibility-host measurements

The isolated app used a 3440×1440 window and a 340px sidebar. CPU percentages below are normalized over 16 logical processors. The large fixture has 20 spaces and 60 agents; update measurements used motion off. No screenshots were taken during the burst.

These historical timings come from a separate earlier compatibility-host run
of the standalone task view. They are not a benchmark of the current integrated
navigator or the final gallery recapture.

| Observation | Result |
| --- | --- |
| Unchanged feed, 20 seconds | File reads, callbacks, watch batches, panel notifications and native window renders: 0 |
| Unchanged-feed process cost | 0.088% machine CPU; no private-memory increase |
| 500 writes over 20 seconds | Intentional 150ms coalescing; final revision visibly rendered |
| Burst process cost | 1.105% machine CPU; no private-memory increase |
| Three quiet title changes, without clicking | Screenshot-completion bounds: 227.38ms, 220.81ms and 355.63ms |
| Partial updates in those probes | Each changed row rendered once; other 59 rows, cards, root and list: 0 |
| 122 native window renders in the burst | Mean render cost 12.204ms |
| One-second render-duration sums | p50 76.280ms; p95 91.651ms; p99 92.971ms |

Duration quantiles describe one-second sums, not individual frames. Physical presentation FPS and individual frame percentiles were not measured; these results do not establish frame-drop-free behavior. Bounded producer retries handled transient Windows atomic-replace contention; all 500 writes were accepted. Intermediate states intentionally coalesce. One boundary script bucket appeared during idle measurement; zero script execution is not claimed.

The quiet probes used the same 20-space/60-agent fixture. Their bounds include screenshot command and encoding overhead, rather than measuring individual frame presentation. Current retained-entity tests also verify that a single title change invalidates only its row.

Native space and pane navigation also updated selection highlighting with the feed bytes and modification time unchanged. Only the old and new cards redrew, including with two copies. Physical clicks, hover and drag were not replayed.

The compatibility reader parses changed JSON in JavaScript. These measurements do not prove native-worker parsing or Windows minimize/resume behavior on the newer host API.

Packet movement uses finite native transitions with easing, a fading tail and a
square arrival ping. The public animation API offers four easing presets and no
frame-rate setting or custom curve. Movement therefore follows the native host
cadence with smooth easing; exact 24fps or quantized 24-step movement is not
claimed. No JavaScript frame loop was added.

## Curved message gutter

The [224px sidebar](images/panel-feed/lanes-after-224.png) and [340px sidebar](images/panel-feed/lanes-after-340.png) use a reserved 72px gutter. Bright eight-pixel packets and fading tails follow outward Bezier arcs, with square departure and arrival pings. Message arcs sit inside the stationary purple collaboration and outer computer routes. Two lanes stagger concurrent sends. Eight finite native interpolation targets provide acceleration and deceleration without a JavaScript frame loop. These are synthetic demo events in the actual native renderer; they do not establish a successful live-record delivery or physical presentation FPS.
