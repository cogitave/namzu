---
"@namzu/sdk": major
"@namzu/cli": major
---

A scheduled job can now be a fixed shell script instead of a model prompt, or a cheap "wake-gate" script that decides whether to run the model at all — `namzu schedule add --kind script|script+agent`, or the model's `schedule` tool with `kind`/`script`. A `script` job spends zero tokens and opens no session; a `script+agent` job runs a gate script first and calls the model only when it prints `{"wake": true, "context": "..."}`. Both go through the same scheduled-run floor and the job's own permission rules a live `bash` call already gets, evaluated once, at confirm time, as one command.

**`@namzu/sdk` (major)**

- **Breaking:** `ScheduleJobDraft.prompt` is now optional (`prompt?: string`), since a pure `script` draft has none. Any `ScheduleToolHost` implementation that reads `draft.prompt` as a bare `string` needs a null check (or to keep reading it only when `draft.runKind` is `'agent'`/`'script+agent'`, where it is still guaranteed present).
- `ScheduleJobDraft` gains `runKind?: 'agent' | 'script' | 'script+agent'` (absent = `'agent'`, unchanged from before) and `script?: { body, shell, timeoutMs? }`. `ScheduleJobPreview` gains the same `runKind`/`script` fields so a host's confirmation screen can show the exact text.
- The `schedule` tool's input schema gains `kind` and `script`; `create` requires `script` unless `kind` is `'agent'` and requires `prompt` unless `kind` is `'script'`, and refuses an agent draft that also carries a script. The existing network-beside-a-host-shell refusal now also covers a `script`/`script+agent` job on the host: the script IS shell code, not a rule a live call might reach later.
- New exports from the root entry: `execHostShell`, `ExecHostShellProgress`, `CommandShell`, `CommandShellProbe`, `findCommandShell`, `hostCommandShell`, `hostShellSpawn`, `withoutBashStartup` — the shell-resolution and spawn machinery the `bash` tool already used internally, now available to a host that runs a command line outside a live tool call.

**`@namzu/cli` (major)**

- **Breaking, on disk:** the job/run-result/history file format moves to `v: 2` for a job that actually uses `runKind`/`script`, a `check-failed` status, or `gateResult`/`scriptOutput`. An older namzu that reads such a file refuses it loudly ("was written by a newer namzu...") rather than misreading a script job as a malformed agent job. A plain `agent` job stays `v: 1`, byte-for-byte as before, and every existing job keeps reading and confirming exactly as it did — downgrade only affects a job you have actually converted to `script`/`script+agent`.
- New `schedule add`/`edit` flags: `--kind agent|script|script+agent`, `--script`/`--script-file`, `--shell bash|sh`, `--script-timeout`. A `script` job needs `--shell` and a non-empty script and has no `--prompt`; `--unmatched park` is refused for a pure `script` job (nothing can wait for the operator mid-script); `--execution sandbox` is refused for `script`/`script+agent` in this release; `script`/`script+agent` job creation is refused outright on native (non-WSL) Windows, where the only available shell reading is a loose `cmd.exe` approximation the floor cannot fully verify.
- `ScheduleRunStatus` gains `check-failed` (a script or wake-gate malfunctioned: non-zero exit, its own timeout, or stdout that is not the wake-gate's JSON contract) — CLI-internal, not part of the SDK's public surface. It joins the failure bucket for the failure streak and automatic pause, and gets its own notification and `noticeText` case.
- `schedule show`/`history --json` gain `gateResult` (`{ wake, contextChars }`) and `scriptOutput` (`{ stdout, stderr }`, capped with an explicit truncation marker) on a fired `script`/`script+agent` run; `show`'s text view gains a "Script"/"Wake-gate script" section beside "Prompt".

Upgrade step: nothing changes for an existing `agent` job. Adopting a `script`/`script+agent` job on a `NAMZU_HOME` you may downgrade the CLI on later means that job's files become unreadable by the older version until you upgrade again; keep that in mind before converting a job you might need to roll back.
