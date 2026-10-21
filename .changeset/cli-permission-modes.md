---
"@namzu/cli": major
---

Add the `bypass` permission mode, make `auto` a classifier mode, and let `--yolo` stop asking about ordinary shell commands.

**What breaks**

- `--yolo` and `--dangerously-skip-permissions` now start in `bypass`. Before, they started in a mode that still asked about a path outside the folder (`cat /tmp/x`), a program the command line does not name (`$CMD build`, `$(...)`, `[[ ]]`) and a write to a protected file, and refused all three when nobody could be asked. `bypass` runs them without a question. A `deny` rule, an `ask` rule, the dangerous-pattern floor (`sudo`, `curl | sh`), a catastrophic removal such as `rm -rf ~`, a tool that always needs approval and a sandbox escape still hold, and are asked about (or refused in `exec`). To keep the old, narrower behaviour in a script, leave `--yolo` off and run `namzu exec` with no flag: its unattended default is unchanged.
- `--permission-mode auto` and `/permissions auto` now mean the classifier: a second model checks each call you would otherwise be asked about, and blocks the risky ones. They used to mean "approve everything no gate stopped". Anything that passes `--permission-mode auto` to get no prompts should pass `--permission-mode bypass` (or `--yolo`) instead. `auto` needs a model it can reach (the session's own, or the one `permissions.autoMode.model` names); with none, `exec --permission-mode auto` exits 64 and says why.
- Shift+Tab walks `prompt`, `accept-edits`, `plan`, then `bypass` when the launch opened it, then `auto`, then `prompt`. `strict` leaves the cycle for `prompt`. The footer names each mode: `bypass permissions on` in red, `auto mode on` in yellow.
- The status line's `permission_mode` now carries the word `--permission-mode` takes: `bypass`, `auto` (the classifier) or `unattended` (the headless default). A script that read `auto` as "no prompts" should read `bypass`.
- Desktop: Full access now sends `bypass`, and a new **Auto** row sends `classify`. A conversation that saved Full access before this change still shows as Full access and means `bypass`. Desktop is private and has no changeset of its own.

**What is new**

- `--permission-mode bypass`, and `--allow-dangerously-skip-permissions` makes `bypass` reachable from Shift+Tab and `/permissions` without starting in it. Bypass can only be opened by a flag or by `permissions.defaultMode: bypass` in your own config file or the managed file, never by a project file. The first time a person enters it they are asked once (remembered in `~/.namzu/acknowledgements.json`). It is refused as root outside a container or sandbox.
- New `permissions` settings, beside the tool rules: `defaultMode` (`bypass` and `auto` only from the user or managed file), `disableBypassMode` and `disableAutoMode` (any file closes the door for good), and `autoMode: { model, allow, softDeny, hardDeny, environment }` with `"$defaults"` to keep the built-in rules (user and managed files only). See `docs/cli/permission-modes.md`.
- `accept-edits` also runs `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` without a question when every path they name is inside your folders. After three blocks in a row, or twenty in a conversation, auto drops the conversation to `prompt` and says so; what each classifier pass costs is charged to the turn that asked.
