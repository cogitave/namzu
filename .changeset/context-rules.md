---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Context limits follow Claude Code, and every new rule that stops something is opt-in in the SDK. Nothing a host gets without asking changes in this entry.

SDK, all additive:
- `query({ maxOutputContinuations })` caps the nudges after a reply is cut at its output limit; past the cap the turn stops with the new stop reason `output_limit` (a host that switches exhaustively on `StopReason` should handle it; it only occurs with the option set). Unset keeps today's behaviour (no cap beyond `maxIterations`). A cut during reasoning, before any text or tool call, now gets its own "think more briefly" nudge instead of being treated as a finished reply.
- `compactionConfig.circuitBreaker: true` switches automatic compaction off for the turn after three failed passes, and stops the turn after three compactions each followed by a refill within three iterations. `compaction_failed` gains the causes `breaker_open` and `refilling`; a host that switches exhaustively on `cause` should handle them (they only occur with the option on).
- A provider failure saying "input length and `max_tokens` exceed context limit: A + B > C" is retried once with `max_tokens = C - A - 1000` (not below 3,000, and only when smaller than the cap just tried). This is on for everyone: it turns a failure into a retry and changes no successful call.
- `compactNow`, `compactRegion` and `compactSession` accept `instructions`, the person's words about what the summary must keep; they run the verifier model step even when `llmVerification` is off.

CLI:
- The footer shows `N% until auto-compact` once the context is within 20,000 tokens of the summary point, with the read-out counted against the real trigger.
- `/compact <text>` steers the summary.
- The CLI turns on `maxOutputContinuations: 3` and `circuitBreaker`, so a looping model or a window that refills stops the turn with a one-line explanation.
