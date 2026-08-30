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

import { ExecutionContextFactory } from './factory.js'
import { HybridExecutionContext } from './hybrid.js'
import { LocalExecutionContext } from './local.js'
import { RemoteExecutionContext } from './remote.js'

describe('ExecutionContextFactory', () => {
	it('creates a LocalExecutionContext for environment: local', () => {
		const ctx = ExecutionContextFactory.create({
			id: 'c1',
			environment: 'local',
			cwd: '/tmp',
			fsAccess: true,
			maxOutputBytes: 31,
		})
		expect(ctx).toBeInstanceOf(LocalExecutionContext)
		expect(ctx.id).toBe('c1')
		expect(ctx.environment).toBe('local')
		expect((ctx as LocalExecutionContext).toConfig().maxOutputBytes).toBe(31)
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
			local: {
				cwd: '/tmp',
				fsAccess: true,
				capabilities: ['process'],
				shell: '/bin/sh',
				maxOutputBytes: 37,
			},
			remotes: [{ type: 'ssh', host: 'r1.example.com' }],
		})
		expect(ctx).toBeInstanceOf(HybridExecutionContext)
		expect(ctx.environment).toBe('hybrid')
		expect((ctx as HybridExecutionContext).getLocal().toConfig()).toMatchObject({
			capabilities: ['process'],
			shell: '/bin/sh',
			maxOutputBytes: 37,
		})
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

	it('materializes the local default and preserves it through config and Factory', () => {
		const original = ExecutionContextFactory.createLocal({ id: 'local-round-trip', cwd: '/tmp' })
		const config = original.toConfig()

		expect(config.maxOutputBytes).toBe(4 * 1024 * 1024)
		const restored = ExecutionContextFactory.create(config)
		expect(restored).toBeInstanceOf(LocalExecutionContext)
		expect((restored as LocalExecutionContext).toConfig()).toEqual(config)
	})

	it('preserves every local child option through a Hybrid config round trip', () => {
		const original = ExecutionContextFactory.createHybrid({
			id: 'hybrid-round-trip',
			local: {
				cwd: '/tmp',
				fsAccess: false,
				envVars: { NAMZU_ROUND_TRIP: 'yes' },
				capabilities: ['filesystem', 'process'],
				shell: '/bin/sh',
				maxOutputBytes: 41,
			},
			remotes: [],
			routingStrategy: 'round-robin',
		})
		const config = original.toConfig()

		expect(config.local).toEqual({
			cwd: '/tmp',
			fsAccess: false,
			envVars: { NAMZU_ROUND_TRIP: 'yes' },
			capabilities: ['filesystem', 'process'],
			shell: '/bin/sh',
			maxOutputBytes: 41,
		})
		const restored = ExecutionContextFactory.create(config)
		expect(restored).toBeInstanceOf(HybridExecutionContext)
		expect((restored as HybridExecutionContext).toConfig()).toEqual(config)
	})

	it.each([0, -1, 64 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1])(
		'refuses an unsafe local maxOutputBytes value (%s)',
		(maxOutputBytes) => {
			expect(
				() => new LocalExecutionContext({ id: 'invalid-cap', cwd: '/tmp', maxOutputBytes }),
			).toThrow(RangeError)
		},
	)
})
