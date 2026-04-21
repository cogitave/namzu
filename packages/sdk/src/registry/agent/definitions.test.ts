/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `AgentRegistry` extends `ManagedRegistry<AgentDefinition>` and
 *     keys by `def.info.id` via `computeId` (NOT by the top-level id
 *     field — there isn't one on AgentDefinition).
 *   - `resolve(agentId)` returns `.typedAgent`; delegates to
 *     `getOrThrow` and therefore throws a plain `Error` when missing.
 *   - `listByType(type)` filters by `typedAgent.type`.
 *   - `search({category?, query?})` filters by info.category then by
 *     case-insensitive match against name OR description. An empty
 *     query matches all.
 */

import { describe, expect, it } from 'vitest'

import type { AgentInfo } from '../../contracts/api.js'
import type { AgentType, BaseAgentConfig, BaseAgentResult } from '../../types/agent/base.js'
import type { Agent } from '../../types/agent/core.js'
import type { AgentDefinition } from '../../types/agent/factory.js'

import { AgentRegistry } from './definitions.js'

function makeDef(id: string, type: AgentType, overrides: Partial<AgentInfo> = {}): AgentDefinition {
	const info: AgentInfo = {
		id,
		name: `Agent ${id}`,
		version: '1.0.0',
		category: 'general',
		description: `agent ${id} does stuff`,
		tools: [],
		defaults: { model: 'opus', tokenBudget: 1000 },
		...overrides,
	}
	const typedAgent = { type } as unknown as Agent<BaseAgentConfig, BaseAgentResult>
	return { info, typedAgent }
}

describe('AgentRegistry', () => {
	it('keys by info.id (computeId), not by a top-level id field', () => {
		const r = new AgentRegistry()
		r.register(makeDef('coder', 'reactive'))
		expect(r.get('coder')).toBeDefined()
	})

	it('resolve returns typedAgent', () => {
		const r = new AgentRegistry()
		const def = makeDef('coder', 'reactive')
		r.register(def)
		expect(r.resolve('coder')).toBe(def.typedAgent)
	})

	it('resolve throws (plain Error) on unknown agentId', () => {
		const r = new AgentRegistry()
		expect(() => r.resolve('nope')).toThrow(/Not found/)
	})

	it('listByType filters by typedAgent.type', () => {
		const r = new AgentRegistry()
		r.register(makeDef('a', 'reactive'))
		r.register(makeDef('b', 'pipeline'))
		r.register(makeDef('c', 'reactive'))
		expect(r.listByType('reactive').map((d) => d.info.id)).toEqual(['a', 'c'])
		expect(r.listByType('pipeline').map((d) => d.info.id)).toEqual(['b'])
	})

	describe('search', () => {
		it('empty query returns all', () => {
			const r = new AgentRegistry()
			r.register(makeDef('a', 'reactive'))
			r.register(makeDef('b', 'pipeline'))
			expect(r.search({})).toHaveLength(2)
		})

		it('category filter is strict-equal', () => {
			const r = new AgentRegistry()
			r.register(makeDef('coder', 'reactive', { category: 'coding' }))
			r.register(makeDef('writer', 'reactive', { category: 'writing' }))
			expect(r.search({ category: 'coding' }).map((d) => d.info.id)).toEqual(['coder'])
		})

		it('query matches name OR description case-insensitively', () => {
			const r = new AgentRegistry()
			r.register(makeDef('alpha', 'reactive', { name: 'CoderBot', description: 'writes code' }))
			r.register(makeDef('beta', 'reactive', { name: 'Other', description: 'tests CODE' }))
			r.register(makeDef('gamma', 'reactive', { name: 'Third', description: 'documentation' }))

			const hits = r.search({ query: 'code' }).map((d) => d.info.id)
			expect(hits).toEqual(['alpha', 'beta'])
		})

		it('combines category + query', () => {
			const r = new AgentRegistry()
			r.register(makeDef('alpha', 'reactive', { category: 'coding', name: 'CoderBot' }))
			r.register(makeDef('beta', 'reactive', { category: 'writing', name: 'CoderWriter' }))
			const hits = r.search({ category: 'coding', query: 'coder' }).map((d) => d.info.id)
			expect(hits).toEqual(['alpha'])
		})
	})
})
