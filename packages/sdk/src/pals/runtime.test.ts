import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseHost } from '../types/computer-use/index.js'
import type { Sandbox } from '../types/sandbox/index.js'
import { PalRuntime } from './runtime.js'
import { DiskPalStore } from './store.js'
import type { PalDefinition, PalEnvironmentLease } from './types.js'

const roots: string[] = []
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-pal-runtime-'))
	roots.push(root)
	const store = new DiskPalStore({
		root: join(root, 'registry'),
		workspaceRoot: join(root, 'workspaces'),
	})
	const pal = store.create({
		name: 'Research',
		purpose: 'Use primary sources',
		model: { provider: 'zen', model: 'space-bunny-free' },
	})
	return { store, pal }
}
function computer(pal: PalDefinition): PalEnvironmentLease {
	return {
		palId: pal.id,
		environmentId: `computer:${pal.id}`,
		generation: 1,
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
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('Pal computer admission', () => {
	it('refuses execution without a local computer provider', async () => {
		const { pal, store } = fixture()
		const runtime = new PalRuntime({ store })
		await expect(runtime.admit({ palId: pal.id, conversationId: 'first' })).rejects.toThrow(
			'virtual computer',
		)
		expect(runtime.busy(pal.id)).toBe(false)
	})
	it('keeps the computer warm while serializing controllers across conversations', async () => {
		const { pal, store } = fixture()
		const lease = computer(pal)
		const acquire = vi.fn(async () => lease)
		const runtime = new PalRuntime({ store, environments: { acquire } })
		const first = await runtime.admit({ palId: pal.id, conversationId: 'first' })
		await expect(runtime.admit({ palId: pal.id, conversationId: 'second' })).rejects.toThrow('busy')
		await expect(runtime.stopComputer(pal.id)).rejects.toThrow('active work')
		await first.release()
		await first.release()
		expect(lease.release).not.toHaveBeenCalled()
		const second = await runtime.admit({ palId: pal.id, conversationId: 'second' })
		expect(acquire).toHaveBeenCalledTimes(1)
		await second.release()
		await runtime.stopComputer(pal.id)
		expect(lease.release).toHaveBeenCalledTimes(1)
		expect(runtime.computer(pal.id)).toBeNull()
	})
	it('pins the old definition while checking current pause state', async () => {
		const { pal, store } = fixture()
		const runtime = new PalRuntime({ store, environments: { acquire: async () => computer(pal) } })
		store.update(pal.id, 1, { purpose: 'Different', model: { provider: 'another', model: 'new' } })
		const admission = await runtime.admit({
			palId: pal.id,
			revision: 1,
			conversationId: 'existing',
		})
		expect(admission.definition.purpose).toBe(pal.purpose)
		expect(admission.definition.model).toEqual(pal.model)
		store.update(pal.id, 2, { paused: true })
		expect(() => admission.assertActive()).toThrow('paused')
		await admission.release()
		await runtime.close()
	})
	it('refuses a foreign or directory-only lease and releases it', async () => {
		const { pal, store } = fixture()
		const wrong = computer({ ...pal, id: 'foreign' })
		const runtime = new PalRuntime({ store, environments: { acquire: async () => wrong } })
		await expect(runtime.admit({ palId: pal.id, conversationId: 'first' })).rejects.toThrow('lease')
		expect(wrong.release).toHaveBeenCalledOnce()
		expect(runtime.busy(pal.id)).toBe(false)
	})
	it('cannot publish a computer when the Pal pauses during acquisition', async () => {
		const { pal, store } = fixture()
		const delayed = deferred<PalEnvironmentLease>()
		const lease = computer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: () => delayed.promise } })
		const admission = runtime.admit({ palId: pal.id, conversationId: 'first' })
		store.update(pal.id, 1, { paused: true })
		delayed.resolve(lease)
		await expect(admission).rejects.toThrow('unavailable')
		expect(lease.release).toHaveBeenCalledOnce()
		expect(runtime.computer(pal.id)).toBeNull()
	})
	it('shares one pending start and retains ownership if stop fails', async () => {
		const { pal, store } = fixture()
		const delayed = deferred<PalEnvironmentLease>()
		const lease = computer(pal)
		const acquire = vi.fn(() => delayed.promise)
		const runtime = new PalRuntime({ store, environments: { acquire } })
		const first = runtime.startComputer(pal.id)
		const second = runtime.startComputer(pal.id)
		delayed.resolve(lease)
		expect(await first).toBe(await second)
		expect(acquire).toHaveBeenCalledOnce()
		vi.mocked(lease.release).mockRejectedValueOnce(new Error('engine lost'))
		await expect(runtime.stopComputer(pal.id)).rejects.toThrow('engine lost')
		expect(runtime.computer(pal.id)).toBeNull()
		expect(runtime.computerError(pal.id)).toContain('could not be stopped')
		await runtime.stopComputer(pal.id)
		expect(runtime.computer(pal.id)).toBeNull()
	})
})

it('retains failed close ownership and lets shutdown retry its release', async () => {
	const { pal, store } = fixture()
	const lease = computer(pal)
	const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
	await runtime.startComputer(pal.id)
	vi.mocked(lease.release).mockRejectedValueOnce(new Error('stop failed'))
	await expect(runtime.close()).rejects.toThrow('Failed to stop')
	expect(runtime.computer(pal.id)).toBeNull()
	expect(runtime.computerError(pal.id)).toContain('could not be stopped')
	await expect(runtime.startComputer(pal.id)).rejects.toThrow('closed')
	await runtime.close()
	expect(lease.release).toHaveBeenCalledTimes(2)
	expect(runtime.computerError(pal.id)).toBeNull()
})
it('keeps rejected leases tracked when cleanup fails', async () => {
	const { pal, store } = fixture()
	const lease = computer({ ...pal, id: 'foreign' })
	vi.mocked(lease.release).mockRejectedValueOnce(new Error('cleanup failed'))
	const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
	await expect(runtime.startComputer(pal.id)).rejects.toThrow('admission and cleanup')
	expect(runtime.computerError(pal.id)).toContain('rejected')
	await expect(runtime.admit({ palId: pal.id, conversationId: 'first' })).rejects.toThrow(
		'released',
	)
	await runtime.stopComputer(pal.id)
	expect(lease.release).toHaveBeenCalledTimes(2)
})
it('refuses a retired computer until its owned release succeeds', async () => {
	const { pal, store } = fixture()
	const old = computer(pal)
	const next = { ...computer(pal), generation: 2 }
	const acquire = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next)
	const runtime = new PalRuntime({ store, environments: { acquire } })
	const admitted = await runtime.admit({ palId: pal.id, conversationId: 'first' })
	Object.assign(old.sandbox, { status: 'destroyed' })
	expect(() => admitted.assertActive()).toThrow('retired')
	expect(runtime.computer(pal.id)).toBeNull()
	expect(runtime.computerError(pal.id)).toContain('retired')
	await admitted.release()
	await expect(runtime.startComputer(pal.id)).rejects.toThrow('retired')
	expect(acquire).toHaveBeenCalledTimes(1)
	await runtime.stopComputer(pal.id)
	expect(await runtime.startComputer(pal.id)).toBe(next)
	await runtime.close()
})
it('cannot admit or resurrect a computer while its release is pending', async () => {
	const { pal, store } = fixture()
	const lease = computer(pal)
	const delayed = deferred<void>()
	vi.mocked(lease.release).mockReturnValueOnce(delayed.promise)
	const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
	await runtime.startComputer(pal.id)
	const stopping = runtime.stopComputer(pal.id)
	expect(runtime.computer(pal.id)).toBeNull()
	await expect(runtime.admit({ palId: pal.id, conversationId: 'next' })).rejects.toThrow('stopping')
	delayed.resolve()
	await stopping
	expect(runtime.busy(pal.id)).toBe(false)
	await runtime.close()
})

it('cancels a waiting controller without destroying a separately started warm computer', async () => {
	const { pal, store } = fixture()
	const pending = deferred<PalEnvironmentLease>()
	const lease = computer(pal)
	const runtime = new PalRuntime({ store, environments: { acquire: () => pending.promise } })
	const starting = runtime.startComputer(pal.id)
	const controller = new AbortController()
	const admission = runtime.admit({
		palId: pal.id,
		conversationId: 'waiting',
		signal: controller.signal,
	})
	controller.abort(new Error('wait cancelled'))
	pending.resolve(lease)
	expect(await starting).toBe(lease)
	await expect(admission).rejects.toThrow('wait cancelled')
	expect(runtime.busy(pal.id)).toBe(false)
	expect(lease.release).not.toHaveBeenCalled()
	await runtime.close()
})
