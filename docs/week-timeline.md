# Week timeline (헤더 아래 이번 주 타임라인)

`mods/week-timeline` draws three things from files under `~/.config/herdr-app/data/sixfold/`.
The theme never talks to Linear itself.

| | What | Where |
|---|---|---|
| A | This week's (or two weeks') Linear work assigned to me: project › top issue › work item, with day bars | a full-width band under the monitor strip, above the agent panes (`week-timeline` block in `layouts/sixfold.json`) |
| B | Project timeline: milestones ①… with progress bars and target ◆, my issues under them | a window over the panes, from **프로젝트 전체 타임라인 ↗**; **이번 주로 접기** closes it |
| C | One issue: 요약 (description, to-do list, related issues, Herdr 작업 연결), 댓글, 알림 | a panel on the right over the panes (dialog, the rest dimmed); ✕, Esc or a click beside it closes it |

The title row (`HERDR THEME / WORKSPACE`) is gone. The MCP and CLI chip rows stay two rows;
when the window is low (the timeline band gets squeezed under 150 px) they join into one
row (`mcp-cli` stack → `mcp-cli-line`) and come back above 190 px.

## Files

| File | Written by | Read by |
|---|---|---|
| `week-timeline.json` | producer | A, B |
| `week-timeline-issues/<KEY>.json` | producer `--detail KEY` | C |
| `week-timeline-issues/<KEY>.request.json` | C, on **Linear 에 반영** | apply command |
| `week-timeline-issues/<KEY>.apply.json` | apply command | C |
| `week-timeline-applied.jsonl` | apply command (time, key, change summary; no bodies) | people |
| `week-timeline-bridge.json` | you (see `config/week-timeline-bridge.example.json`) | the mod |

Without a bridge file the band shows **수집기 미설정** and C cannot read or write.

## Producer contract

The bridge `command`+`args` is run with:

- `--if-older 90` every 2 minutes (a sync; the producer decides what to read),
- `--detail KEY [--force]` when C opens or **다시 읽기** is pressed.

The bridge `apply` command is run with `--key KEY` only when **Linear 에 반영** is pressed.
It must write `<KEY>.apply.json` (`{key, at, ok, error, applied, kept}`); changes in `kept`
stay pending in C.

The reference producer (kept outside this repo, Python) syncs only what changed: one full read
when it starts and every 2 hours as a safety net, otherwise one Linear notifications look per
sync and only the issues those notifications name are read again; after an apply only that
issue is read again. Notifications are never marked read. Reads and writes are separate
`claude -p` processes with only the Linear MCP server; reads allow only read tools, writes only
`save_issue`/`save_comment` with a guard that lets through exactly the prepared calls for that
one issue.
