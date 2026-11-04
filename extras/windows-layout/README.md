# Windows layout

`sixfold.json` uses two monitor rows so the resource/plan and MCP/CLI groups fit
beside a 224px sidebar in a 1483px window at 0.9 zoom. Install the external mods
from herdr-workspace-mods first. The regular layout remains the wide-window Mac
layout. To keep existing `layout:sixfold` key bindings, stage this variant as
`layouts/sixfold.json` and install that explicit file with `update_install.py`.

Windows helpers use OS file locks, UTF-8 text and console-free child processes.
Document tabs read their helpers from the updater-managed `scripts/sixfold/`
tree. The document browser's open, clipboard and Ego lite actions use
`scripts/desktop.py`; normal Ego profiles are reused. The Swift HTML/Mermaid
renderers, audio voice plugin and launchd sleep/cleanup observers remain Mac
components and are not started by this Windows installation. Local Markdown,
document navigation and the external-browser action remain available.

Keep each computer's keys, local paths, machine IDs, account configuration and
running sessions. Do not restore the Mac snapshot over a Windows home.
