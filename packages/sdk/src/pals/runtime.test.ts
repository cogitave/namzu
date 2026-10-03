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
	PalComputerInput,
	PalDefinition,
	PalEnvironmentLease,
} from './types.js'

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

function controlledComputer(pal: PalDefinition) {
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
	return {
		lease: { ...computer(pal), operatorControl: control },
		control,
		setMode(value: PalComputerControl['mode']) {
			mode = value
		},
	}
}

describe('Pal operator computer control', () => {
	it('refuses an unsupported provider without a generic computer input fallback', async () => {
		const { pal, store } = fixture()
		const lease = computer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		expect(runtime.computerControl(pal.id)).toEqual({ supported: false, mode: 'unavailable' })
		await expect(runtime.takeOver(pal.id, 1)).rejects.toThrow('does not support')
		await expect(runtime.returnControl(pal.id, 1)).rejects.toThrow('does not support')
		await expect(
			runtime.executeOperatorInput(pal.id, 1, { type: 'key', keys: 'Return' }),
		).rejects.toThrow('does not support')
		const admitted = await runtime.admit({ palId: pal.id, conversationId: 'unchanged-provider' })
		admitted.assertActive()
		await admitted.release()
		await runtime.close()
	})
	it('requires idle Pal work and current generation before transferring authority', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		const active = await runtime.admit({ palId: pal.id, conversationId: 'active' })
		await expect(runtime.takeOver(pal.id, 1)).rejects.toThrow('active work')
		expect(control.takeOver).not.toHaveBeenCalled()
		active.assertActive()
		await active.release()
		for (const generation of [0, -1, 1.2, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 2])
			await expect(runtime.takeOver(pal.id, generation)).rejects.toThrow('generation')
		await expect(runtime.takeOver('00000000-0000-4000-8000-000000000000', 1)).rejects.toThrow(
			'generation',
		)
		expect(control.takeOver).not.toHaveBeenCalled()
		await runtime.takeOver(pal.id, 1)
		expect(runtime.computerControl(pal.id)).toEqual({ supported: true, mode: 'operator' })
		await expect(runtime.admit({ palId: pal.id, conversationId: 'blocked' })).rejects.toThrow(
			'Pal control',
		)
		await runtime.returnControl(pal.id, 1)
		expect(runtime.computerControl(pal.id)).toEqual({ supported: true, mode: 'pal' })
		expect(runtime.busy(pal.id)).toBe(false)
		const next = await runtime.admit({ palId: pal.id, conversationId: 'explicit-new-turn' })
		next.assertActive()
		await next.release()
		await runtime.close()
	})
	it('fences new admissions synchronously while takeover is pending and keeps screens observable', async () => {
		const { pal, store } = fixture()
		const { lease, control, setMode } = controlledComputer(pal)
		const pending = deferred<void>()
		vi.mocked(control.takeOver).mockImplementation(async () => {
			setMode('transitioning')
			await pending.promise
			setMode('operator')
		})
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		const takeover = runtime.takeOver(pal.id, 1)
		// The runtime fence already exists before the provider's first microtask.
		expect(control.takeOver).not.toHaveBeenCalled()
		expect(runtime.computer(pal.id)).toBe(lease)
		expect(runtime.computerControl(pal.id)).toEqual({ supported: true, mode: 'transitioning' })
		await expect(runtime.admit({ palId: pal.id, conversationId: 'racing' })).rejects.toThrow(
			'Pal control',
		)
		await expect(runtime.takeOver(pal.id, 1)).rejects.toThrow('pending')
		await expect(runtime.stopComputer(pal.id)).rejects.toThrow('control operation')
		pending.resolve()
		await takeover
		expect(runtime.computerControl(pal.id).mode).toBe('operator')
		await runtime.close()
	})
	it('releases a failed idle transition without assuming takeover succeeded', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		vi.mocked(control.takeOver).mockRejectedValueOnce(new Error('A guest process is still active.'))
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await expect(runtime.takeOver(pal.id, 1)).rejects.toThrow('guest process')
		expect(runtime.computerControl(pal.id).mode).toBe('pal')
		expect(runtime.busy(pal.id)).toBe(false)
		const admitted = await runtime.admit({ palId: pal.id, conversationId: 'still-pal' })
		await admitted.release()
		await runtime.close()
	})
	it('does not infer Pal control after an unconfirmed transition failure', async () => {
		const { pal, store } = fixture()
		const { lease, control, setMode } = controlledComputer(pal)
		vi.mocked(control.takeOver).mockImplementation(async () => {
			setMode('transitioning')
			throw new Error('Guest authority could not be confirmed.')
		})
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await expect(runtime.takeOver(pal.id, 1)).rejects.toThrow('could not be confirmed')
		expect(runtime.computerControl(pal.id).mode).toBe('transitioning')
		await expect(runtime.admit({ palId: pal.id, conversationId: 'blocked' })).rejects.toThrow()
		await expect(
			runtime.executeOperatorInput(pal.id, 1, { type: 'key', keys: 'Return' }),
		).rejects.toThrow('Take operator control')
		await runtime.close()
	})
	it('checks live provider authority at each existing admission guard', async () => {
		const { pal, store } = fixture()
		const { lease, setMode } = controlledComputer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		const admitted = await runtime.admit({ palId: pal.id, conversationId: 'guarded-tools' })
		for (const mode of ['operator', 'transitioning'] as const) {
			setMode(mode)
			expect(() => admitted.assertActive()).toThrow('does not have Pal computer control')
		}
		setMode('pal')
		admitted.assertActive()
		await admitted.release()
		await runtime.close()
	})
	it('serializes human input, return and stop, and snapshots delayed coordinates', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		const pending = deferred<void>()
		vi.mocked(control.executeInput).mockImplementation(async () => {
			await pending.promise
			return { type: 'ok' }
		})
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		const input = { type: 'mouse_click' as const, at: { x: 2, y: 3 }, button: 'left' as const }
		const executing = runtime.executeOperatorInput(pal.id, 1, input)
		input.at.x = 999
		expect(runtime.computerControl(pal.id).mode).toBe('operator')
		await expect(runtime.returnControl(pal.id, 1)).rejects.toThrow('pending')
		await expect(runtime.stopComputer(pal.id)).rejects.toThrow('control operation')
		await expect(runtime.executeOperatorInput(pal.id, 1, input)).rejects.toThrow('pending')
		expect(control.executeInput).toHaveBeenCalledWith({
			type: 'mouse_click',
			at: { x: 2, y: 3 },
			button: 'left',
		})
		pending.resolve()
		expect(await executing).toEqual({ type: 'ok' })
		await runtime.returnControl(pal.id, 1)
		await expect(runtime.executeOperatorInput(pal.id, 1, input)).rejects.toThrow(
			'Take operator control',
		)
		await runtime.close()
	})
	it('waits for owned input before close and denies new work immediately', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		const pending = deferred<void>()
		const entered = deferred<void>()
		vi.mocked(control.executeInput).mockImplementation(async () => {
			entered.resolve()
			await pending.promise
			return { type: 'ok' }
		})
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		const executing = runtime.executeOperatorInput(pal.id, 1, { type: 'key', keys: 'Return' })
		await entered.promise
		const closing = runtime.close()
		expect(lease.release).not.toHaveBeenCalled()
		await expect(runtime.returnControl(pal.id, 1)).rejects.toThrow('closed')
		pending.resolve()
		await executing
		await closing
		expect(lease.release).toHaveBeenCalledOnce()
	})
	it('allows deliberate manual control of a warm paused computer without waking the Pal', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		const acquire = vi.fn(async () => lease)
		const runtime = new PalRuntime({ store, environments: { acquire } })
		await runtime.startComputer(pal.id)
		store.update(pal.id, 1, { paused: true })
		await runtime.takeOver(pal.id, 1)
		await runtime.executeOperatorInput(pal.id, 1, { type: 'type_text', text: 'manual' })
		await runtime.returnControl(pal.id, 1)
		await expect(runtime.admit({ palId: pal.id, conversationId: 'no-wake' })).rejects.toThrow(
			'paused',
		)
		expect(acquire).toHaveBeenCalledOnce()
		expect(control.executeInput).toHaveBeenCalledOnce()
		await runtime.close()
	})
	it('refuses stale input after stop/start and never replays it on return', async () => {
		const { pal, store } = fixture()
		const first = controlledComputer(pal)
		const next = controlledComputer(pal)
		const acquire = vi
			.fn()
			.mockResolvedValueOnce(first.lease)
			.mockResolvedValueOnce({
				...next.lease,
				generation: 2,
			})
		const runtime = new PalRuntime({ store, environments: { acquire } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		await runtime.stopComputer(pal.id)
		await runtime.startComputer(pal.id)
		await expect(runtime.returnControl(pal.id, 1)).rejects.toThrow('generation')
		await expect(
			runtime.executeOperatorInput(pal.id, 1, { type: 'key', keys: 'Return' }),
		).rejects.toThrow('generation')
		await runtime.takeOver(pal.id, 2)
		await runtime.returnControl(pal.id, 2)
		expect(first.control.executeInput).not.toHaveBeenCalled()
		expect(next.control.executeInput).not.toHaveBeenCalled()
		await runtime.close()
	})
	it('admits only bounded exact mouse, scroll, text and key input shapes', async () => {
		const { pal, store } = fixture()
		const { lease, control } = controlledComputer(pal)
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		const valid: PalComputerInput[] = [
			{ type: 'mouse_move', to: { x: 0, y: 32767 } },
			{ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'right' },
			{ type: 'mouse_drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, button: 'middle' },
			{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'left', amount: 100 },
			{ type: 'type_text', text: 'Türkçe 👋' },
			{ type: 'key', keys: 'Ctrl+Alt+Return' },
		]
		for (const input of valid) await runtime.executeOperatorInput(pal.id, 1, input)
		const invalid = [
			null,
			{ type: 'screenshot' },
			{ type: 'exec', command: 'host command' },
			{ type: 'key', keys: 'Return', palId: 'foreign' },
			{ type: 'key', keys: 'a;command' },
			{ type: 'key', keys: ' ' },
			{ type: 'key', keys: 'a'.repeat(101) },
			{ type: 'type_text', text: 'a\0b' },
			{ type: 'type_text', text: 'a'.repeat(100_001) },
			{ type: 'mouse_move', to: { x: -1, y: 1 } },
			{ type: 'mouse_move', to: { x: 1.5, y: 1 } },
			{ type: 'mouse_move', to: { x: 32768, y: 1 } },
			{ type: 'mouse_move', to: { x: 1, y: Number.POSITIVE_INFINITY } },
			{ type: 'mouse_move', to: { x: 1, y: 2, environmentId: 'foreign' } },
			{ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'extra' },
			{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'extra', amount: 1 },
			{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'up', amount: 0 },
			{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'up', amount: 101 },
		]
		for (const input of invalid)
			await expect(
				runtime.executeOperatorInput(pal.id, 1, input as PalComputerInput),
			).rejects.toThrow('Invalid Pal computer input')
		expect(control.executeInput).toHaveBeenCalledTimes(valid.length)
		await runtime.close()
	})
	it('requires the resumed admission to observe its own fresh screen before GUI input', async () => {
		const { pal, store } = fixture()
		const { lease } = controlledComputer(pal)
		const execute = vi.fn<ComputerUseHost['execute']>(async (action) =>
			action.type === 'screenshot'
				? {
						type: 'screenshot',
						result: {
							data: Buffer.from('owned-fixture-png'),
							mimeType: 'image/png',
							width: 10,
							height: 10,
						},
					}
				: { type: 'ok' },
		)
		Object.assign(lease.computerUseHost, { execute })
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		await runtime.returnControl(pal.id, 1)
		// The human's readonly preview uses the raw host and does not satisfy agent observation.
		await runtime.computer(pal.id)?.computerUseHost.execute({ type: 'screenshot' })
		const admitted = await runtime.admit({ palId: pal.id, conversationId: 'resumed' })
		await expect(
			admitted.lease.computerUseHost.execute({
				type: 'mouse_click',
				at: { x: 1, y: 2 },
				button: 'left',
			}),
		).rejects.toThrow('fresh Pal computer screenshot')
		expect(execute).toHaveBeenCalledTimes(1)
		await admitted.lease.computerUseHost.execute({ type: 'screenshot' })
		await admitted.lease.computerUseHost.execute({
			type: 'mouse_click',
			at: { x: 1, y: 2 },
			button: 'left',
		})
		expect(execute).toHaveBeenCalledTimes(3)
		await admitted.release()
		const next = await runtime.admit({ palId: pal.id, conversationId: 'another-admission' })
		await expect(
			next.lease.computerUseHost.execute({ type: 'key', keys: 'Return' }),
		).rejects.toThrow('fresh Pal computer screenshot')
		await next.release()
		await runtime.close()
	})
	it('keeps frozen provider hosts usable while optional GUI methods cannot bypass fresh observation', async () => {
		const { pal, store } = fixture()
		const controlled = controlledComputer(pal)
		const raw = Object.freeze<ComputerUseHost>({
			id: 'frozen-owned-fixture',
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: false,
				clipboard: false,
				windows: true,
				windowCapture: true,
				uiTree: true,
			},
			getDisplayGeometry: vi.fn(async () => ({ width: 10, height: 10, scaleFactor: 1 })),
			execute: vi.fn(async () => ({
				type: 'screenshot' as const,
				result: {
					data: Buffer.from('owned-fixture-png'),
					mimeType: 'image/png' as const,
					width: 10,
					height: 10,
				},
			})),
			focusWindow: vi.fn(async () => ({ ok: true, focusedId: 'owned-window' })),
			executeWindow: vi.fn(async () => {}),
			uiAct: vi.fn(async () => ({ ok: true })),
		})
		const lease = { ...controlled.lease, computerUseHost: raw }
		const runtime = new PalRuntime({ store, environments: { acquire: async () => lease } })
		await runtime.startComputer(pal.id)
		await runtime.takeOver(pal.id, 1)
		await runtime.returnControl(pal.id, 1)
		const admission = await runtime.admit({ palId: pal.id, conversationId: 'frozen-host' })
		const agent = admission.lease.computerUseHost
		await expect(agent.getDisplayGeometry()).resolves.toEqual({
			width: 10,
			height: 10,
			scaleFactor: 1,
		})
		await expect(agent.focusWindow?.('owned-window')).rejects.toThrow(
			'fresh Pal computer screenshot',
		)
		await expect(
			agent.executeWindow?.('owned-capture', { type: 'key', keys: 'Return' }),
		).rejects.toThrow('fresh Pal computer screenshot')
		await expect(agent.uiAct?.('owned-ref', 'invoke')).rejects.toThrow(
			'fresh Pal computer screenshot',
		)
		expect(raw.focusWindow).not.toHaveBeenCalled()
		expect(raw.executeWindow).not.toHaveBeenCalled()
		expect(raw.uiAct).not.toHaveBeenCalled()
		await agent.execute({ type: 'screenshot' })
		await agent.focusWindow?.('owned-window')
		await agent.executeWindow?.('owned-capture', { type: 'key', keys: 'Return' })
		await agent.uiAct?.('owned-ref', 'invoke')
		expect(raw.focusWindow).toHaveBeenCalledOnce()
		expect(raw.executeWindow).toHaveBeenCalledOnce()
		expect(raw.uiAct).toHaveBeenCalledOnce()
		await admission.release()
		await expect(agent.execute({ type: 'screenshot' })).rejects.toThrow('no longer owns')
		await runtime.close()
	})
})
