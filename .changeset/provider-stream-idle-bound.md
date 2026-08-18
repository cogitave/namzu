---
'@namzu/sdk': major
---

Bound provider stream silence, including RouterAgent routing decisions, to five
minutes by default and abort the stalled provider transport, with
network-classified retry and fallback recovery. This changes the previous
default, under which a provider iterator could remain silent forever. Set
`streamIdleTimeoutMs: 0` on the run or agent config to keep the old unbounded
behavior, or set a positive millisecond value to choose a different bound.
