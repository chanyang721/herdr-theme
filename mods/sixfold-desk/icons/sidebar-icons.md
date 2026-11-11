# Sidebar artwork

`device-*.svg` and `ws-*.svg` are original geometric line drawings made in this repository, under the repository Apache-2.0 license. No downloaded icon set or external assets are used.

Device OS selects laptop (macOS), desktop (Windows), tablet (iPadOS), phone (iOS/Android), or generic computer (unknown/Linux). Tailscale may report iPads as iOS; an explicit iPad device-name prefix selects the tablet silhouette. OS alone cannot prove the physical hardware model. Local Mac uses a laptop silhouette. Remote entries can specify `computers.local.json` → `machines.<name>.os`.

Workspace marks: common hub, Voice microphone, Herdr terminal, generic folder; project marks such as flower or house/cross come from `site.local.json` → `workspaces.<name>.icon`. Existing `workspace-icons.json` images take precedence. Saved `space.colors` are reused; other colors retain the deterministic sidebar fallback. Marks are 16px with 12px artwork, device art 14px; connectivity dots remain separate.

Connectivity labels distinguish local Mac, Herdr registered remote layout state, and Tailscale discovery. Tailscale Online is never evidence of SSH connectivity. Missing Online values stay unknown.

`linear.svg` is an original rounded-square-and-check line drawing for the issue-tracker inbox badge, made in this repository (not a vendor logo).
