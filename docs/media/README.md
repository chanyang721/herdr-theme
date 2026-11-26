# README media provenance

`../../preview.gif` shows an overview and twelve scenes of the sidebar and
panes. Every frame is one native window capture from
`../images/walkthrough/`, scaled to 1280 px wide, with a caption bar above it
and an outline around the part the caption names. The captions and outlines
are documentation; the captured screen is unchanged. This is not a recording of
a real task running end to end, and it is not a test receipt.

- Frames, outlined regions, source paths, SHA-256 hashes and timings:
  `workflow-manifest.json`.
- Source basis: `86c4016` on `main` (Herdr 0.1.18 app with its own core).
- Older captures and their limits: [native gallery](../panel-validation.md).

## How the captures were made

- A separate app home with its own core ran the repository's mods; the user's
  installed app and core were not touched. Captures used `herdr-app shot`,
  which reads the window without moving focus.
- All data is synthetic: the task feed (spaces, agents, events, alerts,
  `repo_flow`, requests), request cards, the week file, the issue start
  configuration and three short Markdown documents. Events were written into
  the feed file by hand; nothing ran a real task.
- The isolated copy of `sixfold-desk` had two demo-only additions that are not
  in this repository:
  - a command that calls the sidebar's own handlers (open the issue popover,
    open an issue, press 작업 시작, open the request popup, open the week
    dialog). Physical pointer and keyboard input were not replayed.
  - a stand-in for the app module that adds a second computer, `Worker`, and
    one of its spaces. There was no real SSH connection; the dashed
    cross-computer lines and the Worker install chip come from this stand-in
    together with the feed.
- 작업 시작 ran a local demo command that only printed a fixed result line.
- The document finder index came from the installed `herdr-theme` helper
  (`collect_docs`), not a fresh build of `86c4016`.
- Each capture was reduced to a 256-colour PNG to keep the repository small.

## Not shown

- The issue detail body ("not read yet"): the demo has no detail reader.
- The week collector (the band says 수집기 미설정): the demo reads a prepared
  week file.
- The monitor strip and plan-usage icons: this layout has no monitor strip.
- Native message events from the core: messages are feed events here.

Two display delays were seen in the demo and are recorded, not hidden: a change
to `repo_flow` alone appeared only after another redraw, and request cards
that arrived before the feed's `asks` stayed in the list below until the next
redraw instead of moving to the tab beside the card.

## Rebuild

From the repository root, with Python 3 and Pillow in an isolated environment:

```sh
python scripts/media/build_readme_walkthrough.py
```

The script reads only the checked-in captures and writes the GIF, the static
poster (its first frame) and the manifest. It does not access an app, an
account or a conversation. Font selection is platform dependent (captions need a
font with Hangul), so source hashes and timings are stable but encoded GIF bytes
may differ across platforms. The GIF loops; use the README's static links if
animation is unsuitable.

Before committing, decode every GIF frame, compare frame count, durations and
source hashes with the manifest, inspect the poster and representative frames,
and validate the README's local links. Do not upload private runtime
screenshots.
