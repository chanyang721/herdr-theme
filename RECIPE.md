# Herdr Theme

A compact workspace for several coding agents, designed around equal six-pane grids and an unmistakable input target.

![Herdr Theme](preview.png)

## What you see

Left: a 224 px sidebar with the Herdr Theme title, language toggle, blocked/done/working counters,
workspace navigation and agent rows under every workspace, even when inactive. Each group has a rounded border, more space between groups and a stable colored header marker.
Workspace headers drag to reorder; incoming message badges update without changing focus. The center shows the active tab's actual terminals.
Each pane has a 27 px title/status header, 5 px gaps and a 2 px accent border while focused.
A 30 px footer names the actual input target. The optional Files/Changes panel starts hidden at 340 px.
The toolbar is 32 px and native tabs 34 px. Terminal fonts inherit personal settings.
Night colors use #111821 terminals, #151f2a chrome, #79d1dc focus, #f5b56c blockers and #91cfaa completion.
Day uses #f8fafb terminals and #176878 focus. Layout theme selection follows system appearance.

## How it behaves

Working is a solid dot, blocked an exclamation mark, done a check, idle an empty circle.
Only reported states count; an unreported shell is never invented as a successful task.
Click a row to focus it. Status changes never automatically jump keyboard focus.
Agent rows carry their own status; there is no duplicate attention area or per-agent Ping control.
All controls use the app's live IDs. Keyboard shortcuts are layout-scoped; the current six-pane tab is
preserved across theme switches. Korean is the initial label language; the language toggle persists English/Korean.
Terminal navigation never needs a network request. A 500 ms reconciliation reads an optional local message log without changing focus.
Up to four messages travel along separate native, color-coded routes, once each, with endpoint highlighting.
Completed routes remain dimly visible with direction-specific counts; replay never re-sends a message.
The toolbar can disable motion. A logged send is not a read receipt or a verified reply.

## Built from

`layouts/sixfold.json` is a root row with a sidebar block and work column. The work column contains a toolbar,
native tabs, active-tab block with custom pane headers, optional Files/Changes stack and input-target footer.
`mods/sixfold-desk` renders sidebar/toolbar/pane/footer through `props.role`, using `spaces`, `panes`,
`agents`, `terminals`, `focused`, `theme`, `shared`, `setShared`, `setAgentOrder`, `run` and `nextCommand`.
The optional TUI attachment is a Python PTY relay. `balance_grid.py` uses `doc.get` / `doc.set` over `hc connect`.
Claude and Codex glyphs are original monochrome SVGs. Active glyphs gain color and move subtly; Motion off disables movement. A native Bezier curve connects the actual sender and recipient rows inside the scrolling workspace tree; a moving clip reveals its bright transmission segment once. There are no external art assets. The preview in Settings is an original SVG schematic; `preview.png` is a real native capture.

## Watch out

Native TUI processes are not imported into the core; keep their source server running.
A color theme cannot grant microphone permissions, restore authentication or implement dictation by itself.
Core layout updates use the current document version and fail on a concurrent change instead of overwriting it.
Herdr Theme's labels and status counters describe observations, not a task-completion guarantee.
On small windows, reduce the sidebar width or zoom a pane rather than pretending all output fits.
The package must not contain private project folders or session IDs. Demo fixtures are explicitly labelled.

## Done when

- Model tests and JavaScript syntax checks pass.
- `herdr-app check` passes for the installed mod, and live `status` has no errors.
- Six real panes retain their IDs through balancing and theme changes.
- Both appearances and label languages render correctly.
- Keyboard pane navigation and optional side panel controls work.
- The gallery preview comes from actual rendered, clearly labelled demo terminals.

Message counts reconcile every 500 ms independently of focus and file watcher consumers. Partial writes retain the previous snapshot. Optional routing files may be absent. Common-to-project routing uses an atomic idle guard and protects drafts, recording and pending questions; queue drain runs every two seconds while configured. Common alerts are a separate compact section above message flow and show only items needing the user. Subagent trees expand under each parent from local workflow metadata, including explicit status sources and labelled activity estimates. Parent agents remain visible without children. Workspace headers show agent totals but no message sum.
