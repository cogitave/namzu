---
'@namzu/sdk': patch
'@namzu/bedrock': patch
---

Overflow reaches the rescue that exists for it.

Overflow is the one 4xx the runtime can act on: it sheds history and
retries. Everything else in the 400 family is surfaced. So the rescue is
gated on the code being **exactly** `context_length_exceeded`, and anything
that misses that gate dies holding the remedy.

Three things missed it. Measured before and after, five of six realistic
overflow shapes never reached relief; now all six do.

- **The structural code was extracted and then discarded.** The cause-chain
  walk returned the first `code` it found and fed it only to the two
  transport-errno sets, so a provider that said `context_length_exceeded` in
  the one field designed to say it was answered with a substring search that
  did not match. A structural code is now consulted **before** the status,
  because it is strictly more specific: a 400 is a category, the code is the
  diagnosis. The gateway `type` discriminator and a nested error envelope
  are read the same way.
- **The phrase list missed the common wordings.** "too long for", "maximum
  length", "exceeds the maximum", "input is too large" all fell through to a
  plain non-retryable invalid request.
- **The Converse driver pre-filed `ValidationException` as
  `invalid_request`.** That name covers both a malformed request and a
  prompt past the model's window, and only one of those is recoverable — so
  guessing from the name made the recoverable case unrecoverable by
  construction, because the shared classifier short-circuits on an error
  that already carries a code and never read the body. It now hands that one
  name to the classifier. The result is still a `ProviderError`, so the
  driver's contract is unchanged; it just stops answering a question it
  cannot answer from the name alone.

The rate-limit half of the same class is fixed alongside: a provider that
reports `rate_limit_exceeded` structurally under a 400 is now retryable
instead of being filed as a bad request.
