import { describe, expect, it } from 'vitest'

import type { AgentId, TenantId, UserId } from '../../types/ids/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import { MAX_ACTOR_CHAIN_DEPTH, actorChain, isDescendantOfActor } from '../actor-scope.js'

/**
 * `ActorRef.parentActor` has carried the hierarchy since the 0.2.0 design,
 * and its docblock says permission audit events walk this chain to
 * attribute a subagent's actions back to the originating user.
 *
 * Nothing walked it. `rg 'isDescendantOf|ancestor'` over this package found
 * no reader — a declared hierarchy with no traversal, so every cross-tree
 * concern that came along invented its own propagation instead.
 */

const T1 = 'tnt_1' as TenantId
const T2 = 'tnt_2' as TenantId

const user = (id: string, tenantId = T1): ActorRef => ({
	kind: 'user',
	userId: id as UserId,
	tenantId,
})

const agent = (id: string, parentActor?: ActorRef, tenantId = T1): ActorRef => ({
	kind: 'agent',
	agentId: id as AgentId,
	tenantId,
	...(parentActor ? { parentActor } : {}),
})

describe('an actor chain can be walked', () => {
	it('reports the lineage newest first, including the actor itself', () => {
		const root = user('usr_a')
		const mid = agent('agt_sup', root)
		const leaf = agent('agt_worker', mid)

		expect(actorChain(leaf)).toEqual([leaf, mid, root])
	})

	it('finds an ancestor several links up', () => {
		const root = user('usr_a')
		const leaf = agent('agt_worker', agent('agt_sup', root))

		expect(isDescendantOfActor(leaf, root)).toBe(true)
	})

	it('does not call an actor its own ancestor', () => {
		// Strictly above. The question is "may what happened up there
		// constrain what happens here", and an actor constraining itself is
		// not a hierarchy fact — reading it as one makes every
		// self-comparison silently true and hides a caller that passed the
		// same actor twice by mistake.
		const a = agent('agt_x', user('usr_a'))

		expect(isDescendantOfActor(a, a)).toBe(false)
	})

	it('refuses a forged sibling with a matching id and a different chain', () => {
		// The attack the id comparison alone would miss. Two agents can share
		// an `agentId` — the ids are per-tenant, and a supervisor spawning the
		// same worker twice produces two actors with identical shape. What
		// separates them is the chain, so containment must be decided by
		// walking it and not by matching the name at the end.
		const realParent = agent('agt_sup', user('usr_a'))
		const otherParent = agent('agt_sup', user('usr_b'))
		const leaf = agent('agt_worker', realParent)

		expect(isDescendantOfActor(leaf, realParent)).toBe(true)
		expect(isDescendantOfActor(leaf, otherParent)).toBe(false)
	})

	it('never implies containment across a tenant boundary', () => {
		// Same kind, same id, different tenant. Nothing about a name is
		// evidence of containment, and the one place that would matter most
		// is the one place a name is most likely to repeat.
		const parent = agent('agt_sup', undefined, T1)
		const leaf = agent('agt_worker', parent, T1)
		const foreign = agent('agt_sup', undefined, T2)

		expect(isDescendantOfActor(leaf, foreign)).toBe(false)
	})

	it('returns false on a cyclic chain instead of hanging', () => {
		// Built by hand, because the manager cannot produce one — which is
		// exactly why the bound has to exist anyway. An unbounded walk here
		// is not a wrong answer, it is a hang, on a call an authorization
		// check makes while holding whatever the caller holds.
		const a = agent('agt_a')
		const b = agent('agt_b', a)
		;(a as { parentActor?: ActorRef }).parentActor = b

		expect(isDescendantOfActor(a, user('usr_nobody'))).toBe(false)
		expect(actorChain(a)).toHaveLength(MAX_ACTOR_CHAIN_DEPTH)
	})

	it('stops at a chain longer than the bound rather than walking it all', () => {
		let actor = user('usr_root')
		for (let i = 0; i < MAX_ACTOR_CHAIN_DEPTH + 20; i++) actor = agent(`agt_${i}`, actor)

		expect(actorChain(actor)).toHaveLength(MAX_ACTOR_CHAIN_DEPTH)
		// And the root is now out of reach, which is the honest answer: the
		// walk did not establish containment, so it does not claim it.
		expect(isDescendantOfActor(actor, user('usr_root'))).toBe(false)
	})

	it('handles a root actor with no parent at all', () => {
		const root = user('usr_a')

		expect(actorChain(root)).toEqual([root])
		expect(isDescendantOfActor(root, agent('agt_x'))).toBe(false)
	})
})
