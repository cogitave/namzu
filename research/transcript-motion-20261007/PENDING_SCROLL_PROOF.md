# Pending reader restoration races

[pending-scroll-races-e0661714-9b0eaf9b.json](artifacts/pending-scroll-races-e0661714-9b0eaf9b.json) passed five actual App cases against unchanged renderer source. App SHA-256: `b0949cfc8699d7e9503bcdf715079270cb780702ca12dce9b15b362719960a35`. The CSS remains the fixed-hover version `df4b65b5`.

The isolated 1280 × 900 dark preview uses two long synthetic conversation histories, eight work disclosures, explicit history promises and a virtual JavaScript clock. These are fixture conversations, not user messages. The app's presentation writer runs normally; the proof never directly writes its presentation entries.

| Case | Held state | Observed result |
| --- | --- | --- |
| Cold A, then navigate B before A history returns | A has no work tree; DOM offset 0, saved offset 1230 | A retains saved offset 1230 and `follow=false`; releasing A cannot move B; returning to A restores its original reader identity and offset |
| Actual mouse wheel | Retained A visible at 1872; older saved restore 1230 | New offset 1692 survives history release, save and cached return |
| Actual PageUp | Retained A visible at 1872; older saved restore 1230 | New offset 1158 survives history release, save and cached return |
| Actual work disclosure click | Retained A visible at 1872; older saved restore 1230 | Offset 1872 and all three manually opened disclosures survive release, save and cached return |
| Programmatic scroll control | Retained A visible at 1872; plain scroll assignment 400 | The pending original reader at 1230 still restores after release |

Reader comparisons include message key, phase, content identity, scroll offset, anchor offset and remaining distance from the end. Wheel and PageUp use actual Playwright input. Their real trusted `scroll` and `scrollend` events are awaited directly before measuring the settled reader. PageUp's intermediate first scroll event is retained in the successful receipt; no wall-clock polling or deadline decides the outcome. Initial positions use explicit synthetic reader setup, which is separate from the trusted input cases.

Two earlier failed unique receipts remain unchanged. They exposed premature runner samples before the wheel movement and before PageUp's native scroll motion completed; the final proof awaits actual completion and preserves strict reader comparisons. There were zero browser page errors, native actions and provider requests. This proof does not claim that the App changes have already been delivered to the native app.

Reproduce from the repository root:

```sh
node research/transcript-motion-20261007/motion-proof.mjs . --pending-scroll-only
```

The original disclosure/reader persistence proof was rerun because the shared history-gate fixture changed. [disclosure-persistence-e0661714-2e79d0ad.json](artifacts/disclosure-persistence-e0661714-2e79d0ad.json) also passed against this same App source, covering cold deferred reload, exact reader restoration, distinct same-turn choices and cross-owner explicit false.

The prior hover, disclosure persistence and native receipts are preserved. Each new run writes a unique source-bound receipt.
