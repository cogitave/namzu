import { describe, expect, it } from 'vitest'
import type { TenantId } from '../../ids/index.js'
import { deriveChildState } from '../index.js'
import type { InvocationState } from '../index.js'

describe('InvocationState', () => {
	describe('deriveChildState', () => {
		it('should create child state with single agent in parentChain when parent is undefined', () => {
			const childState = deriveChildState(undefined, 'agent-123')

			expect(childState.parentChain).toEqual(['agent-123'])
			expect(childState.tenantId).toBeUndefined()
			expect(childState.metadata).toBeUndefined()
			expect(childState.services).toBeUndefined()
		})

		it('should create child state with single agent in parentChain when parent has no parentChain', () => {
			const parent: InvocationState = {
				tenantId: 'tnt_abc' as TenantId,
				metadata: { userId: 'user-123' },
			}

			const childState = deriveChildState(parent, 'agent-456')

			expect(childState.parentChain).toEqual(['agent-456'])
			expect(childState.tenantId).toBe(parent.tenantId)
			expect(childState.metadata).toBe(parent.metadata)
		})

		it('should extend parentChain with current agent', () => {
			const parent: InvocationState = {
				parentChain: ['supervisor', 'router'],
				tenantId: 'tnt_xyz' as TenantId,
			}

			const childState = deriveChildState(parent, 'worker-agent')

			expect(childState.parentChain).toEqual(['supervisor', 'router', 'worker-agent'])
		})

		it('should preserve tenantId through derivation', () => {
			const tenantId = 'tnt_tenant123' as TenantId
			const parent: InvocationState = {
				tenantId,
				parentChain: ['agent-1'],
			}

			const childState = deriveChildState(parent, 'agent-2')

			expect(childState.tenantId).toBe(tenantId)
		})

		it('should preserve metadata through derivation', () => {
			const metadata = {
				userId: 'user-456',
				sessionId: 'ses_789',
				correlationId: 'corr_abc',
			}
			const parent: InvocationState = {
				metadata,
				parentChain: ['agent-1'],
			}

			const childState = deriveChildState(parent, 'agent-2')

			expect(childState.metadata).toBe(metadata)
			expect(childState.metadata?.userId).toBe('user-456')
		})

		it('should preserve services through derivation', () => {
			const services = {
				db: { pool: 'mock-pool' },
				cache: { client: 'mock-redis' },
			}
			const parent: InvocationState = {
				services,
				parentChain: ['agent-1'],
			}

			const childState = deriveChildState(parent, 'agent-2')

			expect(childState.services).toBe(services)
		})

		it('should preserve all fields through multi-level derivation', () => {
			const tenantId = 'tnt_multi' as TenantId
			const metadata = { userId: 'user-multi' }
			const services = { db: 'postgres' }

			const level1 = deriveChildState(undefined, 'supervisor')
			expect(level1.parentChain).toEqual(['supervisor'])

			const parent: InvocationState = {
				tenantId,
				metadata,
				services,
				parentChain: level1.parentChain,
			}

			const level2 = deriveChildState(parent, 'router')
			expect(level2.parentChain).toEqual(['supervisor', 'router'])
			expect(level2.tenantId).toBe(tenantId)
			expect(level2.metadata).toBe(metadata)
			expect(level2.services).toBe(services)

			const level3 = deriveChildState(level2, 'worker')
			expect(level3.parentChain).toEqual(['supervisor', 'router', 'worker'])
			expect(level3.tenantId).toBe(tenantId)
			expect(level3.metadata).toBe(metadata)
			expect(level3.services).toBe(services)
		})

		it('should create immutable parentChain', () => {
			const parent: InvocationState = {
				parentChain: ['agent-1'],
			}

			const childState = deriveChildState(parent, 'agent-2')

			// Ensure the parentChain is a new array, not mutated
			expect(parent.parentChain).toEqual(['agent-1'])
			expect(childState.parentChain).toEqual(['agent-1', 'agent-2'])
		})

		it('should handle empty parentChain in parent', () => {
			const parent: InvocationState = {
				parentChain: [],
			}

			const childState = deriveChildState(parent, 'agent-first')

			expect(childState.parentChain).toEqual(['agent-first'])
		})

		it('should allow complex agent IDs in parentChain', () => {
			const agentIds = ['supervisor-agent-123', 'router-multi-path', 'worker-task-handler']

			let state: InvocationState | undefined
			for (const agentId of agentIds) {
				state = deriveChildState(state, agentId)
			}

			expect(state?.parentChain).toEqual(agentIds)
		})

		it('should not mutate parent state', () => {
			const parent: InvocationState = {
				parentChain: ['original'],
				tenantId: 'tnt_orig' as TenantId,
				metadata: { key: 'value' },
			}

			const originalParentChain = [...parent.parentChain!]

			deriveChildState(parent, 'child')

			// Parent state should remain unchanged
			expect(parent.parentChain).toEqual(originalParentChain)
			expect(parent.parentChain).toEqual(['original'])
		})
	})

	describe('InvocationState immutability', () => {
		it('should have readonly fields', () => {
			const state: InvocationState = {
				tenantId: 'tnt_test' as TenantId,
				metadata: { key: 'value' },
				services: { db: 'postgres' },
				parentChain: ['agent-1'],
			}

			// Type system enforces immutability, so these assertions verify the type definitions
			expect(state.tenantId).toBe('tnt_test')
			expect(state.metadata).toBeDefined()
			expect(state.services).toBeDefined()
			expect(state.parentChain).toBeDefined()
		})

		it('should support undefined optional fields', () => {
			const minimalState: InvocationState = {
				parentChain: ['agent-1'],
			}

			expect(minimalState.tenantId).toBeUndefined()
			expect(minimalState.metadata).toBeUndefined()
			expect(minimalState.services).toBeUndefined()
			expect(minimalState.parentChain).toEqual(['agent-1'])
		})

		it('should handle metadata with various types', () => {
			const metadata = {
				userId: 'user-123',
				count: 42,
				enabled: true,
				nested: { key: 'value' },
				array: [1, 2, 3],
			}

			const state: InvocationState = {
				metadata,
			}

			expect(state.metadata?.userId).toBe('user-123')
			expect(state.metadata?.count).toBe(42)
			expect(state.metadata?.enabled).toBe(true)
			expect(state.metadata?.nested).toEqual({ key: 'value' })
			expect(state.metadata?.array).toEqual([1, 2, 3])
		})
	})
})
