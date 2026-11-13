# Harness lifecycle and the sidebar

This contract joins the optional
[ai-workflows producer](https://github.com/chanyang721/ai-workflows) and this
theme's existing compact sidebar. It adds no task authority, sidebar section,
tab, or timer that can close a session. Installing the theme does not install
the producer.

## Separate the result from the terminal

The producer records assignment, receipt, work, review, acceptance, retained
context and closure as distinct facts. A role can end with PASS, HOLD, failure
or deferred work. Its result and remaining work must be preserved and handed
over without describing the whole task as successful.

Policy acceptance and learning do not depend on whether a terminal is the last
pane of its tab. Physical cleanup still requires fresh process, input,
identity, reservation and layout checks. An ordinary task with unfinished work
must not become successful merely because a response ended. A session-close
report instead records the end of that session's role under the producer's
existing acceptance policy; it can truthfully retain remaining product work.

The producer may preserve a fixed space while removing completed panes and
eligible extra tabs. A nonfixed space is archived as the parent work bundle
before it closes. The archive keeps context for later reuse. A previous agent
exit with a leftover shell needs verified prior closure and fresh idle-shell
evidence; lack of an agent process alone is insufficient. These are producer
responsibilities, not theme heuristics.

## Display mapping

The public version 1 feed remains unchanged. The theme does not infer a new
state from an issue number, role name, progress percentage or elapsed time.

| Producer evidence | Feed fields | Existing sidebar behavior |
| --- | --- | --- |
| Task allocation, work, review, acceptance | `stage` 0–5 | Task bar or transient label in the existing status slot |
| Current observed pane state | `status`, optional `state` | Status mark or seven-state glyph; independent of task stage |
| Accepted task whose pane still remains | `stage: 5`, `status: idle` or `working`, optional `keep_reason` | Row stays visible, including child rows; stage 5 does not imply closure |
| Cleanup held or waiting | `keep_reason`, optional `closing.blocked_reason` | Reason remains in the row tooltip; a blocked close stays visible |
| Only an idle deadline remains | `state: cleanup_wait` or `unseen_result`, valid `cleanup` | Countdown uses the supplied absolute deadline and limit, whether five or thirty minutes |
| Reporting, retaining context, memory proposals | `closing.step` 1–3, optional `closing.memory` | Closing stages use the existing task slot |
| Confirmed physical close | `closing.step: 4`, no blocking reason | Final label is retained briefly, then the row disappears |
| Archived workspace | Producer confirms removal from the live layout and preserves its archive; historical feed rows may remain | No new live space or pane is invented by the theme |

`state: closed` by itself is not a row-removal instruction. Closing phase 4
controls removal. A missing feed, a stale observation, a sent message or an
expired countdown is not proof of actual closure. The producer must refresh
the feed after its own checks and actual layout changes.

## Verification matrix

These checks distinguish source/model validation from a live run. A test
fixture or native screenshot is not evidence that an installed machine has
accepted or closed real work.

| Boundary | Required check | Source or test |
| --- | --- | --- |
| Producer task to display | Task stage and observed pane status remain separate | Producer `integrations/herdr/panel_feed.py`; theme `mods/sixfold-desk/panel-model.js` |
| Acceptance with last-pane protection | Eligible session report can be accepted and learned while pane closure stays protected; parent-space gate then permits archive and close | Producer `tests/test_completion_stages.py` |
| Ordinary unfinished work | Pending CI or other remaining work is not silently policy-accepted by completion | Producer `tests/test_completion.py` |
| Accepted but kept rows | Stage 5 with idle/working status stays visible; unfinished child branches are retained | `tests/panel-model.test.mjs`, `tests/panel-view.test.mjs` |
| Cleanup reason and deadline | Producer reason is preserved, rows stay compact, five-minute limits are not replaced by a theme default | `tests/panel-row-states.test.mjs`, `tests/panel-retained.test.mjs` |
| Final removal | Only explicit closing phase 4 hides the row; blocking reason retains it | `tests/panel-model.test.mjs` |
| Installed connection | Fresh producer feed is valid; installed consumer displays it; archive exists and actual space/pane is absent after cleanup | Verify separately on each machine, including its fixed-space and automatic-cleanup configuration |

Run the theme's model and renderer checks with:

```sh
node --test tests/panel-model.test.mjs tests/panel-row-states.test.mjs tests/panel-retained.test.mjs tests/panel-view.test.mjs
```

Run producer tests through that repository's supported isolated test runner.
Do not disable identity, review, input or process guards to make a displayed
row disappear. Prefer reconciling the exact stale record or fixing the shared
policy stage that prevents normal progression.
