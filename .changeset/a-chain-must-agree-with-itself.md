---
'@namzu/cli': minor
---

Refuse a provider chain whose members declare different capabilities

namzu negotiates capabilities once per run, against the provider it was handed,
and that answer decides whether tools go into the prompt and whether image and
document attachments are mapped. A chain whose members disagree cannot be
honoured by taking the strongest declaration — a run that fell over to a weaker
member would arrive holding a request shaped for a provider no longer serving
it.

Nor by taking the weakest. That is the trap this refuses to walk into: an
operator who adds a weaker fallback to gain resilience would find their
**primary** had quietly lost tool support, on every run, to guard against a
failure that happens rarely. A capability given up permanently for a rare
benefit, with nothing saying so.

So neither is chosen for you. A disagreeing chain is refused, naming which two
members disagree and on what:

```
  - fallback #1 (<label>) declares it cannot call tools, while primary provider
    (<label>) declares it can call tools — if the chain falls over to it, tools
    become unavailable.
```

Every disagreeing capability is listed, not just the first, so the configuration
can be fixed in one pass rather than one round-trip at a time.

**To accept the limitation**, set `"allowCapabilityMismatch": true` in
`~/.namzu/preferences.json`. The chain then runs and the disagreement is printed
on **every** launch — the TUI, `namzu run`, and a `notice` event on
`namzu run-stream`. Not once: an acceptance given once and forgotten is how a
silent degradation returns through the front door.

Two limits, stated because a check that overstates its authority stops being
believed:

- It compares **declarations**, at the type level. That is what is knowable
  without constructing a provider, and constructing one needs a credential —
  which the fallback nobody has set up yet does not have. The runtime treats a
  constructed provider's own declaration as authoritative.
- It says nothing about the current run. Only the primary runs today, so its
  capabilities are in force in full; every sentence is about what happens *if
  the chain falls over*. When failover lands, the run-level statement becomes
  true and can be made then.

A member whose declaration cannot be read — a provider with no construction path
yet — is reported as unresolved rather than assumed to agree, and does not by
itself refuse the chain.

Adds `AgentSession.configNotices`, the channel these are surfaced on.
Single-provider setups are unaffected and gain no new output.
