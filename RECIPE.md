# Sixfold

A compact workspace for several coding agents, designed around equal six-pane grids and an unmistakable input target.

![Sixfold](preview.png)

## What you see

Left: a 224 px sidebar with the Sixfold title, language toggle, blocked/done/working counters,
workspace navigation and numbered agent/pane rows under every workspace, even when inactive.
Workspace headers drag to reorder; each agent row offers an explicit Ping control. The center shows the active tab's actual terminals.
Each pane has a 27 px title/status header, 5 px gaps and a 2 px accent border while focused.
A 30 px footer names the actual input target. The optional Files/Changes panel starts hidden at 340 px.
The toolbar is 32 px and native tabs 34 px. Terminal fonts inherit personal settings.
Night colors use #111821 terminals, #151f2a chrome, #79d1dc focus, #f5b56c blockers and #91cfaa completion.
Day uses #f8fafb terminals and #176878 focus. Layout theme selection follows system appearance.

## How it behaves

Working is a solid dot, blocked an exclamation mark, done a check, idle an empty circle.
Only reported states count; an unreported shell is never invented as a successful task.
Click a row to focus it. Status changes never automatically jump keyboard focus.
Blockers precede completions in a separate attention area, with stable source order within each group.
All controls use the app's live IDs. Keyboard shortcuts are layout-scoped; the current six-pane tab is
preserved across theme switches. Korean is the initial label language; the language toggle persists English/Korean.
Terminal navigation never needs a network request. An optional local message log is polled once per second;
recent successful sends animate a 2.4-second route with endpoint highlighting. The toolbar can disable motion.
Ping shows send success or failure separately from a verified PONG reply.

## Built from

`layouts/sixfold.json` is a root row with a sidebar block and work column. The work column contains a toolbar,
native tabs, active-tab block with custom pane headers, optional Files/Changes stack and input-target footer.
`mods/sixfold-desk` renders sidebar/toolbar/pane/footer through `props.role`, using `spaces`, `panes`,
`agents`, `terminals`, `focused`, `theme`, `shared`, `setShared`, `setAgentOrder`, `run` and `nextCommand`.
The optional TUI attachment is a Python PTY relay. `balance_grid.py` uses `doc.get` / `doc.set` over `hc connect`.
There are no external art assets. The preview in Settings is an original SVG schematic; `preview.png` is a real native capture.

## Watch out

Native TUI processes are not imported into the core; keep their source server running.
A color theme cannot grant microphone permissions, restore authentication or implement dictation by itself.
Core layout updates use the current document version and fail on a concurrent change instead of overwriting it.
Sixfold's labels and status counters describe observations, not a task-completion guarantee.
On small windows, reduce the sidebar width or zoom a pane rather than pretending all output fits.
The package must not contain private project folders or session IDs. Demo fixtures are explicitly labelled.

## Done when

- Model tests and JavaScript syntax checks pass.
- `herdr-app check` passes for the installed mod, and live `status` has no errors.
- Six real panes retain their IDs through balancing and theme changes.
- Both appearances and label languages render correctly.
- Keyboard pane navigation and optional side panel controls work.
- The gallery preview comes from actual rendered, clearly labelled demo terminals.
