---
'@namzu/sdk': minor
---

Observe a background server's output without waiting for it to exit. `BackgroundJobRegistry.waitForOutput` and the optional `BackgroundJobRegistryRef.waitForOutput` match a bounded UTF-8 literal on stdout, stderr or either pipe independently, preserve combined byte cursors, and report match, exit, stop, timeout or cancellation outcomes with explicit retention gaps.

Set `output_contains` and optional `output_stream` on `wait_for_job` for one readiness observation. This mode never marks the process as work that must hold a finishing turn open. Omitting the condition preserves the existing exit wait. Custom hosts must implement the optional output-observation method to support readiness; unsupported hosts refuse it rather than waiting for exit. Observers have per-owner and registry limits and are cleaned up on every outcome. Process output remains evidence, not a guarantee of service health.

Byte caps and cursors now skip partial UTF-8 code points and report those skipped bytes instead of introducing replacement characters into the retained output.
