import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	LOCAL_LISTENING_SAMPLE_RATE,
	type LocalListeningEvent,
	type LocalListeningInstallProgress,
	type LocalListeningState,
} from '../shared/local-listening-protocol.js'
import { LISTENING_DOWNLOAD_BYTES } from './local-listening-assets.js'
import {
	type ListeningEngine,
	type ListeningVadStream,
	WorkerListeningEngine,
	unpackedWorkerPath,
} from './local-listening-engine.js'
import {
	LocalListeningInstallCancelled,
	type LocalListeningInstallation,
	type LocalListeningModelPaths,
	installLocalListening,
	localListeningModelPaths,
	readLocalListeningInstallation,
	uninstallLocalListening,
} from './local-listening-install.js'
import {
	AsyncChannel,
	FEED_SAMPLES,
	type ListeningFrame,
	SampleRing,
	type TimelineEvent,
	VadTimeline,
	listeningFrameSamples,
	utteranceSamples,
} from './local-listening-stream.js'

export const DEFAULT_LISTENING_IDLE_UNLOAD_MS = 300_000

export interface LocalListeningOptions {
	/** The `local-listening` folder under the profile (trusted native configuration only). */
	directory: string
	/** Native Electron net.fetch uses the host certificate store; never supplied by a renderer. */
	fetch?: typeof fetch
	onEvent?(event: LocalListeningEvent): void
	/** Zero keeps a loaded model in memory. */
	idleUnloadMs?: number
	/** Dependency seams allow deterministic install, ownership and unload tests without models. */
	createEngine?(paths: LocalListeningModelPaths): ListeningEngine
	install?: typeof installLocalListening
	readInstallation?: typeof readLocalListeningInstallation
	uninstall?: typeof uninstallLocalListening
}

/** Where the compiled worker lives, with the unpacked copy chosen inside a packaged app. */
export function defaultListeningWorkerUrl(): URL {
	const path = fileURLToPath(new URL('./local-listening-worker.mjs', import.meta.url))
	return pathToFileURL(unpackedWorkerPath(path))
}

const NOT_INSTALLED = 'Listening isn’t downloaded yet. Download it in Settings first.'

/** The optional on-device listening engine: download, state, and the shared inference workers. */
export class LocalListeningService {
	private current: LocalListeningState = {
		installation: 'missing',
		engine: 'unloaded',
		device: 'cpu',
		downloadBytes: LISTENING_DOWNLOAD_BYTES,
		diskBytes: null,
	}
	private readonly listeners = new Set<(event: LocalListeningEvent) => void>()
	private readonly initialized: Promise<void>
	private installation?: LocalListeningInstallation
	private installing?: Promise<LocalListeningState>
	private installController?: AbortController
	private engine?: ListeningEngine
	private openStreams = 0
	private working = 0
	private engineTimer?: ReturnType<typeof setTimeout>
	private recognizerTimer?: ReturnType<typeof setTimeout>
	private recognizerLoaded = false
	private disposed = false
	constructor(private readonly options: LocalListeningOptions) {
		if (options.onEvent) this.listeners.add(options.onEvent)
		this.initialized = this.initialize()
	}
	private async initialize(): Promise<void> {
		try {
			this.installation = await (this.options.readInstallation ?? readLocalListeningInstallation)(
				this.options.directory,
			)
			if (this.installation) this.applyInstallation(this.installation)
		} catch (error) {
			this.current.installation = 'failed'
			this.current.error = error instanceof Error ? error.message : 'Listening is unavailable.'
		}
	}
	subscribe(listener: (event: LocalListeningEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private emit(): void {
		if (this.disposed) return
		const event: LocalListeningEvent = { type: 'state', state: this.snapshot() }
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {
				// A disconnected renderer cannot break ownership of the workers.
			}
		}
	}
	private snapshot(): LocalListeningState {
		return structuredClone({
			...this.current,
			engine: !this.engine ? 'unloaded' : this.working > 0 ? 'working' : 'ready',
		})
	}
	async state(): Promise<LocalListeningState> {
		await this.initialized
		return this.snapshot()
	}
	private applyInstallation(installation: LocalListeningInstallation): void {
		this.installation = installation
		this.current.installation = 'ready'
		this.current.diskBytes = installation.diskBytes
		this.current.progress = undefined
		this.current.error = undefined
	}
	private noteProgress(progress: LocalListeningInstallProgress): void {
		const before = this.current.progress
		const percent = (value: LocalListeningInstallProgress | undefined) =>
			value?.downloadedBytes === undefined || !value.totalBytes
				? -1
				: Math.floor((100 * value.downloadedBytes) / value.totalBytes)
		this.current.progress = progress
		if (before?.step !== progress.step || percent(before) !== percent(progress)) this.emit()
	}

	/** Explicit action only; nothing downloads unless the person asked for it. */
	async install(): Promise<LocalListeningState> {
		await this.initialized
		if (this.disposed) throw new Error('Listening is closed.')
		if (this.installation) return this.snapshot()
		if (this.installing) return this.installing
		this.current.installation = 'installing'
		this.current.error = undefined
		this.current.progress = { step: 'preparing' }
		const controller = new AbortController()
		this.installController = controller
		this.emit()
		const run = (async () => {
			try {
				const installation = await (this.options.install ?? installLocalListening)({
					directory: this.options.directory,
					fetch: this.options.fetch,
					signal: controller.signal,
					onProgress: (progress) => this.noteProgress(progress),
				})
				this.applyInstallation(installation)
			} catch (error) {
				this.current.progress = undefined
				if (error instanceof LocalListeningInstallCancelled || controller.signal.aborted) {
					this.current.installation = 'missing'
					this.current.error = undefined
				} else {
					this.current.installation = 'failed'
					this.current.error =
						error instanceof Error ? error.message : 'Listening couldn’t be downloaded.'
				}
			} finally {
				this.installController = undefined
				this.installing = undefined
				this.emit()
			}
			return this.snapshot()
		})()
		this.installing = run
		return run
	}
	/** Stops a running download and deletes what it had written. */
	async cancelInstall(): Promise<LocalListeningState> {
		this.installController?.abort()
		if (this.installing) await this.installing
		return this.snapshot()
	}
	async uninstall(): Promise<LocalListeningState> {
		await this.initialized
		await this.cancelInstall()
		await this.stopEngine()
		await (this.options.uninstall ?? uninstallLocalListening)(this.options.directory)
		this.installation = undefined
		this.current.installation = 'missing'
		this.current.diskBytes = null
		this.current.progress = undefined
		this.current.error = undefined
		this.emit()
		return this.snapshot()
	}

	private async readyEngine(): Promise<ListeningEngine> {
		await this.initialized
		if (this.disposed) throw new Error('Listening is closed.')
		if (!this.installation || this.current.installation !== 'ready') throw new Error(NOT_INSTALLED)
		if (!this.engine) {
			const paths = localListeningModelPaths(this.options.directory)
			this.engine =
				this.options.createEngine?.(paths) ??
				new WorkerListeningEngine({ paths, workerUrl: defaultListeningWorkerUrl() })
			this.emit()
		}
		return this.engine
	}
	private idleMs(): number {
		return this.options.idleUnloadMs ?? DEFAULT_LISTENING_IDLE_UNLOAD_MS
	}
	private armEngineTimer(): void {
		clearTimeout(this.engineTimer)
		this.engineTimer = undefined
		if (this.disposed || !this.engine || this.openStreams > 0 || this.working > 0 || !this.idleMs())
			return
		this.engineTimer = setTimeout(() => {
			void this.stopEngine()
		}, this.idleMs())
	}
	private armRecognizerTimer(): void {
		clearTimeout(this.recognizerTimer)
		this.recognizerTimer = undefined
		if (
			this.disposed ||
			!this.engine ||
			!this.recognizerLoaded ||
			this.working > 0 ||
			!this.idleMs()
		)
			return
		const engine = this.engine
		this.recognizerTimer = setTimeout(() => {
			this.recognizerLoaded = false
			void engine.unloadRecognizer().catch(() => undefined)
		}, this.idleMs())
	}
	private async stopEngine(): Promise<void> {
		clearTimeout(this.engineTimer)
		clearTimeout(this.recognizerTimer)
		this.engineTimer = this.recognizerTimer = undefined
		const engine = this.engine
		this.engine = undefined
		this.recognizerLoaded = false
		if (engine) {
			this.emit()
			await engine.dispose().catch(() => undefined)
		}
	}

	/** Used by the adapters: a voice-activity stream held for as long as the audio is open. */
	async openVad(): Promise<ListeningVadStream> {
		const engine = await this.readyEngine()
		clearTimeout(this.engineTimer)
		this.openStreams++
		let stream: ListeningVadStream
		try {
			stream = await engine.openVad()
		} catch (error) {
			this.openStreams--
			this.armEngineTimer()
			throw error
		}
		let closed = false
		return {
			feed: (samples) => stream.feed(samples),
			flush: () => stream.flush(),
			close: () => {
				if (closed) return
				closed = true
				stream.close()
				this.openStreams--
				this.armEngineTimer()
			},
		}
	}
	/** Used by the adapters: one recognition on the shared worker. */
	async transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
		const engine = await this.readyEngine()
		clearTimeout(this.engineTimer)
		clearTimeout(this.recognizerTimer)
		this.working++
		this.recognizerLoaded = true
		this.emit()
		try {
			return await engine.transcribe(samples, signal)
		} finally {
			this.working--
			this.emit()
			this.armRecognizerTimer()
			this.armEngineTimer()
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.installController?.abort()
		await this.stopEngine()
		this.disposed = true
		this.listeners.clear()
	}
}

interface MediaContext {
	readonly signal: AbortSignal
}
interface VoiceActivityEvent {
	readonly timestampMs: number
	readonly type: 'speech_end' | 'speech_start'
}
interface TranscriptEvent {
	readonly language?: string
	readonly text: string
	readonly timestampMs: number
	readonly type: 'final_transcript'
}

/** Rejects when `signal` aborts, so a source that never yields cannot hold a stop request. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined)
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = () => resolve(undefined)
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}

/**
 * Feeds every frame of `frames` through a voice-activity stream, in pieces of at most 100 ms, and
 * reports what the timeline says after each. Shared by the detector and the recognizer so that
 * both see exactly the same boundaries.
 */
async function pumpFrames(
	service: LocalListeningService,
	frames: AsyncIterable<ListeningFrame>,
	signal: AbortSignal,
	handlers: {
		samples?(samples: Float32Array): void
		events(events: TimelineEvent[], timeline: VadTimeline): void
	},
): Promise<void> {
	if (signal.aborted) return
	const stream = await service.openVad()
	const iterator = frames[Symbol.asyncIterator]()
	let timeline: VadTimeline | undefined
	let fed = 0
	try {
		for (;;) {
			const next = await abortable(iterator.next(), signal)
			if (!next || next.done) break
			const samples = listeningFrameSamples(next.value)
			timeline ??= new VadTimeline(next.value.timestampMs ?? 0)
			handlers.samples?.(samples)
			for (let at = 0; at < samples.length; at += FEED_SAMPLES) {
				if (signal.aborted) return
				const piece = samples.subarray(at, at + FEED_SAMPLES)
				const result = await stream.feed(piece)
				fed += piece.length
				handlers.events(timeline.consume(result, fed), timeline)
			}
		}
		if (timeline && !signal.aborted)
			handlers.events(timeline.consume(await stream.flush(), fed, true), timeline)
	} finally {
		stream.close()
		// Releases a source still waiting for its next frame.
		void iterator.return?.(undefined)?.catch?.(() => undefined)
	}
}

/** Structural @namzu/live VoiceActivityDetector adapter without introducing a Desktop dependency. */
export class LocalVoiceActivityDetector {
	constructor(private readonly service: LocalListeningService) {}
	async *detect(
		frames: AsyncIterable<ListeningFrame>,
		context: MediaContext,
	): AsyncGenerator<VoiceActivityEvent> {
		const out = new AsyncChannel<VoiceActivityEvent>()
		const done = pumpFrames(this.service, frames, context.signal, {
			events: (events) => {
				for (const event of events) out.push({ type: event.type, timestampMs: event.timestampMs })
			},
		}).then(
			() => out.close(),
			(error) => out.fail(error),
		)
		try {
			yield* out
		} finally {
			await done
		}
	}
}

/** Structural @namzu/live SpeechRecognizer adapter: one final transcript per voice-activity segment. */
export class LocalSpeechRecognizer {
	constructor(private readonly service: LocalListeningService) {}
	async *transcribe(
		frames: AsyncIterable<ListeningFrame>,
		context: MediaContext,
	): AsyncGenerator<TranscriptEvent> {
		const out = new AsyncChannel<TranscriptEvent>()
		const ring = new SampleRing()
		// Recognitions run one after another, off the frame loop, so frames keep being checked.
		let chain: Promise<void> = Promise.resolve()
		const recognize = (
			segment: NonNullable<Extract<TimelineEvent, { type: 'speech_end' }>['segment']>,
			startMs: number,
			endMs: number,
		) => {
			const samples = utteranceSamples(ring, segment)
			chain = chain.then(async () => {
				if (context.signal.aborted) return
				const text = (await this.service.transcribe(samples, context.signal)).trim()
				if (!text || context.signal.aborted) return
				out.push({
					type: 'final_transcript',
					text,
					language: 'tr',
					// The middle of the segment cannot fall outside the interval the detector reports.
					timestampMs: (startMs + endMs) / 2,
				})
			})
			chain = chain.catch((error) => {
				// A recognition stopped by the caller's own abort is the stop, not a failure.
				if (!context.signal.aborted) out.fail(error)
			})
		}
		const done = pumpFrames(this.service, frames, context.signal, {
			samples: (samples) => ring.push(samples),
			events: (events) => {
				for (const event of events)
					if (event.type === 'speech_end' && event.segment)
						recognize(event.segment, event.startMs, event.timestampMs)
			},
		}).then(
			async () => {
				await chain
				out.close()
			},
			(error) => out.fail(error),
		)
		try {
			yield* out
		} finally {
			await done
		}
	}
}

export { LOCAL_LISTENING_SAMPLE_RATE }
