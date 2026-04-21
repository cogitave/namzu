/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `ExecutionContextFactory.create(config)` dispatches by
 *     `config.environment`:
 *     - 'local' → `LocalExecutionContext` with the forwarded fields.
 *     - 'remote' → `RemoteExecutionContext` with target + capabilities.
 *     - 'hybrid' → `HybridExecutionContext` with local + remotes +
 *       routingStrategy.
 *   - Unknown environment hits the exhaustive throw (unreachable via
 *     types).
 *   - The static `createLocal` / `createRemote` / `createHybrid`
 *     helpers directly return the appropriate subclass.
 */

import { describe, expect, it } from 'vitest'

import { LocalExecutionContext } from '../../execution/local.js'
import { ExecutionContextFactory } from './factory.js'
import { HybridExecutionContext } from './hybrid.js'
import { RemoteExecutionContext } from './remote.js'

describe('ExecutionContextFactory', () => {
	it('creates a LocalExecutionContext for environment: local', () => {
		const ctx = ExecutionContextFactory.create({
			id: 'c1',
			environment: 'local',
			cwd: '/tmp',
			fsAccess: true,
		})
		expect(ctx).toBeInstanceOf(LocalExecutionContext)
		expect(ctx.id).toBe('c1')
		expect(ctx.environment).toBe('local')
	})

	it('creates a RemoteExecutionContext for environment: remote', () => {
		const ctx = ExecutionContextFactory.create({
			id: 'c2',
			environment: 'remote',
			target: { type: 'ssh', host: 'server.example.com' },
		})
		expect(ctx).toBeInstanceOf(RemoteExecutionContext)
		expect(ctx.environment).toBe('remote')
	})

	it('creates a HybridExecutionContext for environment: hybrid', () => {
		const ctx = ExecutionContextFactory.create({
			id: 'c3',
			environment: 'hybrid',
			local: { cwd: '/tmp', fsAccess: true },
			remotes: [{ type: 'ssh', host: 'r1.example.com' }],
		})
		expect(ctx).toBeInstanceOf(HybridExecutionContext)
		expect(ctx.environment).toBe('hybrid')
	})

	it('createLocal / createRemote / createHybrid return the right subclass', () => {
		expect(
			ExecutionContextFactory.createLocal({ id: 'x', cwd: '/tmp', fsAccess: true }),
		).toBeInstanceOf(LocalExecutionContext)
		expect(
			ExecutionContextFactory.createRemote({
				id: 'y',
				target: { type: 'ssh', host: 'h' },
			}),
		).toBeInstanceOf(RemoteExecutionContext)
		expect(
			ExecutionContextFactory.createHybrid({
				id: 'z',
				local: { cwd: '/tmp', fsAccess: true },
				remotes: [],
			}),
		).toBeInstanceOf(HybridExecutionContext)
	})
})
