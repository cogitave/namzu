import { afterEach, expect, it, vi } from 'vitest'
import type { LocalListeningEvent } from '../shared/local-listening-protocol.js'
import {
	type ListeningEngine,
	type ListeningVadStream,
	abortError,
} from './local-listening-engine.js'
import { LocalListeningInstallCancelled } from './local-listening-install.js'
import type { LocalListeningInstallation } from './local-listening-install.js'
import type { VadFeedResult } from './local-listening-protocol.js'
import type { ListeningFrame } from './local-listening-stream.js'
import {
	LocalListeningService,
	LocalSpeechRecognizer,
	LocalVoiceActivityDetector,
} from './local-listening.js'

afterEach(() => {
	vi.useRealTimers()
})

const PIECE = 1_600 // 100 ms at 16 kHz
const installation: LocalListeningInstallation = {
	v: 1,
	modelRevision: 'x',
	files: [],
	diskBytes: 1_000,
	installedAt: '2026-10-16T00:00:00.000Z',
}

/** A stand-in voice-activity model: loud pieces are speech, three quiet pieces end a segment. */
class FakeVad implements ListeningVadStream {
	fed = 0
	closed = false
	private start = -1
	private lastLoud = 0
	private quiet = 0
	feed(samples: Float32Array): Promise<VadFeedResult> {
		const loud = samples.some((sample) => Math.abs(sample) > 0.5)
		const at = this.fed
		this.fed += samples.length
		const segments: VadFeedResult['segments'] = []
		if (loud) {
			if (this.start < 0) this.start = at
			this.lastLoud = this.fed
			this.quiet = 0
		} else if (this.start >= 0 && ++this.quiet >= 3) {
			segments.push({ start: this.start, length: this.lastLoud - this.start })
			this.start = -1
		}
		return Promise.resolve({ detected: this.start >= 0, segments })
	}
	flush(): Promise<VadFeedResult> {
		const segments: VadFeedResult['segments'] = []
		if (this.start >= 0) segments.push({ start: this.start, length: this.lastLoud - this.start })
		this.start = -1
		return Promise.resolve({ detected: false, segments })
	}
	close(): void {
		this.closed = true
	}
}
class FakeEngine implements ListeningEngine {
	streams: FakeVad[] = []
	inputs: Float32Array[] = []
	texts: string[] = []
	hold?: Promise<void>
	signals: AbortSignal[] = []
	unloaded = 0
	disposed = 0
	async openVad(): Promise<ListeningVadStream> {
		const stream = new FakeVad()
		this.streams.push(stream)
		return stream
	}
	async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
		this.inputs.push(samples)
		this.signals.push(signal)
		if (this.hold)
			await new Promise<void>((resolve, reject) => {
				signal.addEventListener('abort', () => reject(abortError()), { once: true })
				void this.hold?.then(resolve)
			})
		return this.texts.shift() ?? 'merhaba'
	}
	async unloadRecognizer(): Promise<void> {
		this.unloaded++
	}
	async dispose(): Promise<void> {
		this.disposed++
	}
}

function ready(
	engine: FakeEngine,
	extra: Partial<ConstructorParameters<typeof LocalListeningService>[0]> = {},
) {
	return new LocalListeningService({
		directory: '/profile/local-listening',
		readInstallation: async () => installation,
		createEngine: () => engine,
		...extra,
	})
}

function s16(level: number, samples = PIECE, extra: Partial<ListeningFrame> = {}): ListeningFrame {
	const data = new Uint8Array(samples * 2)
	const view = new DataView(data.buffer)
	for (let index = 0; index < samples; index++)
		view.setInt16(index * 2, Math.round(level * 32767), true)
	return {
		channels: 1,
		data,
		format: 'pcm_s16le',
		sampleRateHz: 16_000,
		samplesPerChannel: samples,
		...extra,
	}
}
/** quiet/loud pattern, one frame per 100 ms, the first stamped with the source clock. */
function pattern(spec: string, firstTimestampMs = 0): ListeningFrame[] {
	return [...spec].map((mark, index) =>
		s16(mark === '#' ? 0.9 : 0, PIECE, index === 0 ? { timestampMs: firstTimestampMs } : {}),
	)
}
async function* source(frames: ListeningFrame[]): AsyncGenerator<ListeningFrame> {
	for (const frame of frames) yield frame
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const item of iterable) out.push(item)
	return out
}
const live = (signal = new AbortController().signal) => ({ signal })

it('starts not installed and downloads only when asked', async () => {
	const install = vi.fn()
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => undefined,
		install,
	})
	expect((await service.state()).installation).toBe('missing')
	expect(install).not.toHaveBeenCalled()
})

it('moves missing, installing, ready and reports progress without a flood of events', async () => {
	const events: LocalListeningEvent[] = []
	let finish: (value: LocalListeningInstallation) => void = () => undefined
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => undefined,
		install: (options) =>
			new Promise((resolve) => {
				for (let bytes = 0; bytes <= 100; bytes++)
					options.onProgress?.({ step: 'downloading', downloadedBytes: bytes, totalBytes: 100 })
				finish = resolve
			}),
		onEvent: (event) => events.push(event),
	})
	await service.state()
	const running = service.install()
	expect((await service.state()).installation).toBe('installing')
	finish(installation)
	const state = await running
	expect(state).toMatchObject({ installation: 'ready', diskBytes: 1_000, engine: 'unloaded' })
	expect(state.progress).toBeUndefined()
	// One event per whole percent at most, plus the begin and end of the install.
	expect(events.length).toBeLessThan(110)
	expect(events.some((event) => event.state.progress?.downloadedBytes === 50)).toBe(true)
	// A second install is a no-op that does not call the installer again.
	expect((await service.install()).installation).toBe('ready')
})

it('turns a failed install into a plain error and allows another attempt', async () => {
	const install = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('Listening couldn’t be downloaded. Check the connection and try again.'),
		)
		.mockResolvedValueOnce(installation)
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => undefined,
		install,
	})
	const failed = await service.install()
	expect(failed).toMatchObject({
		installation: 'failed',
		error: 'Listening couldn’t be downloaded. Check the connection and try again.',
	})
	expect((await service.install()).installation).toBe('ready')
})

it('cancel returns to missing without an error', async () => {
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => undefined,
		install: (options) =>
			new Promise((_resolve, reject) => {
				options.signal?.addEventListener('abort', () =>
					reject(new LocalListeningInstallCancelled()),
				)
			}),
	})
	await service.state()
	const running = service.install()
	await vi.waitFor(async () => expect((await service.state()).installation).toBe('installing'))
	const cancelled = await service.cancelInstall()
	expect(cancelled).toMatchObject({ installation: 'missing' })
	expect(cancelled.error).toBeUndefined()
	expect((await running).installation).toBe('missing')
})

it('uninstall deletes the files and returns to missing, stopping a loaded engine first', async () => {
	const engine = new FakeEngine()
	const uninstall = vi.fn(async () => undefined)
	const service = ready(engine, { uninstall })
	await collect(new LocalVoiceActivityDetector(service).detect(source(pattern('..')), live()))
	await service.transcribe(new Float32Array(10), new AbortController().signal)
	const state = await service.uninstall()
	expect(state).toMatchObject({ installation: 'missing', diskBytes: null, engine: 'unloaded' })
	expect(engine.disposed).toBe(1)
	expect(uninstall).toHaveBeenCalledWith('/profile/local-listening')
})

it('reports a damaged saved install as failed instead of using it', async () => {
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => {
			throw new Error('The saved listening files are incomplete. Download them again.')
		},
	})
	expect(await service.state()).toMatchObject({
		installation: 'failed',
		error: 'The saved listening files are incomplete. Download them again.',
	})
})

it('refuses to listen before the download', async () => {
	const service = new LocalListeningService({
		directory: '/p',
		readInstallation: async () => undefined,
	})
	await expect(
		collect(new LocalVoiceActivityDetector(service).detect(source(pattern('#')), live())),
	).rejects.toThrow(/Download it in Settings/)
})

it('the detector reports speech start and end on the source timeline', async () => {
	const engine = new FakeEngine()
	const service = ready(engine)
	// 0.5 s quiet, 0.8 s speech, 0.6 s quiet, 0.4 s speech, 0.6 s quiet. Clock starts at 10 s.
	const events = await collect(
		new LocalVoiceActivityDetector(service).detect(
			source(pattern('.....########......####......', 10_000)),
			live(),
		),
	)
	expect(events.map((event) => event.type)).toEqual([
		'speech_start',
		'speech_end',
		'speech_start',
		'speech_end',
	])
	const [firstStart, firstEnd, secondStart, secondEnd] = events.map((event) => event.timestampMs)
	// Detected when the first loud piece has been fed; the segment itself began a piece earlier.
	expect(firstStart).toBe(10_000 + 600)
	expect(firstEnd).toBe(10_000 + 1_300)
	expect(secondStart).toBe(10_000 + 2_000)
	expect(secondEnd).toBe(10_000 + 2_300)
	expect(firstStart).toBeLessThanOrEqual(firstEnd as number)
	expect(secondStart).toBeGreaterThanOrEqual(firstEnd as number)
	expect(engine.streams[0]?.closed).toBe(true)
})

it('closes speech that is still open when the audio ends', async () => {
	const service = ready(new FakeEngine())
	const events = await collect(
		new LocalVoiceActivityDetector(service).detect(source(pattern('..####')), live()),
	)
	expect(events.map((event) => event.type)).toEqual(['speech_start', 'speech_end'])
	expect((events[1]?.timestampMs ?? 0) >= (events[0]?.timestampMs ?? 0)).toBe(true)
})

it('accepts float32 frames and rejects other rates and channel counts with a clear error', async () => {
	const service = ready(new FakeEngine())
	const f32 = new Uint8Array(PIECE * 4)
	new DataView(f32.buffer).setFloat32(0, 0.9, true)
	const float: ListeningFrame = {
		channels: 1,
		data: f32,
		format: 'pcm_f32le',
		sampleRateHz: 16_000,
		samplesPerChannel: PIECE,
	}
	await expect(
		collect(
			new LocalVoiceActivityDetector(service).detect(source([float, ...pattern('....')]), live()),
		),
	).resolves.toHaveLength(2)
	await expect(
		collect(
			new LocalVoiceActivityDetector(service).detect(
				source([s16(0, PIECE, { sampleRateHz: 48_000 })]),
				live(),
			),
		),
	).rejects.toThrow('Listening needs 16 kHz mono audio, but this frame is 48000 Hz with 1 channel.')
	await expect(
		collect(
			new LocalSpeechRecognizer(service).transcribe(
				source([s16(0, PIECE, { channels: 2 })]),
				live(),
			),
		),
	).rejects.toThrow(/2 channels/)
	await expect(
		collect(
			new LocalVoiceActivityDetector(service).detect(
				source([{ ...s16(0), data: new Uint8Array(10) }]),
				live(),
			),
		),
	).rejects.toThrow(/doesn’t match/)
})

it('the recognizer emits one Turkish final per segment, inside the detector interval', async () => {
	const engine = new FakeEngine()
	engine.texts = ['yeni bir dosya aç', 'tamam']
	const service = ready(engine)
	const frames = pattern('.....########......####......', 10_000)
	const detected = await collect(
		new LocalVoiceActivityDetector(service).detect(source(frames), live()),
	)
	const finals = await collect(
		new LocalSpeechRecognizer(service).transcribe(source(frames), live()),
	)
	expect(finals.map((event) => event.text)).toEqual(['yeni bir dosya aç', 'tamam'])
	expect(
		finals.every((event) => event.type === 'final_transcript' && event.language === 'tr'),
	).toBe(true)
	const intervals = [
		[detected[0]?.timestampMs ?? 0, detected[1]?.timestampMs ?? 0],
		[detected[2]?.timestampMs ?? 0, detected[3]?.timestampMs ?? 0],
	] as const
	finals.forEach((event, index) => {
		const [start, end] = intervals[index] ?? [0, 0]
		expect(event.timestampMs).toBeGreaterThanOrEqual(start)
		expect(event.timestampMs).toBeLessThanOrEqual(end)
	})
})

it('cuts each utterance with pre-roll and post-roll and always ends it with half a second of silence', async () => {
	const engine = new FakeEngine()
	const service = ready(engine)
	await collect(
		new LocalSpeechRecognizer(service).transcribe(
			source(pattern('.....########......', 0)),
			live(),
		),
	)
	const input = engine.inputs[0] as Float32Array
	// Speech is pieces 5-12. Pre-roll is 400 ms before it. Only 300 ms of quiet followed before the
	// segment closed, so that is all the post-roll there is. Then 8,000 samples of added silence.
	const speechStart = 5 * PIECE
	const speechEnd = 13 * PIECE
	const preRoll = 6_400
	const available = 3 * PIECE
	expect(input.length).toBe(preRoll + (speechEnd - speechStart) + available + 8_000)
	expect(input.subarray(input.length - 8_000).every((sample) => sample === 0)).toBe(true)
	expect(Math.max(...input.subarray(preRoll, preRoll + 100))).toBeGreaterThan(0.8)
	expect(Math.max(...input.subarray(0, preRoll - 100))).toBe(0)
})

it('emits nothing for an empty or blank recognition', async () => {
	const engine = new FakeEngine()
	engine.texts = ['   ', '']
	const service = ready(engine)
	const finals = await collect(
		new LocalSpeechRecognizer(service).transcribe(source(pattern('..####....###....')), live()),
	)
	expect(engine.inputs).toHaveLength(2)
	expect(finals).toEqual([])
})

it('does not stall the frame loop while a recognition is still running', async () => {
	const engine = new FakeEngine()
	let release: () => void = () => undefined
	engine.hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const service = ready(engine)
	const iterator = new LocalSpeechRecognizer(service)
		.transcribe(source(pattern('..####....###....')), live())
		[Symbol.asyncIterator]()
	const first = iterator.next()
	await vi.waitFor(() => expect(engine.streams[0]?.fed).toBe(17 * PIECE))
	expect(engine.inputs).toHaveLength(1)
	release()
	expect((await first).value?.text).toBe('merhaba')
	expect((await iterator.next()).value?.text).toBe('merhaba')
	expect((await iterator.next()).done).toBe(true)
})

it('stops promptly on abort, cancels the running recognition and closes the voice stream', async () => {
	const engine = new FakeEngine()
	engine.hold = new Promise<void>(() => undefined)
	const service = ready(engine)
	const controller = new AbortController()
	let endless = false
	async function* frames(): AsyncGenerator<ListeningFrame> {
		for (const frame of pattern('..####....')) yield frame
		endless = true
		await new Promise<void>(() => undefined)
	}
	const run = collect(
		new LocalSpeechRecognizer(service).transcribe(frames(), live(controller.signal)),
	)
	await vi.waitFor(() => expect(endless && engine.inputs.length === 1).toBe(true))
	controller.abort()
	await expect(run).resolves.toEqual([])
	expect(engine.signals[0]?.aborted).toBe(true)
	expect(engine.streams[0]?.closed).toBe(true)
})

it('an already aborted signal opens nothing', async () => {
	const engine = new FakeEngine()
	const service = ready(engine)
	const controller = new AbortController()
	controller.abort()
	await expect(
		collect(
			new LocalVoiceActivityDetector(service).detect(
				source(pattern('###')),
				live(controller.signal),
			),
		),
	).resolves.toEqual([])
	expect(engine.streams).toHaveLength(0)
})

it('unloads the speech model, then the whole engine, after the idle time', async () => {
	vi.useFakeTimers()
	const engine = new FakeEngine()
	const service = ready(engine, { idleUnloadMs: 60_000 })
	await service.state()
	await service.transcribe(new Float32Array(100), new AbortController().signal)
	expect((await service.state()).engine).toBe('ready')
	await vi.advanceTimersByTimeAsync(59_999)
	expect(engine.unloaded).toBe(0)
	await vi.advanceTimersByTimeAsync(1)
	expect(engine.unloaded).toBe(1)
	expect(engine.disposed).toBe(1)
	expect((await service.state()).engine).toBe('unloaded')
	// The next request loads it again.
	await service.transcribe(new Float32Array(100), new AbortController().signal)
	expect((await service.state()).engine).toBe('ready')
})

it('keeps the engine while audio is open and unloads only after it closes', async () => {
	vi.useFakeTimers()
	const engine = new FakeEngine()
	const service = ready(engine, { idleUnloadMs: 1_000 })
	await service.state()
	const stream = await service.openVad()
	await vi.advanceTimersByTimeAsync(10_000)
	expect(engine.disposed).toBe(0)
	stream.close()
	stream.close()
	await vi.advanceTimersByTimeAsync(1_000)
	expect(engine.disposed).toBe(1)
})

it('zero idle time keeps the model loaded', async () => {
	vi.useFakeTimers()
	const engine = new FakeEngine()
	const service = ready(engine, { idleUnloadMs: 0 })
	await service.state()
	await service.transcribe(new Float32Array(100), new AbortController().signal)
	await vi.advanceTimersByTimeAsync(3_600_000)
	expect(engine.unloaded + engine.disposed).toBe(0)
})

it('shows working while a recognition runs', async () => {
	const engine = new FakeEngine()
	let release: () => void = () => undefined
	engine.hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const states: string[] = []
	const service = ready(engine, { onEvent: (event) => states.push(event.state.engine) })
	await service.state()
	const running = service.transcribe(new Float32Array(100), new AbortController().signal)
	await vi.waitFor(() => expect(states).toContain('working'))
	release()
	await running
	expect(states.at(-1)).toBe('ready')
})

it('dispose frees the engine and silences listeners', async () => {
	const engine = new FakeEngine()
	const events: unknown[] = []
	const service = ready(engine, { onEvent: (event) => events.push(event) })
	await service.state()
	await service.transcribe(new Float32Array(10), new AbortController().signal)
	await service.dispose()
	expect(engine.disposed).toBe(1)
	const count = events.length
	await expect(service.install()).rejects.toThrow(/closed/)
	expect(events).toHaveLength(count)
})
