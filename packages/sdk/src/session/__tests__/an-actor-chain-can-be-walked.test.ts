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

const T1 = 'c86e2f3d-70cf-4214-bf9c-7bf9a6f8b59b' as TenantId
const T2 = '03f8aa65-143d-4044-b67c-78c1a8c8c148' as TenantId

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
		const root = user('9ce05013-3bcc-4835-86b3-15e7b9251801')
		const mid = agent('3b8d1342-b0f9-4753-8378-930f12299b08', root)
		const leaf = agent('b8f09df7-1720-46cf-9a2e-d63542de60d2', mid)

		expect(actorChain(leaf)).toEqual([leaf, mid, root])
	})

	it('finds an ancestor several links up', () => {
		const root = user('9ce05013-3bcc-4835-86b3-15e7b9251801')
		const leaf = agent(
			'b8f09df7-1720-46cf-9a2e-d63542de60d2',
			agent('3b8d1342-b0f9-4753-8378-930f12299b08', root),
		)

		expect(isDescendantOfActor(leaf, root)).toBe(true)
	})

	it('does not call an actor its own ancestor', () => {
		// Strictly above. The question is "may what happened up there
		// constrain what happens here", and an actor constraining itself is
		// not a hierarchy fact — reading it as one makes every
		// self-comparison silently true and hides a caller that passed the
		// same actor twice by mistake.
		const a = agent(
			'bbad502b-5334-41aa-a480-2491c6b30c8f',
			user('9ce05013-3bcc-4835-86b3-15e7b9251801'),
		)

		expect(isDescendantOfActor(a, a)).toBe(false)
	})

	it('refuses a forged sibling with a matching id and a different chain', () => {
		// The attack the id comparison alone would miss. Two agents can share
		// an `agentId` — the ids are per-tenant, and a supervisor spawning the
		// same worker twice produces two actors with identical shape. What
		// separates them is the chain, so containment must be decided by
		// walking it and not by matching the name at the end.
		const realParent = agent(
			'3b8d1342-b0f9-4753-8378-930f12299b08',
			user('9ce05013-3bcc-4835-86b3-15e7b9251801'),
		)
		const otherParent = agent(
			'3b8d1342-b0f9-4753-8378-930f12299b08',
			user('9087e28b-e385-43ab-908e-140e46fb01a9'),
		)
		const leaf = agent('b8f09df7-1720-46cf-9a2e-d63542de60d2', realParent)

		expect(isDescendantOfActor(leaf, realParent)).toBe(true)
		expect(isDescendantOfActor(leaf, otherParent)).toBe(false)
	})

	it('never implies containment across a tenant boundary', () => {
		// Same kind, same id, different tenant. Nothing about a name is
		// evidence of containment, and the one place that would matter most
		// is the one place a name is most likely to repeat.
		const parent = agent('3b8d1342-b0f9-4753-8378-930f12299b08', undefined, T1)
		const leaf = agent('b8f09df7-1720-46cf-9a2e-d63542de60d2', parent, T1)
		const foreign = agent('3b8d1342-b0f9-4753-8378-930f12299b08', undefined, T2)

		expect(isDescendantOfActor(leaf, foreign)).toBe(false)
	})

	it('returns false on a cyclic chain instead of hanging', () => {
		// Built by hand, because the manager cannot produce one — which is
		// exactly why the bound has to exist anyway. An unbounded walk here
		// is not a wrong answer, it is a hang, on a call an authorization
		// check makes while holding whatever the caller holds.
		const a = agent('297e7108-719e-42f6-aa3b-f3b42d1ad2c5')
		const b = agent('965fee81-5ea3-4efb-a75e-ed08ff17a9ec', a)
		;(a as { parentActor?: ActorRef }).parentActor = b

		expect(isDescendantOfActor(a, user('f68b2d6a-8d0f-45c2-a53a-e8203e9af446'))).toBe(false)
		expect(actorChain(a)).toHaveLength(MAX_ACTOR_CHAIN_DEPTH)
	})

	it('stops at a chain longer than the bound rather than walking it all', () => {
		let actor = user('e04738b9-b828-4251-9b35-bc3bc8a2adf8')
		for (let i = 0; i < MAX_ACTOR_CHAIN_DEPTH + 20; i++) actor = agent(`agt_${i}`, actor)

		expect(actorChain(actor)).toHaveLength(MAX_ACTOR_CHAIN_DEPTH)
		// And the root is now out of reach, which is the honest answer: the
		// walk did not establish containment, so it does not claim it.
		expect(isDescendantOfActor(actor, user('e04738b9-b828-4251-9b35-bc3bc8a2adf8'))).toBe(false)
	})

	it('handles a root actor with no parent at all', () => {
		const root = user('9ce05013-3bcc-4835-86b3-15e7b9251801')

		expect(actorChain(root)).toEqual([root])
		expect(isDescendantOfActor(root, agent('bbad502b-5334-41aa-a480-2491c6b30c8f'))).toBe(false)
	})
})
