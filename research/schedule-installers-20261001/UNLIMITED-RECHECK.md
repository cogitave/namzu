# Scheduled agent token limits: unlimited recheck

Date: 2026-10-01. This follows the installed-CLI investigation in
[REPORT.md](REPORT.md); its original diagnostic limits and receipts remain
historical evidence.

## Verified defect and implementation

Ordinary CLI turns already supported unlimited tokens. Scheduled jobs instead
defaulted to 500,000 tokens, rejected an explicit zero, and used a truthy fallback
that discarded a configured zero. The model-facing schedule schema also rejected
zero. These were actual scheduler limitations, separate from the earlier
investigation's artificial 200,000-token allowance.

New scheduled agent phases now default to zero for unlimited tokens. Explicit
positive request/config budgets remain available. Existing saved budgets are
preserved until an operator confirms an edit. CLI/TUI confirmation says no token
limit and omits a numeric daily ceiling for unlimited runs. Pure scripts retain
their zero-model-use semantics; iteration, elapsed-time and provider-wait policies
are unchanged. The CLI default change declares a major release intent, and the
SDK's widened schedule input declares a minor release intent.

## Actual free-model recheck

This run used the **locally built worktree CLI**, with the unlimited changes,
and the same real public Zen `space-bunny-free` provider. It was not the installed
35.0.0 binary and is not an npm release. The private test home and project stayed
isolated; no scheduler service or native Windows installation was performed.

The test project's artificial `limits` mapping was removed. The existing paused
job was edited through a real terminal confirmation with `--token-budget 0`,
`--max-iterations 50` and `--timeout 30m`, restoring normal scheduler iteration
and duration defaults rather than raising the token allowance. The terminal
showed the finite-to-unlimited change before accepting it. The job was resumed,
run once manually and paused again after settlement.

Result, recorded in [unlimited-schedule-receipt.json](unlimited-schedule-receipt.json):

- Exit code **0**, status **completed**, terminal reason **end_turn**.
- **1,438,001** cumulative input/output tokens, with all reported budget snapshots
  showing `limit: 0` and no finite remaining allowance.
- **16** model iterations, **15** successful searches, one successful initial
  write, seven edit calls and two reads.
- One edit was refused because its replacement text matched two locations. The
  model retried with more specific context and succeeded. This was the file
  tool's ambiguity guard, not a missing tool or a scheduler failure.
- Output: `ai-haberler/gunluk.html`, **37,117 bytes**. Chromium rendered the file
  with JavaScript disabled: all nine requested family/sector headings appeared,
  with no scripts or external requests. The model's final summary reported 641
  lines. News accuracy was not independently established by this run.
- Cleanup: saved job paused, no active run, no installed private scheduler
  service and no daemon endpoint. The desktop preview remained available.

The output remains a **local HTML file**, distinct from the originally requested
integrated artifact page. Removing a token ceiling does not implement that absent
host capability, verify the news, or establish future unattended execution.
The model also chose edit/read despite the prompt asking for only search/write;
those tools were offered and permitted by the existing `edit-in-folder` policy.

[collect-unlimited-receipt.mjs](collect-unlimited-receipt.mjs) derives the bounded
receipt from persisted job/run/session records. It excludes prompts, credentials,
reasoning and search bodies. Original terminal, session and render evidence
remains under `/var/tmp/namzu-schedule-space-bunny-3j5QM9/`; the output screenshot
is `unlimited-news.png`.

## Verification

Direct tests exercise zero/finite schema inputs, zero inheritance and overrides,
saved confirmation digests, legacy finite job preservation, truthful preview
wording and real runtime execution beyond the former token default. A finite
opt-in still stops with a distinct token-budget failure. Tests do not depend on
a real-time race.

Workspace typecheck, lint, build, tests (**17,835 passed; 115 skipped**) and the documentation gate passed.
Existing lint warnings outside the changed source remain. No remote push,
release or full release-gate claim is made.
