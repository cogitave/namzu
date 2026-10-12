import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUseHost, PalComputerControl, PalEnvironmentLease, Sandbox } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	COMPUTER_NOT_SET_UP_FOR_MODEL,
	RUN_COMPUTER_SETUP_LINE,
	cliPalComputerStatus,
	cliPalScreen,
	cliPalScreenStream,
	closeCliPalRuntime,
	executeCliPalComputerInput,
	existingCliPalRuntime,
	getCliPalRuntime,
	modelFacingComputerError,
	quietComputerProbe,
	returnCliPalComputerControl,
	startCliPalComputer,
	stopCliPalComputer,
	takeOverCliPalComputer,
	withSetupHint,
} from './environment.js'
import { createPal } from './store.js'

const { createProvider } = vi.hoisted(() => ({ createProvider: vi.fn() }))
vi.mock('@namzu/sandbox', () => ({ createLocalVirtualComputerProvider: createProvider }))
let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-control-cli-'))
	mkdirSync(join(root, 'home'))
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	vi.stubEnv('NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY', undefined)
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

it('observes no existing runtime without loading a computer provider', async () => {
	expect(await existingCliPalRuntime()).toBeNull()
	expect(createProvider).not.toHaveBeenCalled()
})
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

it.each(['strict', 'computer-lifetime', undefined] as const)(
	'composes the exact host-owned foreground policy %s',
	async (policy) => {
		fixture()
		vi.stubEnv('NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY', policy)
		await getCliPalRuntime()
		expect(createProvider).toHaveBeenCalledWith(
			expect.objectContaining({ normalExitPolicy: policy ?? 'computer-lifetime' }),
		)
	},
)

it('refuses an invalid foreground policy before provider admission and permits a corrected retry', async () => {
	fixture()
	vi.stubEnv('NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY', 'invalid')
	await expect(getCliPalRuntime()).rejects.toThrow('must be strict or computer-lifetime')
	expect(createProvider).not.toHaveBeenCalled()
	vi.stubEnv('NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY', 'strict')
	await expect(getCliPalRuntime()).resolves.toBeDefined()
	expect(createProvider).toHaveBeenCalledWith(
		expect.objectContaining({ normalExitPolicy: 'strict' }),
	)
})

it('reports an idle guest truthfully during model-only chat without implying startup', async () => {
	const { pal, acquire } = fixture()
	const runtime = await getCliPalRuntime()
	const chat = await runtime.admitConversation({ palId: pal.id, conversationId: 'owned-chat' })
	try {
		expect(runtime.busy(pal.id)).toBe(true)
		expect(await cliPalComputerStatus(pal.id)).toEqual({ status: 'stopped' })
		expect(acquire).not.toHaveBeenCalled()
	} finally {
		await chat.release()
	}
})

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
		await expect(cliPalScreenStream(pal.id, value as string)).rejects.toThrow('generation')
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

const streamDescriptor = {
	protocol: 'rfb' as const,
	url: 'ws://127.0.0.1:19876/stream',
	authorization: 'host-only-stream-fixture-credential',
}
it('returns a host-only live descriptor with guest dimensions without capturing or changing input authority', async () => {
	const { pal, lease, execute, control } = fixture()
	Object.assign(lease, { screenStream: streamDescriptor })
	await startCliPalComputer(pal.id)
	const runtime = await getCliPalRuntime()
	const admission = await runtime.admit({ palId: pal.id, conversationId: 'owned-live-view' })
	expect(await cliPalScreenStream(pal.id, '1')).toEqual({
		...streamDescriptor,
		width: 10,
		height: 10,
		generation: '1',
	})
	admission.assertActive()
	await admission.release()
	await takeOverCliPalComputer(pal.id, '1')
	expect(await cliPalScreenStream(pal.id, '1')).toMatchObject({ generation: '1' })
	expect(runtime.computerControl(pal.id).mode).toBe('operator')
	expect(execute).not.toHaveBeenCalled()
	expect(control.executeInput).not.toHaveBeenCalled()
})

it('truthfully refuses a provider without live streaming instead of exposing a screenshot fallback', async () => {
	const { pal, execute, acquire } = fixture()
	await startCliPalComputer(pal.id)
	await expect(cliPalScreenStream(pal.id, '1')).rejects.toThrow('does not support a live screen')
	expect(acquire).toHaveBeenCalledOnce()
	expect(execute).not.toHaveBeenCalled()
})

it('rejects a replaced generation after live stream geometry is read asynchronously', async () => {
	const { pal, lease, acquire } = fixture()
	Object.assign(lease, { screenStream: streamDescriptor })
	const pending = deferred<Awaited<ReturnType<ComputerUseHost['getDisplayGeometry']>>>()
	const entered = deferred<void>()
	lease.computerUseHost.getDisplayGeometry = () => {
		entered.resolve()
		return pending.promise
	}
	await startCliPalComputer(pal.id)
	const opening = cliPalScreenStream(pal.id, '1')
	await entered.promise
	await stopCliPalComputer(pal.id)
	acquire.mockResolvedValueOnce({ ...lease, generation: 2 })
	await startCliPalComputer(pal.id)
	pending.resolve({ width: 10, height: 10, scaleFactor: 1 })
	await expect(opening).rejects.toThrow('generation')
})

it('refuses rotated host credentials and invalid dimensions without including secrets in errors', async () => {
	const { pal, lease } = fixture()
	Object.assign(lease, { screenStream: streamDescriptor })
	lease.computerUseHost.getDisplayGeometry = async () => {
		Object.assign(lease, {
			screenStream: { ...streamDescriptor, authorization: 'changed-private-fixture-credential' },
		})
		return { width: 10, height: 10, scaleFactor: 1 }
	}
	await startCliPalComputer(pal.id)
	await expect(cliPalScreenStream(pal.id, '1')).rejects.toThrow('generation changed')
	for (const geometry of [
		{ width: 0, height: 10 },
		{ width: 4097, height: 10 },
		{ width: 10, height: 3073 },
		{ width: 1.5, height: 10 },
	]) {
		lease.computerUseHost.getDisplayGeometry = async () => ({ ...geometry, scaleFactor: 1 })
		await expect(cliPalScreenStream(pal.id, '1')).rejects.toThrow('invalid live screen size')
	}
	try {
		await cliPalScreenStream(pal.id, '1')
	} catch (error) {
		expect(String(error)).not.toContain('private-fixture-credential')
	}
})

it('uses the bundle manifest image for wslc only when no image is named', async () => {
	const bundle = join(root, 'bundle')
	mkdirSync(bundle)
	writeFileSync(
		join(bundle, 'manifest.json'),
		JSON.stringify({ imageRef: 'namzu-local-computer:7' }),
	)
	const imageFor = async (env: Record<string, string | undefined>) => {
		createProvider.mockReset()
		createProvider.mockReturnValue({ acquire: vi.fn(), probe: vi.fn() })
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
		await getCliPalRuntime()
		const first = createProvider.mock.calls[0]?.[0] as { image?: string }
		await closeCliPalRuntime()
		return first.image
	}
	expect(
		await imageFor({
			NAMZU_PAL_COMPUTER_ENGINE: 'wslc',
			NAMZU_PAL_COMPUTER_BUNDLE: bundle,
			NAMZU_PAL_COMPUTER_IMAGE: undefined,
		}),
	).toBe('namzu-local-computer:7')
	expect(
		await imageFor({
			NAMZU_PAL_COMPUTER_ENGINE: 'wslc',
			NAMZU_PAL_COMPUTER_BUNDLE: bundle,
			NAMZU_PAL_COMPUTER_IMAGE: 'mine:1',
		}),
	).toBe('mine:1')
	expect(
		await imageFor({
			NAMZU_PAL_COMPUTER_ENGINE: 'docker',
			NAMZU_PAL_COMPUTER_BUNDLE: bundle,
			NAMZU_PAL_COMPUTER_IMAGE: undefined,
		}),
	).toBeUndefined()
})

it('tells the model a computer that can be set up from Namzu is not set up', async () => {
	const failure = Object.assign(new Error('Linux container support is not installed.'), {
		name: 'LocalComputerSetupError',
		code: 'engine-missing',
	})
	const policy = Object.assign(new Error('Your organisation does not allow it.'), {
		name: 'LocalComputerSetupError',
		code: 'blocked-by-policy',
	})
	expect(modelFacingComputerError(failure)).toMatchObject({
		message: 'The computer is not set up; the person can set it up from Namzu.',
	})
	expect(modelFacingComputerError(Object.assign(failure, { code: 'image-missing' }))).toMatchObject(
		{
			message: COMPUTER_NOT_SET_UP_FOR_MODEL,
		},
	)
	expect(modelFacingComputerError(policy)).toBe(policy)
	const other = new Error('boom')
	expect(modelFacingComputerError(other)).toBe(other)
	createProvider.mockReturnValue({
		acquire: vi.fn(async () => {
			throw failure
		}),
		probe: vi.fn(),
	})
	const pal = createPal({ name: 'Needs setup' })
	await expect(startCliPalComputer(pal.id)).rejects.toThrow(COMPUTER_NOT_SET_UP_FOR_MODEL)
})

it('chooses the setup hint by the sandbox code, never by the message text', () => {
	// The words are Namzu's own; whatever the sandbox wrote is replaced.
	for (const [setupCode, text] of [
		['engine-missing', 'Linux container support is not installed on this PC.'],
		['engine-too-old', 'Linux container support on this PC is too old for Namzu.'],
		['image-missing', 'The Pal computer is not set up on this PC yet.'],
	] as const)
		expect(
			withSetupHint({ reason: 'Reworded by the sandbox, version 9.', setupCode }, 'win32'),
		).toBe(`${text} ${RUN_COMPUTER_SETUP_LINE}`)
	// The old exact texts without a code get no hint: the message is not the key.
	for (const reason of [
		'Linux container support is not installed on this PC.',
		'The Pal computer is not set up on this PC yet. Namzu sets it up; finish the setup from the Pal computer and try again.',
	])
		expect(withSetupHint({ reason }, 'win32')).toBe(reason)
	// Codes setup cannot fix, and other platforms, keep their own words.
	for (const setupCode of ['virtualization-off', 'blocked-by-policy', 'sdk-mismatch', undefined]) {
		const reason = 'This PC has virtualization switched off.'
		expect(withSetupHint({ reason, setupCode }, 'win32')).toBe(reason)
	}
	expect(withSetupHint({ reason: 'x', setupCode: 'engine-missing' }, 'linux')).toBe('x')
	expect(withSetupHint({ setupCode: 'engine-missing' }, 'win32')).toBeUndefined()
})

it('the wrapped provider probe ends an unready Windows reason with the setup line', async () => {
	const probe = vi.fn(async () => ({
		ready: false,
		reason: 'Linux container support on this PC (3.0.0) is too old; 3.0.1 is required.',
		setupCode: 'engine-too-old',
	}))
	createProvider.mockReturnValue({ acquire: vi.fn(), probe })
	const pal = createPal({ name: 'Probe hint' })
	const platform = Object.getOwnPropertyDescriptor(process, 'platform')
	Object.defineProperty(process, 'platform', { value: 'win32' })
	try {
		expect(await cliPalComputerStatus(pal.id)).toEqual({
			status: 'unavailable',
			notice: `Linux container support on this PC is too old for Namzu. ${RUN_COMPUTER_SETUP_LINE}`,
		})
	} finally {
		if (platform) Object.defineProperty(process, 'platform', platform)
	}
})

it('a bad bundle with the wslc engine fails the host in plain words and retries next call', async () => {
	vi.stubEnv('NAMZU_PAL_COMPUTER_ENGINE', 'wslc')
	vi.stubEnv('NAMZU_PAL_COMPUTER_IMAGE', undefined)
	vi.stubEnv('NAMZU_PAL_COMPUTER_BUNDLE', join(root, 'missing-bundle'))
	createProvider.mockReturnValue({ acquire: vi.fn(), probe: vi.fn() })
	await expect(getCliPalRuntime()).rejects.toThrow(/manifest\.json/)
	const bundle = join(root, 'late-bundle')
	mkdirSync(bundle)
	writeFileSync(
		join(bundle, 'manifest.json'),
		JSON.stringify({ imageRef: 'namzu-local-computer:4' }),
	)
	vi.stubEnv('NAMZU_PAL_COMPUTER_BUNDLE', bundle)
	await getCliPalRuntime()
	expect((createProvider.mock.calls[0]?.[0] as { image?: string }).image).toBe(
		'namzu-local-computer:4',
	)
})

it('ends an unready Windows reason with where to set it up', () => {
	expect(withSetupHint({ reason: 'This PC has virtualization switched off.' }, 'win32')).toBe(
		'This PC has virtualization switched off.',
	)
	expect(withSetupHint({ reason: 'Docker is missing.' }, 'linux')).toBe('Docker is missing.')
	expect(withSetupHint({}, 'win32')).toBeUndefined()
})

it('reads the Windows engine readiness without probing, which would start the Linux machine', async () => {
	const probe = vi.fn(async () => ({ ready: true }))
	const provider = { probe, acquire: vi.fn() }
	const inspectWslcReadiness = vi.fn(async () => ({ state: 'ready' }))
	const deps = {
		platform: 'win32' as const,
		env: { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' },
		loadSetup: async () => ({ inspectWslcReadiness }) as never,
	}
	expect(await quietComputerProbe(provider, deps)).toEqual({ ready: true })
	expect(probe).not.toHaveBeenCalled()
	expect(inspectWslcReadiness).toHaveBeenCalledWith({ imageRef: 'namzu-local-computer:2' })

	inspectWslcReadiness.mockResolvedValue({ state: 'image-missing' })
	const notReady = await quietComputerProbe(provider, deps)
	expect(notReady.ready).toBe(false)
	expect(notReady.reason).toContain(RUN_COMPUTER_SETUP_LINE)
	expect(probe).not.toHaveBeenCalled()
})

it('does not probe, which would start the Linux machine, when Windows readiness cannot be read', async () => {
	const probe = vi.fn(async () => ({ ready: true }))
	const result = await quietComputerProbe(
		{ probe, acquire: vi.fn() },
		{
			platform: 'win32',
			env: { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' },
			loadSetup: (async () => {
				throw new Error('no setup module')
			}) as never,
		},
	)
	expect(result.ready).toBe(false)
	expect(result.reason).toContain(RUN_COMPUTER_SETUP_LINE)
	expect(probe).not.toHaveBeenCalled()
})

it('probes as before for any other engine or platform', async () => {
	const probe = vi.fn(async () => ({ ready: false, reason: 'engine says no' }))
	const provider = { probe, acquire: vi.fn() }
	const loadSetup = vi.fn(async () => {
		throw new Error('no setup module')
	})
	for (const [platform, env] of [
		['linux', { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' }],
		['win32', {}],
		['win32', { NAMZU_PAL_COMPUTER_ENGINE: 'docker' }],
	] as const) {
		probe.mockClear()
		expect(
			await quietComputerProbe(provider, { platform, env, loadSetup: loadSetup as never }),
		).toEqual({
			ready: false,
			reason: 'engine says no',
		})
		expect(probe).toHaveBeenCalledTimes(1)
	}
})
