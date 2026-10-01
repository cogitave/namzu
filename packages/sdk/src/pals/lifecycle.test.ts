import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseHost } from '../types/computer-use/index.js'
import type { Sandbox } from '../types/sandbox/index.js'
import type { PalLifecycleEvent } from './lifecycle.js'
import { PalRuntime } from './runtime.js'
import { DiskPalStore } from './store.js'
import type { PalDefinition, PalEnvironmentLease } from './types.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-pal-lifecycle-'))
	roots.push(root)
	const store = new DiskPalStore({
		root: join(root, 'registry'),
		workspaceRoot: join(root, 'workspaces'),
	})
	const pal = store.create({ name: 'Research' })
	return { pal, store }
}
function computer(pal: PalDefinition, generation = 1): PalEnvironmentLease {
	return {
		palId: pal.id,
		environmentId: `private-engine:${pal.id}`,
		generation,
		sandbox: { status: 'ready' } as Sandbox,
		computerUseHost: {
			capabilities: { screenshot: true, mouse: true, keyboard: true },
		} as ComputerUseHost,
		release: vi.fn(async () => {}),
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('live Pal lifecycle facts', () => {
	it('reports owned computer/controller transitions once and releases close ownership', async () => {
		const { pal, store } = fixture()
		const lease = computer(pal, 7)
		const acquire = vi.fn(async () => lease)
		const runtime = new PalRuntime({ store, environments: { acquire } })
		const events: PalLifecycleEvent[] = []
		runtime.onLifecycle((event) => {
			events.push(event)
		})
		const first = await runtime.admit({ palId: pal.id, conversationId: 'first' })
		await first.release()
		await first.release()
		const second = await runtime.admit({ palId: pal.id, conversationId: 'second' })
		await runtime.close()
		await second.release()
		expect(events).toEqual([
			{ type: 'computer.starting', palId: pal.id },
			{ type: 'computer.ready', palId: pal.id, generation: 7 },
			{ type: 'admission.acquired', palId: pal.id, generation: 7, conversationId: 'first' },
			{
				type: 'admission.released',
				palId: pal.id,
				generation: 7,
				conversationId: 'first',
				reason: 'released',
			},
			{ type: 'admission.acquired', palId: pal.id, generation: 7, conversationId: 'second' },
			{
				type: 'admission.released',
				palId: pal.id,
				generation: 7,
				conversationId: 'second',
				reason: 'closed',
			},
			{ type: 'computer.stopping', palId: pal.id, generation: 7 },
			{ type: 'computer.stopped', palId: pal.id, generation: 7 },
		])
		expect(acquire).toHaveBeenCalledOnce()
		expect(lease.release).toHaveBeenCalledOnce()
		expect(events.every(Object.isFrozen)).toBe(true)
		expect(JSON.stringify(events)).not.toContain('private-engine')
	})
	it('shares an acquisition started again by a synchronous observer', async () => {
		const { pal, store } = fixture()
		const pending = deferred<PalEnvironmentLease>()
		const acquire = vi.fn(() => pending.promise)
		const runtime = new PalRuntime({ store, environments: { acquire } })
		let repeated: Promise<PalEnvironmentLease> | undefined
		runtime.onLifecycle((event) => {
			if (event.type === 'computer.starting') {
				expect(runtime.busy(pal.id)).toBe(true)
				repeated = runtime.startComputer(pal.id)
			}
		})
		const first = runtime.startComputer(pal.id)
		const lease = computer(pal)
		pending.resolve(lease)
		expect(await first).toBe(lease)
		expect(await repeated).toBe(lease)
		expect(acquire).toHaveBeenCalledOnce()
		await runtime.close()
	})
	it('isolates synchronous failures, rejected promises and pending observers; unsubscribe stops facts', async () => {
		const { pal, store } = fixture()
		const lease = computer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		const pending = deferred<void>()
		runtime.onLifecycle(() => {
			throw new Error('observer secret')
		})
		runtime.onLifecycle(async () => {
			throw new Error('async observer secret')
		})
		runtime.onLifecycle(() => pending.promise)
		const observer = vi.fn()
		const unsubscribe = runtime.onLifecycle(observer)
		await runtime.startComputer(pal.id)
		expect(observer).toHaveBeenCalledTimes(2)
		unsubscribe()
		unsubscribe()
		await runtime.close()
		expect(observer).toHaveBeenCalledTimes(2)
		pending.resolve()
	})
	it('reports failed stop without private errors and retains a retryable generation', async () => {
		const { pal, store } = fixture()
		const lease = computer(pal, 4)
		vi.mocked(lease.release).mockRejectedValueOnce(new Error('private engine credentials'))
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		const events: PalLifecycleEvent[] = []
		runtime.onLifecycle((event) => {
			events.push(event)
		})
		await runtime.startComputer(pal.id)
		await expect(runtime.stopComputer(pal.id)).rejects.toThrow('credentials')
		await runtime.stopComputer(pal.id)
		expect(events.slice(2)).toEqual([
			{ type: 'computer.stopping', palId: pal.id, generation: 4 },
			{ type: 'computer.stop-failed', palId: pal.id, generation: 4 },
			{ type: 'computer.stopping', palId: pal.id, generation: 4 },
			{ type: 'computer.stopped', palId: pal.id, generation: 4 },
		])
		expect(JSON.stringify(events)).not.toContain('credentials')
	})
	it('never reports a foreign rejected lease as an accepted computer generation', async () => {
		const { pal, store } = fixture()
		const foreign = computer({ ...pal, id: 'foreign' }, 91)
		vi.mocked(foreign.release).mockRejectedValueOnce(new Error('private cleanup'))
		const runtime = new PalRuntime({ store, environments: { acquire: async () => foreign } })
		const events: PalLifecycleEvent[] = []
		runtime.onLifecycle((event) => {
			events.push(event)
		})
		await expect(runtime.admit({ palId: pal.id, conversationId: 'first' })).rejects.toThrow(
			'cleanup',
		)
		await runtime.close()
		expect(events).toEqual([
			{ type: 'computer.starting', palId: pal.id },
			{ type: 'computer.start-failed', palId: pal.id, reason: 'cleanup-required' },
			{ type: 'computer.stopping', palId: pal.id },
			{ type: 'computer.stopped', palId: pal.id },
		])
	})
	it('reports provider failure without an acquired controller or raw error', async () => {
		const { pal, store } = fixture()
		const runtime = new PalRuntime({
			store,
			environments: {
				acquire: async () => {
					throw new Error('private provider')
				},
			},
		})
		const events: PalLifecycleEvent[] = []
		runtime.onLifecycle((event) => {
			events.push(event)
		})
		await expect(runtime.admit({ palId: pal.id, conversationId: 'first' })).rejects.toThrow(
			'provider',
		)
		expect(events).toEqual([
			{ type: 'computer.starting', palId: pal.id },
			{ type: 'computer.start-failed', palId: pal.id, reason: 'unavailable' },
		])
		expect(runtime.busy(pal.id)).toBe(false)
	})
})
