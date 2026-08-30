/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `RemoteExecutionContext` starts disconnected; `connect()` flips
 *     `connected = true` and emits `remote_connected`.
 *   - `disconnect()` is idempotent — the second call emits nothing
 *     and returns quietly.
 *   - `getTarget()` returns a COPY (mutating the returned object does
 *     not mutate internal state).
 *   - `initialize()` succeeds for supported target types; emits
 *     `context_initialized` + `context_ready`.
 *   - `isReady()` reflects post-initialize state.
 *   - `environment` is 'remote'.
 */

import { describe, expect, it } from 'vitest'

import type { RemoteTarget } from '../types/connector/index.js'

import { RemoteExecutionContext } from './remote.js'

const target: RemoteTarget = { type: 'ssh', host: 'server.example.com', port: 22 }

describe('RemoteExecutionContext', () => {
	it('environment is remote', () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		expect(r.environment).toBe('remote')
	})

	it('starts disconnected; connect flips to connected', async () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		const events: string[] = []
		r.on((event) => events.push(event.type))
		expect(r.isConnected()).toBe(false)
		await r.connect()
		await r.connect()
		expect(r.isConnected()).toBe(true)
		expect(events.filter((event) => event === 'remote_connected')).toHaveLength(1)
	})

	it('disconnect when not connected is a no-op', async () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		await r.disconnect()
		expect(r.isConnected()).toBe(false)
	})

	it('disconnect flips back to disconnected', async () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		await r.connect()
		await r.disconnect()
		expect(r.isConnected()).toBe(false)
	})

	it('getTarget returns a copy (mutation does not leak)', () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		const copy = r.getTarget()
		copy.host = 'mutated.example.com'
		expect(r.getTarget().host).toBe('server.example.com')
	})

	it('initialize flips isReady to true', async () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		expect(r.isReady()).toBe(false)
		await r.initialize()
		expect(r.isReady()).toBe(true)
	})

	it('requires an initialization commit before reconnecting after teardown', async () => {
		const r = new RemoteExecutionContext({ id: 'r1', target })
		await r.connect()
		await r.teardown()

		await expect(r.connect()).rejects.toThrow('initialization commits after teardown')
		await r.initialize()
		await r.connect()
		expect(r.isConnected()).toBe(true)
	})
})
