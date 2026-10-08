import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import {
	LOCAL_SPEECH_MODEL_BYTES,
	LOCAL_SPEECH_PREVIEW_TEXT,
	type LocalSpeechEvent,
} from '../shared/local-speech-protocol.js'
import type { LocalSpeechInstallation } from './local-speech-install.js'
import { LocalSpeechService, LocalSpeechSynthesizer } from './local-speech.js'

const fixtures: { directory: string; service: LocalSpeechService }[] = []
afterEach(async () => {
	for (const { directory, service } of fixtures.splice(0)) {
		await service.dispose()
		await rm(directory, { recursive: true, force: true })
	}
	vi.useRealTimers()
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}

class SpeechChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	readonly commands: Record<string, unknown>[] = []
	readonly kill = vi.fn((signal: NodeJS.Signals) => {
		this.signalCode = signal
		queueMicrotask(() => this.emit('close', null, signal))
		return true
	})
	constructor() {
		super()
		this.stdin.on('data', (value: Buffer) => {
			this.commands.push(JSON.parse(value.toString('utf8')))
		})
	}
	frame(value: unknown): void {
		this.stdout.write(`${JSON.stringify(value)}\n`)
	}
}

const installation: LocalSpeechInstallation = {
	v: 1,
	modelRevision: 'fixture-model',
	sourceRevision: 'fixture-source',
	engineVersion: '1.0.1',
	runtimeDirectory: 'runtime-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
	workerSha256: 'fixture-worker',
	runtimeDownloadBytes: 150_000_000,
	diskBytes: 500_000_000,
	installedAt: '2026-10-07T00:00:00.000Z',
}

async function setup(
	options: {
		installed?: boolean
		enabled?: boolean
		settingsText?: string
		read?: Promise<LocalSpeechInstallation | undefined>
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-local-speech-'))
	if (options.settingsText !== undefined)
		await writeFile(join(directory, 'settings.json'), options.settingsText)
	else if (options.enabled)
		await writeFile(join(directory, 'settings.json'), JSON.stringify({ enabled: true }))
	const children: SpeechChild[] = []
	const events: LocalSpeechEvent[] = []
	const spawnWorker = vi.fn(() => {
		const child = new SpeechChild()
		children.push(child)
		return child as unknown as ChildProcessWithoutNullStreams
	})
	const install = vi.fn(async () => installation)
	const service = new LocalSpeechService({
		directory,
		spawn: spawnWorker as unknown as typeof spawn,
		readInstallation: vi.fn(
			() => options.read ?? Promise.resolve(options.installed ? installation : undefined),
		),
		install,
		onEvent: (event) => events.push(event),
	})
	fixtures.push({ directory, service })
	return { directory, service, events, children, spawnWorker, install }
}

function audio(requestId: string, sequence: number, bytes = 9_600) {
	return {
		type: 'audio',
		requestId,
		sequence,
		sampleRate: 24_000,
		pcmBase64: Buffer.alloc(bytes).toString('base64'),
	}
}

it('does not install, download or load a model at startup, including a saved enabled preference', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	const first = await fixture.service.state()
	expect(first).toMatchObject({
		installation: 'ready',
		worker: 'unloaded',
		settings: { enabled: true, language: 'tr' },
		resources: {
			modelDownloadBytes: LOCAL_SPEECH_MODEL_BYTES,
			ramBytes: null,
			cpuPercent: null,
			firstAudioMs: null,
			vramBytes: null,
		},
	})
	expect(fixture.spawnWorker).not.toHaveBeenCalled()
	expect(fixture.install).not.toHaveBeenCalled()
	first.settings.enabled = false
	first.resources.diskBytes = 1
	expect(await fixture.service.state()).toMatchObject({
		settings: { enabled: true },
		resources: { diskBytes: 500_000_000 },
	})
})

it('coalesces an explicit installation and leaves speech disabled until configured', async () => {
	const fixture = await setup()
	await fixture.service.state()
	await Promise.all([fixture.service.install(), fixture.service.install()])
	expect(fixture.install).toHaveBeenCalledTimes(1)
	expect(await fixture.service.state()).toMatchObject({
		installation: 'ready',
		settings: { enabled: false },
	})
	expect(fixture.spawnWorker).not.toHaveBeenCalled()
	await expect(fixture.service.speak({ requestId: 'preview', text: 'Merhaba.' })).rejects.toThrow(
		'Enable local speech',
	)
})

it('retains an invalid preference notice after inspecting a valid installed engine until preferences are saved', async () => {
	const fixture = await setup({ installed: true, settingsText: '{invalid json' })
	expect(await fixture.service.state()).toMatchObject({
		installation: 'ready',
		settings: { enabled: false },
		error: 'Saved speech preferences could not be read. Speech remains disabled.',
	})
	expect(fixture.install).not.toHaveBeenCalled()
	expect(fixture.spawnWorker).not.toHaveBeenCalled()
	await fixture.service.speak({
		requestId: 'preview-corrupt-preferences',
		text: LOCAL_SPEECH_PREVIEW_TEXT,
		preview: true,
	})
	expect((await fixture.service.state()).error).toBe(
		'Saved speech preferences could not be read. Speech remains disabled.',
	)
	fixture.service.cancel('preview-corrupt-preferences')
	await fixture.service.configure({ enabled: false })
	expect((await fixture.service.state()).error).toBeUndefined()
	expect(
		JSON.parse(await readFile(join(fixture.directory, 'settings.json'), 'utf8')),
	).toMatchObject({ enabled: false, language: 'tr' })
})

it('persists serialized preference patches without losing a concurrent change or accepting an unsupported language', async () => {
	const fixture = await setup()
	await Promise.all([
		fixture.service.configure({ enabled: true }),
		fixture.service.configure({ idleUnloadSeconds: 0 }),
	])
	expect(await fixture.service.state()).toMatchObject({
		settings: { enabled: true, idleUnloadSeconds: 0 },
	})
	expect(
		JSON.parse(await readFile(join(fixture.directory, 'settings.json'), 'utf8')),
	).toMatchObject({ enabled: true, idleUnloadSeconds: 0 })
	await expect(fixture.service.configure({ language: 'en' as 'tr' })).rejects.toThrow(
		'Turkish only',
	)
	await expect(fixture.service.configure({ path: '/host/anything' } as never)).rejects.toThrow(
		'Invalid local speech setting',
	)
	expect(fixture.install).not.toHaveBeenCalled()
})

it('previews only the fixed Turkish sample without enabling arbitrary disabled speech or changing preferences', async () => {
	const fixture = await setup({ installed: true })
	await expect(
		fixture.service.speak({
			requestId: 'unsafe-preview',
			text: 'Arbitrary private conversation.',
			preview: true,
		}),
	).rejects.toThrow('fixed Turkish sample')
	expect(fixture.spawnWorker).not.toHaveBeenCalled()
	await fixture.service.speak({
		requestId: 'safe-preview',
		text: LOCAL_SPEECH_PREVIEW_TEXT,
		preview: true,
	})
	expect(fixture.children[0]!.commands).toEqual([
		{ type: 'speak', requestId: 'safe-preview', text: LOCAL_SPEECH_PREVIEW_TEXT },
	])
	expect(await fixture.service.state()).toMatchObject({
		settings: { enabled: false },
		worker: 'loading',
	})
	await expect(readFile(join(fixture.directory, 'settings.json'))).rejects.toMatchObject({
		code: 'ENOENT',
	})
	fixture.children[0]!.frame(audio('safe-preview', 0, 100))
	fixture.service.acknowledge('safe-preview', 0)
	fixture.children[0]!.frame({ type: 'end', requestId: 'safe-preview' })
	expect(fixture.events).toContainEqual({
		type: 'end',
		requestId: 'safe-preview',
		reason: 'completed',
	})
	await expect(
		fixture.service.speak({ requestId: 'read-disabled', text: 'Merhaba.' }),
	).rejects.toThrow('Enable local speech')
	expect(await fixture.service.state()).toMatchObject({
		settings: { enabled: false },
		worker: 'ready',
	})
})

it('runs only the isolated owned CPU Python command and bounds unacknowledged PCM to two short chunks', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	await fixture.service.speak({ requestId: 'voice1', text: 'Merhaba dünya.' })
	const child = fixture.children[0]!
	expect(fixture.spawnWorker.mock.calls[0]).toBeDefined()
	expect(child.commands).toEqual([{ type: 'speak', requestId: 'voice1', text: 'Merhaba dünya.' }])
	child.frame({ type: 'ready', resources: { ramBytes: 200_000_000, cpuPercent: 35 } })
	child.frame(audio('voice1', 0))
	child.frame(audio('voice1', 1))
	expect(fixture.events.filter((event) => event.type === 'audio')).toHaveLength(2)
	expect(await fixture.service.state()).toMatchObject({
		worker: 'speaking',
		resources: { ramBytes: 200_000_000, cpuPercent: 35 },
	})
	expect((await fixture.service.state()).resources.firstAudioMs).toBeGreaterThanOrEqual(0)
	fixture.service.acknowledge('other_voice', 0)
	fixture.service.acknowledge('voice1', 500)
	expect(child.commands).toHaveLength(1)
	fixture.service.acknowledge('voice1', 0)
	fixture.service.acknowledge('voice1', 0)
	expect(child.commands.filter((command) => command.type === 'ack')).toEqual([
		{ type: 'ack', requestId: 'voice1', sequence: 0 },
	])
	child.frame(audio('voice1', 2))
	child.frame(audio('voice1', 3))
	expect(fixture.events.at(-2)).toMatchObject({ type: 'error', requestId: 'voice1' })
	expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
	expect(await fixture.service.state()).toMatchObject({
		worker: 'unloaded',
		resources: { ramBytes: null },
	})
})

it('does not declare a request completed before all playback acknowledgements and rejects oversized PCM', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	await fixture.service.speak({ requestId: 'voice1', text: 'Merhaba.' })
	const child = fixture.children[0]!
	child.frame(audio('voice1', 0))
	child.frame({ type: 'end', requestId: 'voice1' })
	expect(fixture.events.some((event) => event.type === 'end' && event.reason === 'completed')).toBe(
		false,
	)
	expect(child.kill).toHaveBeenCalledOnce()
	await fixture.service.speak({ requestId: 'voice2', text: 'Merhaba.' })
	fixture.children[1]!.frame(audio('voice2', 0, 9_602))
	expect(fixture.children[1]!.kill).toHaveBeenCalledOnce()
})

it('cancels CPU work, fences late PCM from the old process and ignores acknowledgements from the old request', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	await fixture.service.speak({ requestId: 'voice1', text: 'Merhaba.' })
	const old = fixture.children[0]!
	old.frame(audio('voice1', 0))
	fixture.service.cancel('unowned')
	expect(old.kill).not.toHaveBeenCalled()
	fixture.service.cancel('voice1')
	expect(old.kill).toHaveBeenCalledOnce()
	await fixture.service.speak({ requestId: 'voice2', text: 'Yeni mesaj.' })
	const fresh = fixture.children[1]!
	old.frame(audio('voice1', 1))
	old.frame({ type: 'ready', resources: { ramBytes: 999 } })
	fresh.frame(audio('voice2', 0))
	fixture.service.acknowledge('voice1', 0)
	expect(fresh.commands).toHaveLength(1)
	fixture.service.acknowledge('voice2', 0)
	fresh.frame({ type: 'end', requestId: 'voice2', resources: { ramBytes: 100, cpuPercent: 1 } })
	expect(fixture.events.filter((event) => event.type === 'audio')).toHaveLength(2)
	expect(fixture.events).toContainEqual({ type: 'end', requestId: 'voice1', reason: 'cancelled' })
	expect(fixture.events).toContainEqual({ type: 'end', requestId: 'voice2', reason: 'completed' })
	expect(await fixture.service.state()).toMatchObject({
		worker: 'ready',
		resources: { ramBytes: 100 },
	})
})

it('cancels a pending initialization without spawning, and concurrent speech starts only the latest request', async () => {
	const read = deferred<LocalSpeechInstallation | undefined>()
	const fixture = await setup({ enabled: true, read: read.promise })
	const pending = fixture.service.speak({ requestId: 'pending', text: 'Merhaba.' })
	const rejected = expect(pending).rejects.toThrow('superseded')
	fixture.service.cancel('pending')
	read.resolve(installation)
	await rejected
	expect(fixture.spawnWorker).not.toHaveBeenCalled()
	const first = fixture.service.speak({ requestId: 'first', text: 'Birinci.' })
	const firstRejected = expect(first).rejects.toThrow('superseded')
	const second = fixture.service.speak({ requestId: 'second', text: 'İkinci.' })
	await firstRejected
	await second
	expect(fixture.spawnWorker).toHaveBeenCalledTimes(1)
	expect(fixture.children[0]!.commands).toEqual([
		{ type: 'speak', requestId: 'second', text: 'İkinci.' },
	])
})

it('releases the worker after the configured idle interval and retains it when explicitly requested', async () => {
	vi.useFakeTimers()
	const fixture = await setup({ installed: true, enabled: true })
	await fixture.service.speak({ requestId: 'first', text: 'Merhaba.' })
	const child = fixture.children[0]!
	child.frame({ type: 'end', requestId: 'first', resources: { ramBytes: 100 } })
	await vi.advanceTimersByTimeAsync(299_999)
	expect(child.kill).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(child.kill).toHaveBeenCalledOnce()
	await fixture.service.configure({ idleUnloadSeconds: 0 })
	await fixture.service.speak({ requestId: 'second', text: 'Merhaba.' })
	const retained = fixture.children[1]!
	retained.frame({ type: 'end', requestId: 'second' })
	await vi.advanceTimersByTimeAsync(600_000)
	expect(retained.kill).not.toHaveBeenCalled()
	await fixture.service.configure({ enabled: false })
	expect(retained.kill).toHaveBeenCalledOnce()
})

it('structurally streams PCM with consumption backpressure and finishes with one final frame', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	const synthesizer = new LocalSpeechSynthesizer(fixture.service)
	async function* text() {
		yield 'Merhaba.'
	}
	const stream = synthesizer
		.synthesize(text(), { signal: new AbortController().signal, turnId: 'turn' })
		[Symbol.asyncIterator]()
	const first = stream.next()
	// Await the actual service event rather than racing a real clock.
	await new Promise<void>((resolve) => {
		if (fixture.children.length) resolve()
		else {
			const unsubscribe = fixture.service.subscribe((event) => {
				if (event.type === 'state' && event.state.worker === 'loading') {
					unsubscribe()
					resolve()
				}
			})
		}
	})
	const child = fixture.children[0]!
	const requestId = child.commands[0]!.requestId as string
	child.frame(audio(requestId, 0, 100))
	expect((await first).value).toMatchObject({
		final: false,
		frame: { format: 'pcm_s16le', samplesPerChannel: 50 },
	})
	expect(child.commands.filter((command) => command.type === 'ack')).toHaveLength(0)
	const final = stream.next()
	expect(child.commands.filter((command) => command.type === 'ack')).toHaveLength(1)
	child.frame({ type: 'end', requestId })
	expect((await final).value).toMatchObject({ final: true, frame: { samplesPerChannel: 0 } })
	expect((await stream.next()).done).toBe(true)
})

it('removes the downloaded engine, keeps the saved preferences and refuses while downloading', async () => {
	const fixture = await setup({ installed: true, enabled: true })
	await fixture.service.state()
	await mkdir(join(fixture.directory, 'runtime-x', 'models'), { recursive: true })
	await writeFile(join(fixture.directory, 'runtime-x', 'models', 'm.bin'), 'x')
	await writeFile(join(fixture.directory, 'installation.json'), '{}')
	const removed = await fixture.service.uninstall()
	expect(removed).toMatchObject({
		installation: 'missing',
		worker: 'unloaded',
		settings: { enabled: true },
		resources: { diskBytes: null, runtimeDownloadBytes: null },
	})
	expect((await readdir(fixture.directory)).sort()).toEqual(['settings.json'])
	await expect(
		fixture.service.speak({ requestId: 'after-removal', text: 'Merhaba.' }),
	).rejects.toThrow('Install the local speech engine')
	const gate = deferred<LocalSpeechInstallation>()
	fixture.install.mockReturnValueOnce(gate.promise)
	const installing = fixture.service.install()
	await expect(fixture.service.uninstall()).rejects.toThrow('Wait for the voice download')
	gate.resolve(installation)
	await installing
})
