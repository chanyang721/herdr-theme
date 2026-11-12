# README media provenance

`../../preview.gif` contains a short excerpt of the existing native Windows demo,
then nine editorial workflow chapters. Screenshots are native captures with
synthetic data; captions outside the capture are documentation. This is not a
continuous real-work execution or a test receipt.

- Intro: the first 34 frames of `../images/overview-native.gif` (the former hero).
- Chapters: exact source paths and SHA-256 hashes in `workflow-manifest.json`.
- Historical capture provenance and limitations: [native gallery](../panel-validation.md).
- Current source basis for the README update: `a64d040` on `origin/main`.
- The timeline navigation diagram describes `../week-timeline.md`; a new timeline
  screenshot is not included. Do not label the older fixture captures as fresh
  screenshots of every current runtime feature.

Rebuild from the repository root with Python 3 and Pillow installed in an isolated
environment:

```sh
python scripts/media/build_readme_walkthrough.py
```

The script reads checked-in public demo assets only, generates the GIF, static
poster and manifest, and does not access an app, a live account or a conversation.
Font selection is platform dependent, so source hashes and timing are stable but
encoded GIF bytes need not be identical across platforms. The resulting GIF
loops; use the README's static links if animation is unsuitable.

Before committing, decode every GIF frame, check the declared duration and source
hashes, inspect the poster and representative intro/chapter/final frames, and
validate the README's local links. Do not upload private runtime screenshots.
