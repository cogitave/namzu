import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUseHost } from '../types/computer-use/index.js'
import type { Sandbox } from '../types/sandbox/index.js'
import { PalRuntime } from './runtime.js'
import { DiskPalStore } from './store.js'
import type {
	PalComputerControl,
	PalDefinition,
	PalEnvironmentLease,
	PalRuntimeOptions,
} from './types.js'

const roots: string[] = []
const runtimes: PalRuntime[] = []

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-pal-conversation-'))
	roots.push(root)
	const store = new DiskPalStore({
		root: join(root, 'registry'),
		workspaceRoot: join(root, 'workspaces'),
	})
	const pal = store.create({
		name: 'Original Pal',
		purpose: 'Use primary sources',
		model: { provider: 'zen', model: 'space-bunny-free' },
	})
	return { store, pal }
}

function runtime(options: PalRuntimeOptions): PalRuntime {
	const value = new PalRuntime(options)
	runtimes.push(value)
	return value
}

function computer(pal: PalDefinition, generation = 1) {
	let mode: PalComputerControl['mode'] = 'pal'
	const control: PalComputerControl = {
		get mode() {
			return mode
		},
		takeOver: vi.fn(async () => {
			mode = 'operator'
		}),
		returnControl: vi.fn(async () => {
			mode = 'pal'
		}),
		executeInput: vi.fn(async () => ({ type: 'ok' as const })),
	}
	const lease: PalEnvironmentLease = {
		palId: pal.id,
		environmentId: `computer:${pal.id}`,
		generation,
		sandbox: { status: 'ready' } as Sandbox,
		computerUseHost: {
			capabilities: { screenshot: true, mouse: true, keyboard: true },
		} as ComputerUseHost,
		operatorControl: control,
		release: vi.fn(async () => {}),
	}
	return { lease, control }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

afterEach(async () => {
	for (const value of runtimes.splice(0)) await value.close()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pal conversation authority without a computer', () => {
	it('admits offline text without acquiring a guest or emitting computer lifecycle events', async () => {
		const { pal, store } = fixture()
		const acquire = vi.fn(async () => {
			throw new Error('This fixture has no computer')
		})
		const value = runtime({ store, environments: { acquire } })
		const events = vi.fn()
		value.onLifecycle(events)
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		admission.assertActive()
		expect(admission.definition).toEqual(pal)
		expect(value.computer(pal.id)).toBeNull()
		expect(value.busy(pal.id)).toBe(true)
		expect(value.computerChanging(pal.id)).toBe(false)
		expect(acquire).not.toHaveBeenCalled()
		expect(events).not.toHaveBeenCalled()
		await admission.release()
		expect(value.busy(pal.id)).toBe(false)
		expect(events).not.toHaveBeenCalled()
	})

	it('keeps strict admit dependent on a guest while the additive conversation API works', async () => {
		const { pal, store } = fixture()
		const value = runtime({ store })
		await expect(value.admit({ palId: pal.id, conversationId: 'strict' })).rejects.toThrow(
			'virtual computer',
		)
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		await expect(admission.acquireComputer()).rejects.toThrow('virtual computer')
		admission.assertActive()
		expect(value.computer(pal.id)).toBeNull()
		await admission.release()
	})

	it('rejects competing model and guest callers even when they repeat the same conversation ID', async () => {
		const { pal, store } = fixture()
		const acquire = vi.fn(async () => computer(pal).lease)
		const value = runtime({ store, environments: { acquire } })
		const request = { palId: pal.id, conversationId: 'same-id' }
		const admission = await value.admitConversation(request)
		for (const conversationId of ['same-id', 'different-id']) {
			await expect(value.admitConversation({ ...request, conversationId })).rejects.toThrow('busy')
			await expect(value.admit({ ...request, conversationId })).rejects.toThrow('busy')
		}
		expect(acquire).not.toHaveBeenCalled()
		await admission.release()
		const next = await value.admitConversation(request)
		next.assertActive()
		await next.release()
	})

	it('does not take a model slot from an existing strict guest admission', async () => {
		const { pal, store } = fixture()
		const value = runtime({ store, environments: { acquire: async () => computer(pal).lease } })
		const guest = await value.admit({ palId: pal.id, conversationId: 'guest' })
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'guest' }),
		).rejects.toThrow('busy')
		guest.assertActive()
		await guest.release()
		const text = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		text.assertActive()
		await text.release()
	})

	it('pins the admitted profile and copies request values before a later guest acquisition', async () => {
		const { pal, store } = fixture()
		const acquire = vi.fn(async () => computer(pal).lease)
		const value = runtime({ store, environments: { acquire } })
		const request = { palId: pal.id, conversationId: 'original' }
		const admission = await value.admitConversation(request)
		request.palId = 'foreign'
		request.conversationId = 'foreign'
		store.update(pal.id, 1, {
			name: 'Renamed Pal',
			purpose: 'Changed instructions',
			model: { provider: 'other', model: 'different' },
		})
		admission.assertActive()
		expect(admission.definition).toEqual(pal)
		const guest = await admission.acquireComputer()
		expect(guest.definition).toEqual(pal)
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({ pal: expect.objectContaining({ id: pal.id }) }),
		)
		await admission.release()
	})

	it('honors an explicitly pinned old revision and current pause state', async () => {
		const { pal, store } = fixture()
		const value = runtime({ store })
		store.update(pal.id, 1, { name: 'New name', purpose: 'New purpose' })
		const admission = await value.admitConversation({
			palId: pal.id,
			conversationId: 'old',
			revision: 1,
		})
		expect(admission.definition).toEqual(pal)
		store.update(pal.id, 2, { paused: true })
		expect(() => admission.assertActive()).toThrow('paused')
		await expect(admission.acquireComputer()).rejects.toThrow('paused')
		await admission.release()
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'paused' }),
		).rejects.toThrow('paused')
	})

	it('rechecks removed identity and changed workspace before admitting a request', async () => {
		const { pal, store } = fixture()
		const acquire = vi.fn(async () => computer(pal).lease)
		const value = runtime({ store, environments: { acquire } })
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const get = vi.spyOn(store, 'get')
		get.mockReturnValueOnce(null)
		expect(() => admission.assertActive()).toThrow('unavailable')
		get.mockReturnValueOnce({ ...pal, workspace: join(pal.workspace, 'foreign') })
		expect(() => admission.assertActive()).toThrow('workspace identity')
		get.mockReturnValueOnce({ ...pal, workspace: join(pal.workspace, 'foreign') })
		await expect(admission.acquireComputer()).rejects.toThrow('workspace identity')
		expect(acquire).not.toHaveBeenCalled()
		await admission.release()
	})

	it('aborts a text admission without releasing a different later admission', async () => {
		const { pal, store } = fixture()
		const value = runtime({ store })
		const controller = new AbortController()
		const admission = await value.admitConversation({
			palId: pal.id,
			conversationId: 'aborted',
			signal: controller.signal,
		})
		controller.abort(new Error('Cancelled fixture'))
		expect(() => admission.assertActive()).toThrow('Cancelled fixture')
		await expect(admission.acquireComputer()).rejects.toThrow('Cancelled fixture')
		await admission.release()
		const next = await value.admitConversation({ palId: pal.id, conversationId: 'next' })
		await admission.release()
		next.assertActive()
		await next.release()
	})

	it('does not reserve authority for malformed, missing, paused, unknown-revision or pre-aborted calls', async () => {
		const { pal, store } = fixture()
		const value = runtime({ store })
		await expect(value.admitConversation({ palId: pal.id, conversationId: '   ' })).rejects.toThrow(
			'conversation id',
		)
		await expect(
			value.admitConversation({
				palId: 'd4edca0f-3df6-46c5-81c6-e0e49b14a135',
				conversationId: 'missing',
			}),
		).rejects.toThrow('unavailable')
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'old', revision: 99 }),
		).rejects.toThrow()
		const signal = AbortSignal.abort(new Error('Already aborted'))
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'aborted', signal }),
		).rejects.toThrow('Already aborted')
		expect(value.busy(pal.id)).toBe(false)
		store.update(pal.id, 1, { paused: true })
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'paused' }),
		).rejects.toThrow('paused')
		expect(value.busy(pal.id)).toBe(false)
	})
})

describe('separate model and guest Pal authority', () => {
	it('allows operator-held text but refuses guest work until actual control is returned', async () => {
		const { pal, store } = fixture()
		const { lease, control } = computer(pal)
		const acquire = vi.fn(async () => lease)
		const value = runtime({ store, environments: { acquire } })
		await value.startComputer(pal.id)
		await value.takeOver(pal.id, 1)
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		admission.assertActive()
		await expect(admission.acquireComputer()).rejects.toThrow('Pal control')
		admission.assertActive()
		expect(control.executeInput).not.toHaveBeenCalled()
		expect(acquire).toHaveBeenCalledTimes(1)
		await value.returnControl(pal.id, 1)
		const guest = await admission.acquireComputer()
		guest.assertActive()
		expect(guest.lease.generation).toBe(1)
		expect(acquire).toHaveBeenCalledTimes(1)
		await expect(value.takeOver(pal.id, 1)).rejects.toThrow('active work')
		await admission.release()
	})

	it('permits independent operator control while text owns only the model', async () => {
		const { pal, store } = fixture()
		const { lease } = computer(pal)
		const value = runtime({ store, environments: { acquire: async () => lease } })
		await value.startComputer(pal.id)
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		await value.takeOver(pal.id, 1)
		admission.assertActive()
		await value.returnControl(pal.id, 1)
		admission.assertActive()
		await value.stopComputer(pal.id)
		admission.assertActive()
		expect(value.computer(pal.id)).toBeNull()
		await admission.release()
	})

	it('shares concurrent guest acquisition and retains the computer after releasing conversation authority', async () => {
		const { pal, store } = fixture()
		const entering = deferred<void>()
		const pending = deferred<PalEnvironmentLease>()
		const { lease } = computer(pal)
		const acquire = vi.fn(() => {
			entering.resolve()
			return pending.promise
		})
		const value = runtime({ store, environments: { acquire } })
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const first = admission.acquireComputer()
		const second = admission.acquireComputer()
		await entering.promise
		expect(acquire).toHaveBeenCalledTimes(1)
		expect(value.computerChanging(pal.id)).toBe(true)
		pending.resolve(lease)
		const guest = await first
		expect(value.computerChanging(pal.id)).toBe(false)
		expect(await second).toBe(guest)
		expect(await admission.acquireComputer()).toBe(guest)
		guest.assertActive()
		await admission.release()
		expect(() => guest.assertActive()).toThrow('no longer owned')
		expect(() => admission.assertActive()).toThrow('no longer owned')
		expect(value.computer(pal.id)).toBe(lease)
		expect(lease.release).not.toHaveBeenCalled()
		await value.stopComputer(pal.id)
		expect(lease.release).toHaveBeenCalledTimes(1)
	})

	it('revokes model immediately and waits for pending guest admission cleanup before reuse', async () => {
		const { pal, store } = fixture()
		const entering = deferred<void>()
		const pending = deferred<PalEnvironmentLease>()
		const { lease } = computer(pal)
		const value = runtime({
			store,
			environments: {
				acquire: () => {
					entering.resolve()
					return pending.promise
				},
			},
		})
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const acquiring = admission.acquireComputer()
		const rejected = expect(acquiring).rejects.toThrow('no longer owned')
		await entering.promise
		const released = admission.release()
		expect(() => admission.assertActive()).toThrow('no longer owned')
		await expect(
			value.admitConversation({ palId: pal.id, conversationId: 'early' }),
		).rejects.toThrow('busy')
		pending.resolve(lease)
		await rejected
		await released
		const next = await value.admitConversation({ palId: pal.id, conversationId: 'next' })
		const guest = await next.acquireComputer()
		guest.assertActive()
		await admission.release()
		next.assertActive()
		await next.release()
	})

	it('retains valid text authority after guest startup failure and can retry acquisition', async () => {
		const { pal, store } = fixture()
		const { lease } = computer(pal)
		const acquire = vi.fn(async () => lease).mockRejectedValueOnce(new Error('Guest unavailable'))
		const value = runtime({ store, environments: { acquire } })
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		await expect(admission.acquireComputer()).rejects.toThrow('Guest unavailable')
		admission.assertActive()
		const guest = await admission.acquireComputer()
		guest.assertActive()
		expect(acquire).toHaveBeenCalledTimes(2)
		await admission.release()
	})

	it('cleans an aborted pending lease without admitting guest effects or losing later text authority', async () => {
		const { pal, store } = fixture()
		const entering = deferred<void>()
		const pending = deferred<PalEnvironmentLease>()
		const { lease, control } = computer(pal)
		const acquire = vi.fn(() => {
			entering.resolve()
			return pending.promise
		})
		const value = runtime({ store, environments: { acquire } })
		const controller = new AbortController()
		const admission = await value.admitConversation({
			palId: pal.id,
			conversationId: 'text',
			signal: controller.signal,
		})
		const acquiring = admission.acquireComputer()
		const rejected = expect(acquiring).rejects.toThrow('Cancelled acquisition')
		await entering.promise
		controller.abort(new Error('Cancelled acquisition'))
		const released = admission.release()
		pending.resolve(lease)
		await rejected
		await released
		expect(lease.release).toHaveBeenCalledTimes(1)
		expect(control.executeInput).not.toHaveBeenCalled()
		expect(value.computer(pal.id)).toBeNull()
		const next = await value.admitConversation({ palId: pal.id, conversationId: 'next' })
		next.assertActive()
		await next.release()
	})

	it('distinguishes live model authority from a retired guest generation', async () => {
		const { pal, store } = fixture()
		const { lease } = computer(pal)
		const value = runtime({ store, environments: { acquire: async () => lease } })
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const guest = await admission.acquireComputer()
		Object.assign(lease.sandbox, { status: 'destroyed' })
		admission.assertActive()
		expect(() => guest.assertActive()).toThrow('retired')
		await expect(admission.acquireComputer()).rejects.toThrow('retired')
		await admission.release()
	})

	it('revokes all model and guest authority on close and never resurrects a closed runtime', async () => {
		const { pal, store } = fixture()
		const { lease } = computer(pal)
		const acquire = vi.fn(async () => lease)
		const value = runtime({ store, environments: { acquire } })
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const guest = await admission.acquireComputer()
		await value.close()
		expect(() => admission.assertActive()).toThrow('no longer owned')
		expect(() => guest.assertActive()).toThrow('no longer owned')
		await expect(admission.acquireComputer()).rejects.toThrow('no longer owned')
		await expect(value.admitConversation({ palId: pal.id, conversationId: 'new' })).rejects.toThrow(
			'closed',
		)
		await expect(value.admit({ palId: pal.id, conversationId: 'new' })).rejects.toThrow('closed')
		expect(acquire).toHaveBeenCalledTimes(1)
		expect(lease.release).toHaveBeenCalledTimes(1)
		await admission.release()
	})

	it('waits for pending startup during close and releases its rejected lease once', async () => {
		const { pal, store } = fixture()
		const entering = deferred<void>()
		const pending = deferred<PalEnvironmentLease>()
		const { lease } = computer(pal)
		const value = runtime({
			store,
			environments: {
				acquire: () => {
					entering.resolve()
					return pending.promise
				},
			},
		})
		const admission = await value.admitConversation({ palId: pal.id, conversationId: 'text' })
		const acquiring = admission.acquireComputer()
		const rejected = expect(acquiring).rejects.toThrow('became unavailable')
		await entering.promise
		const closing = value.close()
		expect(() => admission.assertActive()).toThrow('no longer owned')
		await expect(value.admitConversation({ palId: pal.id, conversationId: 'new' })).rejects.toThrow(
			'closed',
		)
		pending.resolve(lease)
		await rejected
		await closing
		await admission.release()
		expect(lease.release).toHaveBeenCalledTimes(1)
		expect(value.computer(pal.id)).toBeNull()
	})
})
