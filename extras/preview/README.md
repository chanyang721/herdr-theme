# Project Document Viewer

Open project Markdown, images, PDFs and local HTML from the Files tree in a side panel. Use the right activity rail to switch between documents and changes without opening another terminal. Saved local files refresh automatically.

## Install

Requires Herdr 0.1.11+, the native Herdr Theme helper and a personal layout with `files` and `panel-body` nodes. Choose a compatible personal layout before installation. The installer preserves existing mod names and the current pane tree.

```sh
herdr-theme install_preview --layout sixfold
herdr-theme open_document /absolute/path/to/document.md
```

The installer downloads the pinned Preview Plus / Files Plus source at `089d87d6c5651f9950c68d10612cd8462058b83b` from https://github.com/linziyanleo/herdr-mods. It reads that source, stages local copies and runs native checks. Original notices stay with those copies. Upstream runtime is not included or relicensed in this repository.

HTML requires macOS and a compatible Swift SDK; use `--markdown-only` otherwise. HTML is rendered to a read-only WebKit image, not an interactive browser. Local JavaScript and styles execute for rendering. HTTP(S)/WebSocket resources are blocked; pages relying on remote fonts, assets or APIs may look different. It does not use your browser profile. Long documents are capped at 12,000px; local image snapshots are stored under app data. Links/forms inside the HTML image are not clickable. Open the original in a browser for interaction.

This mod reads selected documents, linked local assets, project directory listings and Git metadata. Files Plus offers explicit file actions. It executes the native helper, Git, native file utilities and the local Swift renderer; installation accesses GitHub. No agent conversations or account credentials are required. Read the upstream recipe before installation.
