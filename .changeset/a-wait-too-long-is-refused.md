---
'@namzu/sdk': major
---

**`ProviderRetryConfig.maxRetryAfterMs` now does what it documents.** It said
"past this we surface the error and let the caller decide"; the code fell
through to the ordinary jittered backoff instead, so a provider asking for a
fifteen-minute wait was re-asked in half a second. The documentation was
correct and the code was not.

**What you see differently.** A server-directed `Retry-After` **greater than**
`maxRetryAfterMs` (60s by default) now surfaces the provider error instead of
retrying. A `Retry-After` at or under the ceiling is unchanged — still slept
exactly as instructed — and a failure with no `Retry-After` at all is
unchanged.

Nothing settles differently. The error thrown is the same one the
retries-exhausted path throws, carrying `retryAfterMs`, so a run that used to
fail after four attempts now fails after one, sooner and with the number a host
needs to schedule its own retry. What changes is the attempts in between: they
were sent to an endpoint that had already said it would not serve them, and
they cost the run its budget to rediscover a rate limit it had been told about
in advance.

**If you relied on the old behaviour** — on a provider whose `Retry-After` is
routinely longer than you are willing to wait, and which serves anyway if you
ask again immediately — raise `maxRetryAfterMs` past that value to keep
retrying, or set it low and handle the surfaced error. There is no setting that
restores "ignore the header and back off short", because that was the defect.

**With a provider chain this is where the ceiling pays.** A rate limit is a
fact about the member, not the request, so surfacing it advances the chain to
the next member at once rather than after the primary's whole retry budget is
spent.
