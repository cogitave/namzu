---
'@namzu/sdk': patch
---

`docs/sdk/observability/logging.md` now covers the whole log pipeline — where a host installs its own sink, what the level/throw/counter contract is, how records correlate to spans, and how to write an adapter for a collector with a nested attribute schema — alongside the `LogAttributes` and log-forging material it already carried. The page joins the documentation standard, and `docs/sdk/observability` joins the docs gate's authoritative set.

The adapter it shows is not typed into the page. It is `packages/sdk/src/__fixtures__/nested-attribute-sink.ts`, embedded verbatim, driven through the real pipeline by a test, and asserted byte-identical to what the page prints — so it cannot compile against an API that no longer exists while still reading as authoritative.
