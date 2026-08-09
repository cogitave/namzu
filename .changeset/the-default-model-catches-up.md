---
'@namzu/cli': major
---

The default model is current again, and says whose default it is

**namzu's default Claude model changes from `claude-opus-4-7` to
`claude-opus-5`** for the Anthropic provider, and from
`anthropic/claude-opus-4-7` to `anthropic/claude-opus-5` for OpenRouter. Two
generations had passed. Nothing errored — a run simply happened on an older
model than the operator had any reason to expect, which is why it went unnoticed.

**To keep the old model**, pick it in `/model`, or set it in
`~/.namzu/preferences.json`:

```json
{"version": 3, "providers": [{"id": "anthropic", "model": "claude-opus-4-7"}]}
```

A saved preference already wins over this constant, so anyone who has chosen a
model is unaffected.

**The picker now labels it `(namzu default)` rather than `(default)`.** It was
described in the code as "the provider's own default", which it never was — this
is a value namzu picks, it goes stale between provider releases, and an operator
choosing from that list deserves to know it is a choice rather than an
endorsement.

Resolving the default at runtime was considered and rejected: it would buy a
network call, a cache, and a staleness question on every launch, and the offline
path is exactly where this defect would come back invisibly. The constant stays,
with the obligation to re-check it at each provider release written where the
constant is defined.

The Bedrock default is **left unchanged and marked unverified.** That driver
speaks the Converse API, whose ids are date-stamped
(`<vendor>.<model>-<yyyymmdd>-v<n>:0`); the current value carries the version
suffix but no date, so it fits neither that shape nor the newer bare alias.
Nobody here has a credential to establish which the endpoint accepts, and a
fabricated date would look authoritative while being a guess. That provider has
no bundled driver in this build in any case, so the value is unreachable today.
