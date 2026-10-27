---
'@namzu/cli': major
---

With `sandbox.enabled: true` on a machine whose sandbox confines both the file system and the process table (`linux-bwrap`, `macos-seatbelt`), a `bash` command that stays inside the sandbox now runs without the approval question in `prompt` and `accept-edits` mode; before, every such command asked. A command that asks to leave the sandbox is still asked about every time, the dangerous-command floor and your `ask` and `deny` rules still apply first, and file changes ask as before. The footer's resting hint and the mode descriptions say that sandboxed commands run unasked. To keep asking about every command, add a rule that asks (for example `bash = "ask"` under `[permissions]`) or leave the sandbox off, which is the default.
