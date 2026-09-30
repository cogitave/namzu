# Desktop visual audit — direct composition, 2026-10-01

## Reference and conditions

The user rejected the previous independently composed UI. This revision ports
selected composed render branches as well as the primitive controls from the
pinned source in `DESIGN.md`. License/provenance remains in the shipped notices.
No peer product names or logos are used in renderer source.

The independent reference harness copies the original ComposerSurface,
ComposerControl, WorkspacePageHeader, Button and complete source CSS into a
private Vite root. Card/timeline/footer render literals are checked against
original source before rendering. Runtime/store/account code is not installed.
It opens a separate native window with the same viewport, dark theme, message
content and composer draft as Namzu. Both captures use transcript scroll offset
zero. Completed tool rows are outside the selected reference comparison;
`native-diff.png` separately shows actual Namzu tool results and file changes.
This is evidence for selected component geometry and typography, not a claim
that the full peer application was run or that every screen is pixel-identical.

## Component mapping

| Element | Direct source composition | Namzu binding |
| --- | --- | --- |
| Sidebar | 256px; source search/scope row and 78px three-row cards | Actual projects, titles, activity and running/review state |
| Titlebar | 52px and shared workspace gutters | Current project/conversation and working side-panel controls |
| Timeline | Source user bubble and assistant prose classes, 14px type | Literal user text and safe Markdown; no HTML or remote media |
| Composer | 48rem max width, 22px host radius, body/footer/context strip | Real draft, model selection, queue/send/stop, project context |
| Draft entry | Source centred empty-conversation composition | First message docks the same composer with measured motion |
| Changes | Source changed-files header and installed diff surface/CSS | Completed bounded ToolCallView previews; unified/split/wrap |
| Empty state | Source EmptyHeader/Title/Description composition | Real open-folder/trust/new-conversation actions |

`artifacts/reference-comparison.json` records local and independent source
computed styles for the selected components. Equal geometry and typography
are asserted by the harness, not inferred from the build. The phosphor action,
focus and wordmark colours are intentional operator identity differences.

## Native execution and interaction

The harness uses Electron on Linux/WSL2 and the actual CLI ACP process/kernel.
Only provider I/O is scripted. Real foreground and background shell processes,
three distinct tool approvals and a real file creation produce the screenshot
content. Open diff must contain the created file text. Its mode and wrap actions
are tested before the panel closes.

The flow also verifies pending-review and queue retention on reload, correct
model routing, durable history after app restart, title search, project-scope
menu keyboard closure/focus return, IME, Shift+Enter, appearance persistence and
narrow-window navigation. The 600×540 viewport must have no horizontal overflow;
the model menu must fit and the closed sidebar must be invisible. The renderer
has no Node API. Panel animation is sampled and finished through browser
animation controls; reduced-motion produces no panel animations.

## Evidence and limits

`artifacts/` contains matching source/local presentation captures and native
welcome, conversation, approval, diff, background work, model menu, light and
narrow captures. `native-receipt.json` records the actual runtime result.
The preview is source-built and private. This revision does not establish
Windows/macOS native behaviour, signing/installers or published availability.
