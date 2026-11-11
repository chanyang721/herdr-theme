# Week timeline (헤더 칩과 타임라인 오버레이)

`mods/week-timeline` draws three things from files under `~/.config/herdr-app/data/sixfold/`.
The theme never talks to Linear itself.

| | What | Where |
|---|---|---|
| A | This week's open work count and today's deadline count; click for project › top issue › work item, with deadline markers | one `week-timeline-chip` in the MCP header row; its dialog floats over the panes |
| B | Project timeline: milestones ①… with progress bars and target ◆, my issues under them | a window over the panes, from **프로젝트 전체 타임라인 ↗**; **이번 주로 접기** closes it |
| C | One issue: 요약 (description, to-do list, related issues, Herdr 작업 연결), 댓글, 알림 | a panel on the right over the panes (dialog, the rest dimmed); ✕, Esc or a click beside it closes it |

The title row (`HERDR THEME / WORKSPACE`) and bottom `입력 대상` footer are gone. The footer
renderer in `sixfold-desk` remains available to other layouts.

A is a 20 px chip in the existing header row: `이번 주 5 · 오늘 1 ●`. It counts open work
selected by the week model (completed work contributes to parent progress, not the chip count).
Today's count uses the deadline, else milestone target. The dot is red for overdue work,
accented for today's work, otherwise muted. A missing feed shows dashes until data loads.

Clicking the chip opens a `dialog` over the panes. It takes no layout space. The transparent
backdrop, ✕, or native Esc closes it; inside clicks stay inside. Herdr owns dialog focus and
returns to the original pane on close. The table has project filters, 1/2-week controls,
issue detail links, and the full project timeline link. The latter closes the week dialog
before opening B. Only the chip runs the existing producer timer; the open dialog reads
the same local feed. There is no expansion state, dynamic band height, or chip-row resizing.

The dialog fits the window (65% height, at most 420 px) and scrolls within it. Text is 12 px,
with only parent issue titles semibold, and rows are 24 px with quiet theme-derived rules.
There are no duration bars in A: a small ◆ marks the deadline day; a deadline beyond the
window is text alone at the right (`→ 12/3`), and an earlier-week deadline is red with its date
at the left. No date means no marker. A missing deadline falls back to the milestone target;
the tooltip names that source. Parent issue rows keep progress only on the left.

The tree sorts by deadline, else milestone target, with undated work last. On the same day:
in progress, to do, review, then issue key. Projects and parent groups sort by the earliest
work inside them, including when folded. Issue membership and the feed/collector contracts
are unchanged. `summary.js` computes chip counts from that same selection.

## Files

| File | Written by | Read by |
|---|---|---|
| `week-timeline.json` | producer | A, B |
| `week-timeline-issues/<KEY>.json` | producer `--detail KEY` | C |
| `week-timeline-issues/<KEY>.request.json` | C, on **Linear 에 반영** | apply command |
| `week-timeline-issues/<KEY>.apply.json` | apply command | C |
| `week-timeline-issues/<KEY>.sent.json` | apply command (reply keys already sent) | apply command |
| `week-timeline-applied.jsonl` | apply command (time, key, change summary; no bodies) | people |
| `week-timeline-bridge.json` | you (see `config/week-timeline-bridge.example.json`) | the mod |

Without a bridge file the band shows **수집기 미설정** and C cannot read or write.

## Producer contract

The bridge `command`+`args` is run with:

- `--if-older 90` every 2 minutes (a sync; the producer decides what to read),
- `--detail KEY [--force]` when C opens or **다시 읽기** is pressed.

The bridge `apply` command is run with `--key KEY --request ID` only when **Linear 에 반영** is pressed.
C writes `<KEY>.request.json` as `{key, id, changes}`; every reply change carries its own
idempotency key `rid`. The command must write `<KEY>.apply.json` as
`{key, request, at, ok, error, applied, kept, unsure, check?}`, where `request` is the `id` it answered. C uses a
result only when `request` matches the request it just wrote, whatever the exit code; otherwise it
keeps every change pending. Changes in `kept` stay pending, and the request file then holds them.
**취소** and removing a change rewrite that file (with a new `id`), so they do not come back on
reopen. Every save and every apply takes a new generation in the popup: a save whose file read
finishes after a newer one began is dropped, and each write lands only on the file it read. The
command runs only the request named by `--request`; when the file holds another one it sends
nothing and answers `{request: ID, mismatch: true}`, and C keeps its changes. The command rewrites
the request file only while its `id` is still the one it ran.

Field changes (`save_issue`) set values, so a failed run simply sends them again. Replies are not
idempotent, so:

- Each reply's body ends with its key as a mark: one visible line `` `herdr-rid:RID` `` (inline code).
  It stays visible on Linear by decision (2026-11-11; it replaces the earlier wish for an invisible
  mark); only the popup hides it. A live test on a test issue confirmed Linear keeps the line verbatim
  and the comment lookup finds the key. A reply counts as on Linear only when that mark is found, never by its words.
- The write guard reserves the `rid` in `<KEY>.sent.json` (written and fsynced, under a lock that
  parallel hooks share) before the call is let through, and refuses a `rid` already there.
- A reserved reply is settled only by a fresh, complete comment lookup (`list_comments` to the last
  page, no tool errors, one tail per comment counted): mark found → confirmed, not sent; mark absent
  and the reservation older than a minute → sent once more (reserved again). A lookup that failed,
  did not finish, or a reservation too recent leaves it reserved and unsent: the result carries
  `unsure: N` and C shows **확인 필요(댓글 전송 여부 불명)** with **[다시 확인]**, which runs the command
  with `--check` (look only, send nothing).
- Removing an unsure reply from C does not free its `rid`; writing it again makes a new one.
- After anything was written, or a reply was found by its mark (also on **[다시 확인]**), the command
  re-reads the issue detail so C lists the new comment. Field changes need that re-read to be
  confirmed; for replies alone a failed re-read is reported as `refresh` and does not undo them.

The reference producer (kept outside this repo, Python) syncs only what changed: one full read
when it starts and every 2 hours as a safety net (a failed one keeps the last good values and is
tried again 10 minutes later), otherwise one Linear notifications look per
sync and only the issues those notifications name are read again (a notification counts as
seen only once its issue was read; a failed read is retried on the next sync); after an apply only that
issue is read again. Notifications are never marked read. Reads and writes are separate
`claude -p` processes with only the Linear MCP server; reads allow only read tools, writes only
`save_issue`/`save_comment` with a guard that lets through exactly the prepared calls for that
one issue.
