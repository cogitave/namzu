# Desktop visual audit — 2026-10-01

## Evidence and conditions

The operator's reference image and T3 Code's checked-in
`apps/marketing/src/assets/app-desktop.webp` show a compact project sidebar,
quiet conversation canvas, rounded composer and a separate work panel. Source
components and CSS were read at the revisions pinned in `DESIGN.md`; neither
peer application was installed or run. Image proportions describe that capture,
not measured DOM values from a running peer application.

The local capture uses real Electron, preload, CLI ACP and kernel on Linux/WSL2,
at 1180×791, 100% scale and dark appearance. Only model I/O is scripted. A real
foreground shell, background process, approval and queue produce the visible
content. The draft and scroll position in the conversation capture are intentional.

## Shared layout and intentional identity

| Element | Local DOM/style evidence | Decision |
| --- | --- | --- |
| Sidebar | 256px; project groups, conversation rows and title search | Adapt source primitives and compact hierarchy |
| Topbar | 52px; breadcrumb and background-work action | Keep a quiet horizontal header |
| Composer | 22px corners; 784×152 in the wide capture | Actual imported glass surface and compact model menu |
| Message type | 14px / 24.5px line height | Readable conversation text independent of 16px root rem geometry |
| Model trigger | 146×28; 13px type | One keyboard-aware popover instead of exposed configuration fields |
| Canvas / sidebar | `#0b0f0c` / `#080b09` | Namzu's CLI identity on quiet dark surfaces |
| Accent | `#5fff5f`, light `#176b29` | CLI ANSI 83 phosphor for actions, focus and wordmark; readable light-theme variant |
| Wordmark | Exact CLI two-row lettering in sidebar and welcome | Namzu identity; no peer logos or product names in app source |

The native receipt and `artifacts/ui-measurements.json` contain the computed
values. The right column exposes actual Namzu background shells. The reference's
Git diff editor is not represented by an invented or disconnected editor.

## Motion and interaction

- Panel travel: 220ms, `cubic-bezier(0.22, 1, 0.36, 1)`; opacity: 160ms ease-out.
  The native probe observes the open-state mutation in the browser, pauses real
  CSS animations, samples their midpoint and explicitly finishes them. The
  transform moves from the sampled 14.67px offset to zero. No elapsed-time
  assertion determines success.
- Menus retain the source scale/fade and focus handling; project groups retain
  the source height transition. New messages/reviews use a 5px, 220ms arrival;
  streaming text updates keep the mounted row and do not restart its animation.
- Pending tool status uses the source's quiet passing highlight, adapted to
  local tokens. Settled and interrupted tools do not keep shining, including after a new turn. Buttons have short colour
  changes and a small send press response.
- Reduced motion disables CSS animations and transitions. The native probe sees
  zero panel animations. Closed panels become inert and hidden to assistive
  technology immediately, including while their visual exit finishes.
- Verified keyboard cases: model-menu Escape/focus return, IME, Shift+Enter,
  conversation search, appearance persistence and narrow sidebar Escape.
- At 600×540 the closed sidebar is not visible or keyboard reachable; the model
  popover remains within the viewport. No horizontal document overflow occurs.

## Captures and limits

`artifacts/` includes welcome, conversation, approval, background work, model
menu, light appearance and narrow-window captures. Source license/provenance
notices are retained separately and copied into the build.

This verifies the implemented Namzu slice against the chosen source geometry and
operator identity. It does not claim pixel parity across every reference screen,
Windows/macOS native validation, installer distribution or published availability.
