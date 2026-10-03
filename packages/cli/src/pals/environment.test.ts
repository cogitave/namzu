import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUseHost, PalComputerControl, PalEnvironmentLease, Sandbox } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	cliPalComputerStatus,
	cliPalScreen,
	closeCliPalRuntime,
	executeCliPalComputerInput,
	getCliPalRuntime,
	returnCliPalComputerControl,
	startCliPalComputer,
	stopCliPalComputer,
	takeOverCliPalComputer,
} from './environment.js'
import { createPal } from './store.js'

const { createProvider } = vi.hoisted(() => ({ createProvider: vi.fn() }))
vi.mock('@namzu/sandbox', () => ({ createLocalVirtualComputerProvider: createProvider }))
let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-control-cli-'))
	mkdirSync(join(root, 'home'))
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	createProvider.mockReset()
})
afterEach(async () => {
	await closeCliPalRuntime()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
function fixture(supported = true) {
	const pal = createPal({ name: 'Private control fixture' })
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
	const execute = vi.fn<ComputerUseHost['execute']>(async () => ({
		type: 'screenshot',
		result: {
			data: Buffer.from('owned-fixture-png'),
			mimeType: 'image/png',
			width: 10,
			height: 10,
		},
	}))
	const lease: PalEnvironmentLease = {
		palId: pal.id,
		environmentId: `owned-fixture:${pal.id}`,
		generation: 1,
		sandbox: { status: 'ready' } as Sandbox,
		computerUseHost: {
			id: 'owned-control-fixture',
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: false,
				clipboard: false,
			},
			getDisplayGeometry: async () => ({ width: 10, height: 10, scaleFactor: 1 }),
			execute,
		},
		...(supported ? { operatorControl: control } : {}),
		release: vi.fn(async () => {}),
	}
	const acquire = vi.fn(async () => lease)
	const probe = vi.fn(async () => ({ ready: true }))
	createProvider.mockReturnValue({ acquire, probe })
	return { pal, control, lease, execute, acquire }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

it('composes actual runtime authority and narrow input without generic computer fallback or inference', async () => {
	const { pal, control, execute, acquire } = fixture()
	expect(await startCliPalComputer(pal.id)).toMatchObject({
		status: 'ready',
		generation: '1',
		control: { supported: true, mode: 'pal' },
	})
	expect(await takeOverCliPalComputer(pal.id, '1')).toMatchObject({ control: { mode: 'operator' } })
	expect(await cliPalComputerStatus(pal.id)).toMatchObject({ control: { mode: 'operator' } })
	expect(await executeCliPalComputerInput(pal.id, '1', { type: 'key', keys: 'Return' })).toEqual({
		type: 'ok',
	})
	expect(control.executeInput).toHaveBeenCalledWith({ type: 'key', keys: 'Return' })
	expect(execute).not.toHaveBeenCalled()
	expect(await returnCliPalComputerControl(pal.id, '1')).toMatchObject({ control: { mode: 'pal' } })
	expect(acquire).toHaveBeenCalledOnce()
	expect(await cliPalScreen(pal.id, '1')).toMatchObject({ width: 10, height: 10 })
	expect(execute).toHaveBeenCalledWith({ type: 'screenshot' })
})

it('rejects noncanonical and stale wire generations before any input', async () => {
	const { pal, control } = fixture()
	for (const value of [
		'',
		'0',
		'01',
		'+1',
		'1.0',
		'1e0',
		' 1',
		'1 ',
		'-1',
		'9007199254740992',
		1,
	]) {
		await expect(takeOverCliPalComputer(pal.id, value as string)).rejects.toThrow('generation')
		await expect(returnCliPalComputerControl(pal.id, value as string)).rejects.toThrow('generation')
		await expect(
			executeCliPalComputerInput(pal.id, value as string, { type: 'key', keys: 'Return' }),
		).rejects.toThrow('generation')
		await expect(cliPalScreen(pal.id, value as string)).rejects.toThrow('generation')
	}
	expect(createProvider).not.toHaveBeenCalled()
	await startCliPalComputer(pal.id)
	await expect(takeOverCliPalComputer(pal.id, '2')).rejects.toThrow('generation')
	await takeOverCliPalComputer(pal.id, '1')
	await expect(
		executeCliPalComputerInput(pal.id, '2', { type: 'key', keys: 'Return' }),
	).rejects.toThrow('generation')
	await expect(cliPalScreen(pal.id, '2')).rejects.toThrow('generation')
	expect(control.executeInput).not.toHaveBeenCalled()
})

it('reports unsupported control and never uses a generic GUI execute path for human input', async () => {
	const { pal, execute } = fixture(false)
	expect(await startCliPalComputer(pal.id)).toMatchObject({
		control: { supported: false, mode: 'unavailable' },
	})
	await expect(takeOverCliPalComputer(pal.id, '1')).rejects.toThrow('does not support')
	await expect(
		executeCliPalComputerInput(pal.id, '1', { type: 'key', keys: 'Return' }),
	).rejects.toThrow('does not support')
	expect(execute).not.toHaveBeenCalled()
})

it('refuses wrong-generation screens after an owned computer is replaced during capture', async () => {
	const { pal, lease, execute, acquire } = fixture()
	const pending = deferred<Awaited<ReturnType<ComputerUseHost['execute']>>>()
	const entered = deferred<void>()
	execute.mockImplementationOnce(() => {
		entered.resolve()
		return pending.promise
	})
	await startCliPalComputer(pal.id)
	const capture = cliPalScreen(pal.id, '1')
	await entered.promise
	await stopCliPalComputer(pal.id)
	acquire.mockResolvedValueOnce({ ...lease, generation: 2 })
	await startCliPalComputer(pal.id)
	pending.resolve({
		type: 'screenshot',
		result: {
			data: Buffer.from('stale-fixture-png'),
			mimeType: 'image/png',
			width: 10,
			height: 10,
		},
	})
	await expect(capture).rejects.toThrow('generation changed during')
})

it('checks capture identity even for legacy callers without an explicit generation', async () => {
	const { pal, lease, execute } = fixture()
	const pending = deferred<Awaited<ReturnType<ComputerUseHost['execute']>>>()
	const entered = deferred<void>()
	execute.mockImplementationOnce(() => {
		entered.resolve()
		return pending.promise
	})
	await startCliPalComputer(pal.id)
	const capture = cliPalScreen(pal.id)
	await entered.promise
	Object.assign(lease, { generation: 2 })
	pending.resolve({
		type: 'screenshot',
		result: {
			data: Buffer.from('stale-fixture-png'),
			mimeType: 'image/png',
			width: 10,
			height: 10,
		},
	})
	await expect(capture).rejects.toThrow('generation changed during')
	expect((await getCliPalRuntime()).computer(pal.id)).toBe(lease)
})

it('does not report stopped while owned guest cleanup is still pending', async () => {
	const { pal, lease } = fixture()
	const pending = deferred<void>()
	const entered = deferred<void>()
	vi.mocked(lease.release).mockImplementationOnce(() => {
		entered.resolve()
		return pending.promise
	})
	await startCliPalComputer(pal.id)
	const stopping = stopCliPalComputer(pal.id)
	// Await the exact entry boundary without depending on elapsed wall time.
	await entered.promise
	expect(await cliPalComputerStatus(pal.id)).toMatchObject({
		status: 'unavailable',
		notice: expect.stringContaining('still changing state'),
	})
	pending.resolve()
	expect(await stopping).toEqual({ status: 'stopped' })
	expect(await cliPalComputerStatus(pal.id)).toEqual({ status: 'stopped' })
})
