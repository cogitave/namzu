---
"@namzu/sdk": major
"@namzu/computer-use": minor
---

`computer_use` can read a window's controls and act on them by reference, on a host that declares `uiTree` — which the Windows backend of `@namzu/computer-use` now does.

**What changes for a caller of the tool**

- Two new actions when the host declares `uiTree` and implements `uiSnapshot` and `uiAct`: `ui_snapshot { window_id? }` returns the window's accessibility tree as text, each control that can be acted on with a ref such as `e12`; `ui_act { ref, action, value? }` performs `invoke`, `set_value`, `toggle`, `select`, `expand`, `collapse`, `focus` or `scroll_into_view` on it and returns a screenshot afterwards. `ui_act` may be in a batch; `ui_snapshot` may not. Refs count up across snapshots and only the latest snapshot's are accepted, so a stale ref is refused rather than acting on another control. `ActionInput` gains both, so code that switches exhaustively over `input.type` needs two more cases — that is why this is a major release for `@namzu/sdk`.
- `ui_snapshot` is read-only; `ui_act` is destructive.
- `list_windows` now returns its window lines inside an untrusted-content frame (`<namzu-untrusted kind="desktop-windows">`), since titles are whatever each application shows. The lines themselves are unchanged; code that parsed the whole output text needs to skip the frame's three header lines.
- `createComputerUseTool` returns a `ComputerUseTool`, a `ToolDefinition<ActionInput>` with `describeUiRef(ref)` (experimental), which names the control a ref points at for a review screen.
- `UiSnapshot` gains optional `title` and `app`; `UiElement.ref` is empty for an element nothing can be done with. Both types stay experimental.

**`@namzu/computer-use`**

On Windows and WSL with the cua-driver backend, `capabilities.uiTree` is `true` and `SubprocessComputerUseHost` offers `uiSnapshot(windowId?)` and `uiAct(ref, action, value?)`, read from cua-driver's UI Automation walk. A control is invoked in the background, without moving the pointer or bringing its window to the front; a field without a settable value is typed into when it is empty. An action whose driver died mid-request comes back as not done with an unknown outcome, never retried. The PowerShell fallback and the other platforms do not declare `uiTree`, so nothing changes there.
