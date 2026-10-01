# Schedule, installers and Resume investigation — 2026-10-01

## Scope and evidence

The actual installed CLI **35.0.0**, Zen `space-bunny-free`, and its real terminal
interface were used. This was not a mocked provider or desktop preview. A private
test project and `NAMZU_HOME` isolated the conversation and schedule records.
The public Zen credential prevented paid-key fallback. No scheduler service,
native Windows Namzu installation, release or remote Git action was performed.

Source changes were made in the existing owned worktree, based on `5e0201f9`.
That worktree contains unpublished functionality; its schedule source-delivery
fields must not be described as present in the installed 35.0.0 package.

The bounded, replayable evidence is [tui-schedule-receipt.json](tui-schedule-receipt.json).
It excludes credentials, system prompts, reasoning text, web result bodies and
generated file content. [collect-receipt.mjs](collect-receipt.mjs) extracts these
fields from retained session logs. Original local evidence remains under
`/var/tmp/namzu-schedule-space-bunny-3j5QM9`.

## Actual TUI and scheduled run

The original request was daily AI news at 10:00, grouped by model family, in an
artifact page. The offered tools included `schedule`, `web_search`, `write` and
`skill`. They contained no artifact/page service and no `web_fetch`.

The model read the bundled skill directly from an absolute package path and
searched package source for an artifact facility. Those read/bash calls succeeded
after ordinary approval. The first two turns reached the diagnostic 300-second
cap, including time spent waiting for approvals. These timeouts do not establish
the user's original tool failure. The offered `skill` loader and tool roster were
sufficient to discover the relevant capability boundary without package scans.

A separate, explicitly agreed fallback requested a **local HTML file**, rather
than an artifact page. The first proposal referenced `web_fetch` despite its
absence. Its review was accidentally cancelled by test input; the resulting
operator-not-confirmed error is not classified as a runtime defect. The model
then recognized the missing tool and submitted a corrected proposal.

The corrected real schedule call succeeded, and its native review saved the job
paused. The persisted definition pins `zen/space-bunny-free`, the existing test
project, cron `0 10 * * *`, and `Europe/Istanbul`. Permissions are
`edit-in-folder`, `web_search: allow`, `bash: deny`, `unmatched: deny`.
The tool correctly states that no scheduler is installed and does not promise
daily execution merely because the job was saved.

The test job was temporarily resumed and executed once with `schedule run-now`.
It made **16 successful `web_search` calls** over four batches. No unknown-tool,
schema, malformed-JSON, permission refusal or retrieval service error occurred.
Search results totaled **249,007 characters** including their untrusted frames.
The fifth model iteration ended with **`token_budget`**, before any `write` call
or HTML file existed. The run result records status `failed`, exit code 1,
220,467 cumulative tokens and `the turn did not finish normally: token_budget`.

| Model iteration | Measured input context | Cumulative input + output | Remaining diagnostic budget |
| --- | ---: | ---: | ---: |
| 1 | 9,858 | 10,123 | 189,877 |
| 2 | 32,447 | 42,887 | 157,113 |
| 3 | 43,128 | 86,579 | 113,421 |
| 4 | 56,491 | 144,925 | 55,075 |
| 5 | 67,350 | 220,467 | 0 |

The 200,000-token, 12-iteration and 300-second limits were **diagnostic choices**,
not proof of the user's configuration or Namzu's defaults. This run reproduces
budget exhaustion with successful tools; it does not reproduce the unspecified
tool error the user saw. Repeated input, including cached input, counts toward a
token budget. A one-million-token context window does not guarantee a turn can
finish within that budget. Several tools in a batch are one model iteration.

After the run, the job was paused again, no active run remained, the private
scheduler service and daemon endpoint were absent, and the diagnostic TUI exited
normally. The desktop live preview remains running and answered HTTP 200.

## Confirmed capability gaps and scoped improvement

- `write` saves files; neither the scheduler nor the SDK's opaque `DeliverableRef`
  provides an integrated artifact page. The desktop bridge has no artifact
  inventory/save/preview API. Source-conversation schedule delivery in the owned
  worktree is a bounded host notice, not an artifact renderer.
- Permission rules authorize mounted tools. They do not enable optional
  `web_fetch` or create a page service. A saved prompt can therefore request a
  tool its eventual run cannot call.
- The Exa request asks for bounded context, but broad multi-query research still
  retains enough content to consume the cumulative budget before producing output.
  No search-body clamp or compaction threshold was changed in this patch.
- The bundled schedule skill now explains the actual tool/output check,
  permission/mount distinction, cumulative budget and iteration semantics.
  This is guidance, not deterministic capability preflight or a new artifact API.

Follow-up architecture should give deliverables durable identities and explicit
host storage/preview/export capabilities, bind them to the source conversation,
and validate required capabilities before job confirmation and execution. Research
recipes should collect a bounded set of sources and reserve result-writing
capacity. Any default/output contract changes need explicit release intent.

## Installer and Resume findings

Native Windows read-only checks found PowerShell 5.1, Restricted policy, Node
22.20.0 and working npm.cmd. `irm` is not a Command Prompt command. Bare `npm`
in PowerShell selected npm.ps1 and was refused by policy; npm.cmd worked. There
was no native Windows Namzu command in this machine's npm prefix. These facts
do not identify the failure on another computer or prove a complete live install.

Both installer sources hid failed npm diagnostics. The POSIX installer accepted
nonempty version output even when that command exited with an error. PowerShell
already used `.cmd` shims and checked version exit codes, but its next-step text
suggested bare commands that Restricted policy can refuse.

The existing Resume resolver explicitly skipped public-command discovery on
Windows, explaining Node plus `dist/bin.js` handoffs for ordinary npm installs.
Scheduled Resume commands separately assumed POSIX `cd … && …` and quoting,
which is unsuitable for Command Prompt and Windows PowerShell 5.1.

### Implemented fixes

- Preserve failed npm stdout/stderr; keep successful installation chatter quiet.
- Reject failed or empty POSIX version verification.
- Print `namzu.cmd` followups on native Windows without changing execution policy.
- Recognize the standard npm Node `.cmd` shim only when its full wrapper and
  canonical target match the running CLI. Conflicting, unreadable or unknown
  wrappers retain the explicit executable; source loader arguments remain intact.
- Share Resume shell formatting. Native Windows schedule handoffs use
  `Set-Location -LiteralPath …; if ($?) { & 'namzu.cmd' … }`; POSIX output is retained.
- Give WSL PowerShell installer mocks a Windows-backed working directory. The
  unchanged old suite timed out before its first output from the Linux worktree,
  but passed 3/3 from `/mnt/c`; that was a test launch defect, not an installer
  assertion failure.

Verification includes **11/11 safe installer mocks** (six POSIX, five real
PowerShell 5.1 under Restricted policy), **20** direct invocation tests and
**23** scheduled/TUI handoff tests. The native
[argument proof](native-resume-proof.mjs) additionally executed the generated
PowerShell command against a process-local function, preserving apostrophes,
spaces and literal `$()` text, and proving a failed directory change cannot
invoke Resume. Its [receipt](native-resume-receipt.json) records success.
It did not launch an installed Namzu or change persistent configuration.

`sh -n install.sh` passed. `dash` is unavailable here; its syntax gate was not
claimed. The installation commands and fallback behavior are documented in
[Installing and reopening Namzu](../../docs/cli/installation.md).

## Local validation of the patch

Workspace typecheck, lint, build and tests passed. Workspace tests reported
17,807 passing and 115 skipped tests; the SDK had 9,649 passing tests and the CLI
had 4,755 passing and five skipped tests. Lint retains existing warnings outside
the files changed here. The OKF documentation gate passed for 130 pages.
The standalone installer tests and native Resume probe also passed from the
owned worktree. This is a local patch validation, not a claim that every release
gate ran or that the changes reached npm.
