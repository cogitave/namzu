---
'@namzu/cli': minor
---

`namzu resume` now takes its conversation id as optional: with no id it opens the picker of this folder's conversations, where it used to stop with "Missing required argument". Nothing that passed an id changes; a script that relied on the missing-argument error should test for the id itself.

The terminal also stops showing raw or repeated detail. A write review says "New file" or "Replaces the existing file" instead of always "may overwrite", names the file once, and keeps word boundaries when it wraps; a workflow review's `d` key always shows the script itself. `/context`, `/cost` and `/status` print one plain line per fact, a slash command is shown as typed with its answer under it, the exit hint follows a blank line, the startup header, `/status` and the permission answers write folders from `~`, and the folder trust prompt lists the allow rules and extra folders the folder's own config pre-approves before you answer. The `/resume` picker counts only the messages you and the model wrote. Anything that matched these screens' exact words (a test or script reading terminal output) will see the new wording.

The folder trust prompt now treats Enter as the exit choice (it never trusts); press `y` to trust. Review rows no longer run one cell past the width when a space lands on a full row, which also affects the background jobs, plan approval and tool output panels.
