import type { ActorRef } from '../types/session/actor.js'

/**
 * Walking the actor chain that was already there.
 *
 * `ActorRef`'s agent variant has carried `parentActor` since the 0.2.0
 * design, and its docblock says permission audit events walk this chain to
 * attribute a subagent's actions back to the originating user. Nothing
 * walked it — `rg 'isDescendantOf|ancestor'` over this package found no
 * reader at all. A declared hierarchy with no code that traverses it is a
 * `declared-but-undriven` primitive, and every cross-tree concern that came
 * along instead invented its own propagation: `resumeHandler` is threaded
 * by hand at the spawn site, and a tool scope was about to be.
 *
 * **Not a parallel parent registry.** The obvious fix is a `WeakMap` from
 * child to parent maintained by the manager, and it is the wrong one: the
 * chain is already persisted on the actor, so a second structure gives the
 * tree two answers to the same question that can disagree — and the one a
 * check reads would be the one that is NOT written to disk.
 */

/**
 * How far the walk goes before giving up.
 *
 * A chain is built by the manager one link per spawn, and the spawn depth
 * limit is far below this — so reaching it means the chain is malformed or
 * cyclic, not that somebody legitimately nested a hundred deep. Bounded
 * rather than cycle-detected with a `Set` because the bound is the thing
 * that must hold: a containment check that hangs is a denial of service on
 * whatever holds the lock, and a check that allocates per call to prove a
 * property nobody can trigger is worse than one that stops.
 */
export const MAX_ACTOR_CHAIN_DEPTH = 64

/** The identifying fields of one link, ignoring what is above it. */
function sameLink(a: ActorRef, b: ActorRef): boolean {
	// Tenant first, and it is never implied. Two agents in different tenants
	// can share an `agentId` — the ids are per-tenant, not global — so
	// comparing on kind and id alone would let a chain in one tenant satisfy
	// a containment check made about another.
	if (a.tenantId !== b.tenantId) return false
	if (a.kind !== b.kind) return false
	switch (a.kind) {
		case 'user':
			return a.userId === (b as Extract<ActorRef, { kind: 'user' }>).userId
		case 'agent':
			return a.agentId === (b as Extract<ActorRef, { kind: 'agent' }>).agentId
		case 'system':
			return a.role === (b as Extract<ActorRef, { kind: 'system' }>).role
	}
}

/**
 * Same actor — identifying fields AND everything above them.
 *
 * An agent's `ActorRef` does not identify a spawn: it has no instance id, so
 * a supervisor that spawns `agt_worker` twice produces two links that are
 * field-for-field identical. What separates them is their lineage.
 *
 * So identity here is the whole chain, and that is the safe direction for
 * the question this answers. Matching on the id alone would let an actor
 * claim containment by NAME — hand the check an `agt_sup` assembled under a
 * different user and it would report the two as the same supervisor. For an
 * authorization decision that is precisely the wrong error to make, and the
 * data to avoid it is already on the ref.
 *
 * Compared iteratively and bounded, not recursively: a cyclic chain must
 * return an answer rather than exhaust the stack.
 */
function sameActor(a: ActorRef, b: ActorRef, maxDepth: number): boolean {
	let left: ActorRef | undefined = a
	let right: ActorRef | undefined = b
	for (let depth = 0; depth < maxDepth; depth++) {
		if (left === undefined || right === undefined) return left === right
		if (!sameLink(left, right)) return false
		left = left.kind === 'agent' ? left.parentActor : undefined
		right = right.kind === 'agent' ? right.parentActor : undefined
	}
	// Both chains ran past the bound while still agreeing. Cannot be
	// established, so it is not claimed.
	return false
}

/** The chain from `actor` up to its root, newest first, `actor` included. */
export function actorChain(
	actor: ActorRef,
	opts: { readonly maxDepth?: number } = {},
): readonly ActorRef[] {
	const max = opts.maxDepth ?? MAX_ACTOR_CHAIN_DEPTH
	const chain: ActorRef[] = []
	let current: ActorRef | undefined = actor
	while (current && chain.length < max) {
		chain.push(current)
		current = current.kind === 'agent' ? current.parentActor : undefined
	}
	return chain
}

/**
 * Whether `ancestor` appears strictly above `actor` in its chain.
 *
 * Strictly: an actor is not its own ancestor. The question this answers is
 * "may what happened up there constrain what happens here", and an actor
 * constraining itself is not a hierarchy fact — reading it as one makes
 * every self-comparison silently true and hides a caller that passed the
 * same actor twice by mistake.
 *
 * Returns `false` on a malformed or cyclic chain rather than throwing. The
 * callers are authorization checks, and the honest answer to "is this
 * contained by that" when the chain cannot be read is no.
 */
export function isDescendantOfActor(
	actor: ActorRef,
	ancestor: ActorRef,
	opts: { readonly maxDepth?: number } = {},
): boolean {
	const chain = actorChain(actor, opts)
	const max = opts.maxDepth ?? MAX_ACTOR_CHAIN_DEPTH
	// `slice(1)` — skip the actor itself, per the strictness above.
	return chain.slice(1).some((link) => sameActor(link, ancestor, max))
}
