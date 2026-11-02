---
"@namzu/cli": major
---

Ctrl+T now shows or hides the model's task checklist above the message box (every task, at most five rows, the rest counted as `… +N more`) and no longer opens the agents cockpit. The footer says `ctrl+t to hide tasks` or `ctrl+t to show tasks` while the model has tasks, a task the model creates or changes opens the list, and your own press is saved as `tui.showExpandedTodos` in your user config (a project file cannot set it). To reach the cockpit use `←` or `↓` on an empty message box, or Enter on an agent row in `/tasks`; with text already typed, empty the box first. `/agents` is removed with no replacement command: the running and finished subagents are rows in `/tasks`, and `/agents available` (the configured roster) and `/agents batches` (past batches) have no equivalent. The working line's `ctrl+t to view` now reads `↓ to view`.
