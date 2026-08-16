---
'@namzu/sdk': minor
---

A delegated tool scope now survives further delegation, and `ActorRef`'s
chain finally has a reader.

A child scoped `toolScope: { deny: ['bash'] }` could spawn a grandchild
naming no scope at all, and the grandchild got `bash` back. Every
meaningful confinement is more than one delegation deep, so a restriction
a descendant could shed by delegating was not a restriction. The effective
scope for a spawn is now the union of every deny along its chain plus its
own: a descendant may narrow further and can never widen. The resolved
union is recorded on the child's spawn record, so what a child was granted
can be read rather than inferred from whether a call was refused.

New exports `isDescendantOfActor`, `actorChain` and `MAX_ACTOR_CHAIN_DEPTH`
walk the `parentActor` chain that `ActorRef` has carried since the 0.2.0
design and that nothing traversed — its own docblock says permission audit
events walk it, and no code did. Deliberately not a parallel parent
registry: the chain is already persisted on the actor, and a second
structure would give the tree two answers that can disagree, with the one a
check reads being the one not written to disk.

Identity for an agent actor is its whole lineage, not its `agentId`. An
`ActorRef` carries no instance id, so a supervisor spawning the same worker
twice produces two field-identical links; matching on the id alone would
let an actor assembled under a different user claim containment by name.
The walk is depth-bounded, so a malformed or cyclic chain returns `false`
instead of hanging a check somebody is holding a lock across.
