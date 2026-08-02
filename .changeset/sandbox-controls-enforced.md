---
'@namzu/sandbox': minor
---

Two blast-radius controls that were accepted and silently dropped.

**The standby-pool backend discarded every per-sandbox control.** Its create
function took its options parameter underscore-prefixed and never read it,
and the request body it assembled carried no resources, no environment
variables and no network policy — while the provider faithfully assembled
all of them first. A host that set `deny-all` and a 512 MB cap got full
outbound network, no memory cap and no process cap, with no error and no
warning, from the same call shape that **is** enforced on the sibling
container backend. Switching backends silently removed the controls.

The claim API rejects every property override except a config map, so these
genuinely cannot ride through per sandbox — which makes refusing the honest
fix rather than a missing feature. It now throws, naming every field it
cannot honour rather than the first, and saying where the limits do belong
(the container group profile the pool is built from). namzu already held
this norm next door, with the rationale in that backend's own comment: a
policy accepted and quietly ignored is worse than one that is refused.

**`allow-all` and `resolver` encoded identically on the microVM backend.**
Both resolved to an omitted allowlist, so one encoding carried two opposite
intentions — and the `resolve()` callback that produces a tenant-scoped list
was never invoked anywhere in the repo. Whichever way the orchestrator reads
an omitted field, one of the two was always mis-enforced, and the one that
failed **open** was the one whose entire purpose is restriction.

Each variant now has its own encoding: `allow-all` omits, `deny-all` sends
an explicitly empty list, `static` forwards its hosts, and `resolver` calls
`resolve()` and forwards the result — including an empty result, which is a
real deny-all and not an absence. The switch is exhaustive, so a new variant
fails to compile rather than falling through to unrestricted, and a resolver
that throws propagates instead of degrading to open.

The README's backend-by-policy table was wrong in both directions and is now
accurate. Neither backend had a test directory; both do now.
