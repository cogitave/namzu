---
'@namzu/sdk': minor
'@namzu/anthropic': minor
---

A caller can ask which effort levels a model accepts.

The answer existed, was modelled carefully, and was reachable only from inside
one driver. That matters because effort is **refused, not clamped**: a level a
model does not have makes the vendor reject the request, so a control offering
the wrong one produces a run that fails at the start rather than a quieter one.

Every option open to a caller without the answer was bad. Offering all five
breaks some models. Offering the intersection hides `xhigh` and `max` from every
model that has them, which is most of the reason to build such a control. And
copying the table looks fine and is worst: the ceiling has moved twice already,
so a copy goes stale on the next model and goes stale **silently**, surfacing as
a vendor rejection rather than a failing build.

**New optional `LLMProvider.effortLevelsFor(model, thinking?)`.** Three states,
each meaning something different: the method absent means the driver has no
effort concept at all and setting one will be refused; an empty array means the
driver implements effort and this model has none; a non-empty array is the set
to offer.

**`thinking` is a parameter, and that is the point.** At least one model family
accepts a narrower set while thinking is disabled than while it is on — so an
API returning two sibling arrays invites a caller to render a picker from one
and send the other, a combination the vendor rejects, on exactly one family.
Passing the configuration you will actually send makes that unspellable: there
is one answer and it is the one for your request.

The driver's implementation shares the same two resolution steps the request
path uses, so a caller's picker and the request it produces cannot disagree.

`@namzu/anthropic` also now exports `resolveThinkingCapability`,
`resolveThinkingBody`, `resolveEffort` and their types, for a caller that needs
the fuller picture — whether thinking can be switched off at all, not only which
effort levels apply. Prefer `effortLevelsFor` where it suffices: it is
provider-agnostic and cannot return the wrong one of the two sets.

Separately, the live wire-contract suite now retries a transient status rather
than reporting it as a contract failure. A 529 says the service is busy and
answers nothing about whether a schema is expressible — so a test named "every
shipped tool is expressible on this wire" was claiming something the run had not
established. That cost two manual re-runs in one day to discover the wire had no
opinion.
