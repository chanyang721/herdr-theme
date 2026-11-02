# Project document tracking

Configure local folders in `~/.config/herdr-app/data/sixfold/project-docs.json`. Project owners maintain this file; installation never overwrites it. Keys are actual workspace IDs or exact workspace names.

```json
{
  "version": 1,
  "spaces": {
    "Example": {
      "target": "~/Documents/LukukuProjects/Example",
      "folders": [
        {"path": "~/work/projects/example/docs"},
        {"path": "~/Documents/Reports", "match": ["example"]}
      ]
    }
  }
}
```

Run `python3 scripts/collect_docs.py`. No configuration means no collection and no sidebar section. No daemon or LaunchAgent is installed; an existing watcher can call the collector periodically.

The collector indexes Markdown/PDF/Word/Excel files by modification time, excluding `.before-*`, `latest.md` and source symlinks. Filename matches are case-insensitive OR terms per folder. The index is replaced atomically only when content changes. Unavailable folders and ownership conflicts remain visible as warnings.

The target folder contains links to original files. Existing actual files and unowned links are preserved. A colliding filename receives a hash prefix. The hidden `.herdr-document-links.json` records only links this collector created. Only recorded links whose originals disappeared are removed; originals are never moved or deleted. Do not edit the ownership manifest to claim existing user files.

The active workspace’s latest five files appear in the left sidebar, refreshed every two seconds. File and folder controls explicitly open VS Code with `--reuse-window`; a failed process shows an error, and a successful retry clears it. Collecting and refreshing do not launch editors or move focus. The current theme does not create a right panel. Independent document-viewer mods can be installed in another compatible personal layout.

Verification uses temporary folders, synthetic documents, native checks and stubbed launch handlers. Real pointer clicks or external editor launches are not part of automated verification.
