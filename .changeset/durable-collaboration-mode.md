---
'@namzu/sdk': minor
---

The collaboration mode is durable per Topic and read live, instead of
frozen for the length of a run.

`PermissionMode` was resolved once in the context factory and copied into
the tool executor. Enforcement was correct; the LIFETIME was the problem —
leaving plan mode meant ending the run and starting a fresh one with
`permissionMode: 'auto'`, discarding the in-flight step and the tool-schema
context to change one enum. So the look-around, propose, get-approval,
continue-in-the-same-conversation flow could not be built on it, and
`approve_plan` already existed with its approval changing nothing about the
mode.

`TopicState` is a new durable record — its own file beside the Topic, its
own schema version, its own revision counter. Separate from the Topic on
purpose: the Topic is identity and ownership, this is session state that
changes several times within one conversation, and merging them would make
every mode toggle a compare-and-set conflict against a title rename.
`setPermissionMode` rejects a stale revision the way `updateTopic` rejects a
stale `ownerVersion`.

The executor takes a resolver rather than a value, sampled once per tool
batch and held for it: a toggle landing between two calls the model issued
together would half-apply, and a batch where the first write is refused and
the second succeeds is not a state anyone can reason about.

Precedence is unchanged for every existing caller: an explicit
`RunConfig.permissionMode` still wins, and the topic record supplies the
mode only when the run config names none. A run with no topic store behaves
exactly as it did.

`SupervisorAgentConfig.onPlanApproved` fires when the operator approves a
plan, so a host can leave plan mode without ending the run.
