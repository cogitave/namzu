---
'@namzu/sdk': patch
'@namzu/bedrock': patch
---

Retry now works on the bedrock driver, and the shared classifier reads a
status wherever a vendor hides it.

An unclassified error is treated as non-retryable, which is the right
default — but it meant the retry policy was effectively dead on this
driver, and the one failure most worth backing off from was the one that
killed the run. The service reports failures as named exception classes,
and the classifier looked at neither the name nor the status, because the
status lives in a metadata bag rather than on the error.

- `classifyProviderError` now also reads `$metadata.httpStatusCode`. A
  status is a status wherever it hides, and this helps any driver — first
  or third party — whose SDK reports it that way.
- The bedrock driver maps its own exception vocabulary to provider error
  codes: throttling and quota to `rate_limit`, unavailable and not-ready to
  `overloaded`, internal and stream faults to `server_error`, and the
  non-retryable ones (`ValidationException`, `AccessDeniedException`,
  `ResourceNotFoundException`) to their exact codes so they fail fast
  instead of burning the retry budget.

The vocabulary lives in the driver rather than the shared classifier: a
driver knows its own vendor's error names, and the classifier should stay
generic. An unrecognised exception passes through untouched — an honest
unknown beats a confident wrong classification.
