---
"@namzu/cli": major
---

**The OS sandbox is now off by default.** Shell commands and file tools run
on the host under the permission system, the way other coding agents run
them: each shell command goes through your permission rules and mode, and a
file tool's path outside the working directory and the added directories is
shown to you as an approval request (`Outside the working directory: <path>`)
instead of being refused. It is asked every time — `auto`, `--yolo`, `plan`
(for a read) and an earlier "allow all tools for this session" included —
while `strict` and a `deny` rule still refuse it. **A headless turn refuses it**: pass the
directory with `--add-dir` (or `additionalDirectories`) when an unattended run
needs it. Each answer is an audit record.

**To keep the previous behaviour** (every command confined), write
`sandbox.enabled: true` in `namzu.config.json` or `~/.namzu/config.yaml`. The
sandbox is also on, without that line, when `sandbox.requireIsolation` names a
control or `sandbox.workspace` is `ephemeral`. `sandbox.enabled: false` keeps
working as before.

With the sandbox on, a `bash` call may set `dangerously_disable_sandbox: true`
to run one command on the host. It is asked about every time, `auto` and
`--yolo` included (`plan` and `strict` refuse it); it is refused when nobody can
be asked, unless `sandbox.allowUnattendedEscape: true`; `sandbox.allowEscape:
false` refuses it always. Each approval or refusal is an audit record.

`/add-dir` of a directory outside the working directory now asks before adding
it, deciding after links are followed (a link inside that points outside is
asked about under the path it leads to, and that canonical path is what is
added). A directory inside the working directory is no longer added: the tools
already reach it. The system prompt states where tools run and how to reach past that, and
on WSL where the Windows drives are and how to start a Windows program.
