---
'@namzu/sdk': major
---

a failed request now carries the provider's own account of why, scrubbed

`ProviderRequestError` has always declared a `detail` field. The constructor
never read it, so it existed and carried nothing, and the response body was
parsed to classify the failure and then dropped.

That was deliberate and it was an over-correction. An error body can echo a
request and a request can carry a credential — but a provider rejecting a
request also names the exact offending field, and deleting that sentence turns
a one-line diagnosis into hypothesis elimination against a live API. It did:
the wire spent a day of production downtime repeating
`tools.0.custom.input_schema: … must match JSON Schema draft 2020-12` while the
SDK removed the sentence before anyone could read it.

Scrubbing what is credential-shaped and keeping the rest is the trade that was
actually available. `detail` now carries the provider's message, truncated to
400 characters, with API-key prefixes, bearer headers, cloud access-key ids and
credential-named JSON fields replaced by `[redacted]`. The same text reaches
`message`, so a log line that prints only the message is enough to act on.

It reaches the run too. `ProviderErrorInfo` — the metadata on failed runs and
`run_failed` events — had no `detail` field, so the sentence stopped at the
error object and a host rendering `run.lastProviderError` still had to parse
`error` to learn which parameter was rejected. That is the re-parsing the
structured field exists to avoid, so `detail` is on it now:

```ts
if (run.lastProviderError?.kind === 'bad_request') {
  console.error(run.lastProviderError.detail)
}
```

**Breaking.** The previous contract — "the response body is never interpolated
into the error message" — was documented, and code may depend on it. Two tests
in this repository did. If you log `ProviderRequestError.message` somewhere the
provider's own words must not appear, read `error.kind`, `error.status` and
`error.providerId` instead and build the string yourself; those are unchanged.

What has NOT changed is the `cause` chain: the raw body is still never attached
as `cause`. A `cause` survives every logger that serializes an error chain,
which is the channel that would leak the body regardless of what the message
says.

The strict-subset check learned the same lesson in the same release. Its
deny-list was derived from prose and was wrong in both directions — it refused
`minLength`/`maxLength`, which the wire accepts, so it would have blocked
working tools; and it permitted tuples, which the wire rejects, so it vouched
for a broken one. It is now measured against the live API, and the measurement
runs as a contract test rather than living in a comment. `minItems` in
particular is a bound on the *value*, not a rejected keyword: 0 and 1 pass and
anything above does not, so a required non-empty array is expressible again.
