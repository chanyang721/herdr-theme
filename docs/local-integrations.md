# Local integrations

The theme reads optional files under the app home's `data/sixfold/` directory.
An external tool owns these files and their policy. Missing inputs quietly hide
the corresponding display. Invalid updates keep the last valid display until
a valid snapshot or confirmed deletion arrives. No tool is discovered or installed by
the theme, and there is no fallback to another application's data directory.

## Cards and a configured command

`bridge.json` specifies an executable and an absolute script path:

```json
{"python":"python3","script":"/demo/bridge/provider.py","args":["--local"]}
```

The executable name is historical; it can name any compatible local program.
The theme executes it directly, with the script, configured arguments, and one
final absolute request-file path. It does not assemble a command with a shell.
Configure only a command you trust.

`cards.json` contains a versioned display envelope:

```json
{"schema":1,"cards":[{"id":"demo-card","revision":"v1","kind":"question","terminal":"demo-terminal","title":"Choose a color","questions":[{"id":"color","title":"Color","options":[{"id":"blue","label":"Blue"}]}],"actions":[{"id":"submit","label":"Send","requiresAnswers":true,"primary":true}]}]}
```

Kinds are `question`, `permission`, or `plan`. Optional `detail` is plain text.
Question `multi` defaults to false. Action IDs and revisions are opaque; the
theme does not infer their meaning. IDs use 1–128 ASCII letters, digits, dots,
underscores, colons or hyphens, beginning with a letter or digit. Revision is a
nonempty string up to 128 characters. Optional action `autoSubmit` sends only
after a single question's single selection is complete; it defaults to false.

A button first creates `bridge-actions/<request-id>.json` only if absent,
then explicitly invokes the configured command:

```json
{"schema":1,"id":"demo-request","cardId":"demo-card","revision":"v1","action":"submit","answers":{"color":["blue"]},"createdAt":"2026-01-01T00:00:00Z"}
```

The request ID prevents accidental filename collisions; it is not authority to
perform an action. The external consumer must validate the regular file and
its location, size, schema, card revision, action, answers and current policy.
It must claim requests atomically, prevent duplicate effects and bound retained
files. File creation alone must never execute an action.

Success requires exit code zero and a final stdout JSON receipt:

```json
{"schema":1,"id":"demo-request","status":"accepted"}
```

`duplicate` also acknowledges success. `stale`, `rejected`, nonzero exit,
missing/malformed receipts or mismatched IDs retain the card and refresh it.
The theme never automatically resends. Output must contain no secrets; raw
process output is not displayed. Authority and one-time credentials stay in
the external consumer.

## Local document views

`local-views/workspaces/index.json` describes views by space:

```json
{"schema":1,"views":[{"id":"demo-view","spaceId":"demo-space","name":"Local notes","directory":"demo-view","sections":[{"id":"overview","label":"Overview","directory":".","order":["README.md"],"groupDepth":1}],"labels":{"README.md":"Start here"}}]}
```

View and section directories are relative, beneath the neutral views root.
Absolute paths, drive syntax, backslashes, `..` and resolved directory escapes
are rejected. An explicit `localViews.root` in a space's document configuration
can instead select a user-owned folder. This is an opt-in override.
The producer supplies section labels and order; the theme knows no special
folder or filename policy. Unknown folders appear as ordinary file groups.
Optional `sources` maps relative files to originals; an original is followed
only when it identifies the same actual file (for example a hard link).

## Session reports and feeds

`session-reports.json` is display-only:

```json
{"schema":1,"reports":[{"id":"demo-report","terminal":"demo-terminal","title":"Local check","summary":"Ready","state":"ready"}]}
```

Reports do not close, park, resume or otherwise change sessions. Clicking one
with a terminal focuses that terminal. `task-feed.json` supplies the optional
sidebar task panel described in the [feed contract](panel-feed.md). The theme
installs the consumer; the producer and its automation are configured separately.
External tools can also publish ordinary review documents beneath
`local-views/reviews/` and expose them through their own view metadata.

## Extension points

These let a private local tool add behavior without changing the theme.

- **Helper commands.** `herdr-theme <name> ...` with a name the helper does not know runs
  `herdr-theme-<name>` with the same arguments. It looks next to the installed helper first,
  then on `PATH`. Names are lowercase letters, digits and `-`. If nothing is found, the
  command fails with `unknown command`.
- **Sidebar notices.** `data/sixfold/sidebar-notices.json` holds
  `{"v":1,"notices":[{"id":"queue","text":"…","tone":"dim|working|blocked","tooltip":"…"}]}`.
  The sidebar footer shows at most three notices. Each text is cut to 80 characters and each
  tooltip to 600. The producer writes the file and removes notices that no longer apply.
- **Site settings** (`site.local.json`):
  - `fallback_space` is the space that receives unmapped alerts (default `Hub`).
  - `hub_space_ids` lists the coordinating spaces. By name, only a space called `Hub` counts.
  - `model_presets.<agent>.<name>` is either a model name or `{"model","effort"}`.
    `new_space_preset` picks the preset for a new workspace's first session.
    `herdr-theme workspace --preset <name>` (or `--model`/`--effort`) overrides it.

## Slack alerts: names and attachments

Alert items in `project-alerts.json` and `slack-mentions.json` may carry
`author_id`, `author_name`, `mentions: {"<user id>": "<display name>"}` and
`files: [{id, name, mimetype, size?, permalink}]`. The card popover beside a
space and the Slack inbox window show the same thing:

- Title `sender → recipient`. Each name is looked up in the item's `mentions`
  map first (the collector's newest name), then `author_name` or the label the
  text spells (`<@ID|name>`), then the `<@ID|name>` marks elsewhere in the
  feed, then `site.local.json` `slack.user_names`, and finally the ID itself.
- The recipient is the first tag in the text that is not the sender; more tags
  read `B 외 n`. With no tag the title ends in `channel_name`, then the
  project, then the channel ID.
- The body spells tags, channels and links as text (`@name`, `#channel`, the
  link's label).
- Each file is a chip: kind, name, size, **본문 보기** and **다운로드**. 본문 보기
  shows the collector's local copy `data/sixfold/slack-files/<id>.txt`, or
  `본문 준비 중` while there is none. 다운로드 hands the file's direct address
  `https://files.slack.com/files-pri/<team id>-<file id>/download/<name>` to the
  default browser, only on a press; the browser's own Slack sign-in fetches it,
  so no token is kept. The team ID is `site.local.json` `slack.team_id`; without
  it the button reads **Slack에서 열기** and opens the file's Slack page. A file id
  that is not plain letters and digits is never read; a link that is not a Slack
  https address shows no button. The arrival peek shows the chips without buttons.
- A row's body is one line in the card popover and the peek (the whole text is
  in its tooltip and the inbox window).
- Mentions routed to a space (`slack-mentions.json` `project`; unmapped
  channels, DMs and thread replies go to the fallback space, `site.local.json` `fallback_space`, default `Hub`) also give that space its Slack
  badge, unread count and popover rows. A mention whose space is not on the
  sidebar (`미연결`, a closed space) counts on the fallback space, where its arrival lands.
  A space with no tracked channel feed (the fallback space) opens the mentions window from
  전체 보기 on that space's mentions (the off-sidebar ones included); 전체
  there shows every space.
- A tracked item's `status` of `stale` (past the collector's age window) or
  `handled` (read, dismissed or handed off) is folded: the badge, unread count
  and popover rows leave it out, and so does the inbox window's 미확인만;
  확인한 스레드 포함 still lists it. Any other status (`new`, `needs-you`) shows.

In the inbox window 본문 보기 opens a popover. In the card popover it opens a
panel under the chip instead: the card popover is itself a popover, and a
press inside a second popover counts as a press outside the first, which
would close it and the text together. The panel keeps the text inside the
surface the person is already in.

The two mods cannot import each other, so the shared code lives in
`sixfold-slack-inbox/model.js` and `sixfold-desk/alert-slack.js`;
`tests/slack-alert-names.test.mjs` fails when the two copies differ.
