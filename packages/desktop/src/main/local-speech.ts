import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
	DEFAULT_LOCAL_SPEECH_SETTINGS,
	LOCAL_SPEECH_MODEL_BYTES,
	LOCAL_SPEECH_PREVIEW_TEXT,
	LOCAL_SPEECH_SAMPLE_RATE,
	type LocalSpeechEvent,
	type LocalSpeechSettings,
	type LocalSpeechState,
	localSpeechRequestId,
	localSpeechSettings,
	localSpeechText,
} from '../shared/local-speech-protocol.js'
import {
	type LocalSpeechInstallation,
	type LocalSpeechPython,
	installLocalSpeech,
	localSpeechRuntimePaths,
	readLocalSpeechInstallation,
} from './local-speech-install.js'
import {
	LocalSpeechInstallShutdownError,
	LocalSpeechInstallerProcesses,
} from './local-speech-process.js'

const MAX_WORKER_FRAME = 32_768
const MAX_PCM_BYTES = (LOCAL_SPEECH_SAMPLE_RATE / 5) * 2
const MAX_REQUEST_AUDIO_BYTES = LOCAL_SPEECH_SAMPLE_RATE * 2 * 15 * 60

export interface LocalSpeechOptions {
	directory: string
	/** Trusted native configuration only. Never expose executable or file paths through renderer IPC. */
	python?: LocalSpeechPython
	/** Native Electron net.fetch uses the host certificate store; never supplied by a renderer. */
	fetch?: typeof fetch
	onEvent?(event: LocalSpeechEvent): void
	/** Dependency seams allow deterministic ownership, cancellation and install tests without models. */
	spawn?: typeof spawn
	readInstallation?: typeof readLocalSpeechInstallation
	install?: typeof installLocalSpeech
}
interface ActiveSpeech {
	id: string
	sequence: number
	bytes: number
	pending: Set<number>
	startedAt: number
}
interface Worker {
	child: ChildProcessWithoutNullStreams
	decoder: StringDecoder
	buffer: string
	closed: Promise<void>
	resourcesTimer?: ReturnType<typeof setInterval>
}

/** One isolated optional local speech worker owned by the native application. */
export class LocalSpeechService {
	private current: LocalSpeechState = {
		settings: { ...DEFAULT_LOCAL_SPEECH_SETTINGS },
		installation: 'missing',
		worker: 'unloaded',
		device: 'cpu',
		resources: {
			modelDownloadBytes: LOCAL_SPEECH_MODEL_BYTES,
			runtimeDownloadBytes: null,
			diskBytes: null,
			ramBytes: null,
			cpuPercent: null,
			vramBytes: null,
			firstAudioMs: null,
			measuredAt: null,
		},
	}
	private readonly listeners = new Set<(event: LocalSpeechEvent) => void>()
	private readonly initialized: Promise<void>
	private settingsWrites: Promise<void> = Promise.resolve()
	private installation?: LocalSpeechInstallation
	private installing?: Promise<LocalSpeechState>
	private installController?: AbortController
	private readonly installerProcesses = new LocalSpeechInstallerProcesses()
	private worker?: Worker
	private stopping: Promise<void> = Promise.resolve()
	private active?: ActiveSpeech
	private starting?: { id: string; revision: number }
	private speakRevision = 0
	private idleTimer?: ReturnType<typeof setTimeout>
	private disposed = false
	private preferencesWarning?: string
	constructor(private readonly options: LocalSpeechOptions) {
		if (options.onEvent) this.listeners.add(options.onEvent)
		this.initialized = this.initialize()
	}
	private async initialize(): Promise<void> {
		try {
			const source = await readFile(join(this.options.directory, 'settings.json'), 'utf8')
			if (source.length > 4_096) throw new Error('Invalid local speech preferences.')
			this.current.settings = localSpeechSettings(JSON.parse(source))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.preferencesWarning =
					'Saved speech preferences could not be read. Speech remains disabled.'
				this.current.error = this.preferencesWarning
			}
		}
		try {
			this.installation = await (this.options.readInstallation ?? readLocalSpeechInstallation)(
				this.options.directory,
			)
			if (this.installation) this.applyInstallation(this.installation)
		} catch {
			this.current.installation = 'failed'
			this.current.error = 'Local speech installation integrity check failed.'
		}
	}
	subscribe(listener: (event: LocalSpeechEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private emit(event: LocalSpeechEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {
				// A disconnected renderer cannot break worker ownership or backpressure.
			}
		}
	}
	private snapshot(): LocalSpeechState {
		return structuredClone(this.current)
	}
	private changed(): void {
		if (!this.disposed) this.emit({ type: 'state', state: this.snapshot() })
	}
	async state(): Promise<LocalSpeechState> {
		await this.initialized
		return this.snapshot()
	}
	async configure(patch: Partial<LocalSpeechSettings>): Promise<LocalSpeechState> {
		await this.initialized
		if (this.disposed) throw new Error('Local speech service is closed.')
		localSpeechSettings(patch, this.current.settings)
		const write = this.settingsWrites.then(async () => {
			if (this.disposed) throw new Error('Local speech service is closed.')
			const settings = localSpeechSettings(patch, this.current.settings)
			await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
			const temporary = join(this.options.directory, `settings-${randomUUID()}.tmp`)
			await writeFile(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
			await rename(temporary, join(this.options.directory, 'settings.json'))
			this.current.settings = settings
			if (this.current.error === this.preferencesWarning) this.current.error = undefined
			this.preferencesWarning = undefined
			if (!settings.enabled) {
				if (this.active) this.cancel(this.active.id)
				else this.stopWorker()
			} else this.scheduleIdleUnload()
			this.changed()
		})
		this.settingsWrites = write.catch(() => undefined)
		await write
		return this.snapshot()
	}
	private applyInstallation(installation: LocalSpeechInstallation): void {
		this.installation = installation
		this.current.installation = 'ready'
		this.current.resources.runtimeDownloadBytes = installation.runtimeDownloadBytes
		this.current.resources.diskBytes = installation.diskBytes
		this.current.error = this.preferencesWarning
	}
	async install(): Promise<LocalSpeechState> {
		await this.initialized
		if (this.disposed) throw new Error('Local speech service is closed.')
		if (this.installation) return this.snapshot()
		if (this.installing) return this.installing
		this.current.installation = 'installing'
		this.current.error = undefined
		this.installController = new AbortController()
		this.changed()
		this.installing = (async () => {
			try {
				const installation = await (this.options.install ?? installLocalSpeech)({
					directory: this.options.directory,
					python: this.options.python,
					fetch: this.options.fetch,
					run: this.installerProcesses.run,
					signal: this.installController?.signal,
				})
				if (!this.disposed) this.applyInstallation(installation)
			} catch (error) {
				if (!this.disposed) {
					this.current.installation = 'failed'
					this.current.error =
						error instanceof LocalSpeechInstallShutdownError
							? error.message
							: error instanceof Error &&
									(error.message.startsWith('Local speech needs Python') ||
										error.message.startsWith('Local speech model ') ||
										error.message ===
											'Local speech installation failed. Its incomplete runtime could not be safely removed.')
								? error.message
								: 'Local speech installation failed. Check Python and the connection, then try again.'
				}
			} finally {
				this.installing = undefined
				this.installController = undefined
				this.changed()
			}
			return this.snapshot()
		})()
		return this.installing
	}
	async speak(input: { requestId: string; text: string; preview?: boolean }): Promise<{
		requestId: string
	}> {
		const requestId = localSpeechRequestId(input.requestId)
		const text = localSpeechText(input.text)
		const preview = input.preview === true
		if (preview && text !== LOCAL_SPEECH_PREVIEW_TEXT)
			throw new Error('Voice preview uses only the fixed Turkish sample.')
		const revision = ++this.speakRevision
		this.starting = { id: requestId, revision }
		await this.initialized
		if (this.speakRevision !== revision) throw new Error('Speech request was superseded.')
		if (this.disposed) throw new Error('Local speech service is closed.')
		if (!this.current.settings.enabled && !preview)
			throw new Error('Enable local speech before playing audio.')
		if (!this.installation) throw new Error('Install the local speech engine before playing audio.')
		if (this.active) this.cancel(this.active.id)
		await this.stopping
		if (this.speakRevision !== revision) throw new Error('Speech request was superseded.')
		if (this.disposed || (!this.current.settings.enabled && !preview))
			throw new Error('Local speech is no longer enabled.')
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = undefined
		const worker = this.worker ?? this.startWorker()
		this.active = {
			id: requestId,
			sequence: 0,
			bytes: 0,
			pending: new Set(),
			startedAt: performance.now(),
		}
		this.starting = undefined
		this.current.worker = this.current.worker === 'ready' ? 'speaking' : 'loading'
		this.current.error = this.preferencesWarning
		this.changed()
		this.write(worker, { type: 'speak', requestId, text })
		return { requestId }
	}
	acknowledge(requestId: string, sequence: number): void {
		localSpeechRequestId(requestId)
		if (!Number.isSafeInteger(sequence) || sequence < 0)
			throw new Error('Invalid local speech audio acknowledgement.')
		const active = this.active
		if (!active || active.id !== requestId || !active.pending.delete(sequence)) return
		if (this.worker) this.write(this.worker, { type: 'ack', requestId, sequence })
	}
	cancel(requestId: string): void {
		localSpeechRequestId(requestId)
		if (this.starting?.id === requestId) {
			this.speakRevision += 1
			this.starting = undefined
			this.emit({ type: 'end', requestId, reason: 'cancelled' })
		}
		if (!this.active || this.active.id !== requestId) return
		this.active = undefined
		this.emit({ type: 'end', requestId, reason: 'cancelled' })
		// CPU planning can block inside a tensor operation. Terminating only this owned worker
		// stops computation as well as discarding stale playback; the next request loads afresh.
		this.stopWorker()
	}
	private write(worker: Worker, message: Record<string, unknown>): void {
		if (this.worker !== worker || worker.child.stdin.destroyed) return
		worker.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error && this.worker === worker)
				this.failWorker(worker, 'Local speech worker disconnected.')
		})
	}
	private startWorker(): Worker {
		if (!this.installation) throw new Error('Local speech engine is not installed.')
		const paths = localSpeechRuntimePaths(
			this.options.directory,
			this.installation.runtimeDirectory,
		)
		const child = (this.options.spawn ?? spawn)(
			paths.python,
			// Isolated Python ignores PYTHON* environment options. Select UTF-8 explicitly
			// so Windows pipes preserve Turkish characters independently of the locale.
			['-I', '-X', 'utf8', '-u', paths.worker, '--models', paths.models],
			{
				cwd: paths.runtime,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...process.env,
					HF_HUB_OFFLINE: '1',
					HF_HUB_DISABLE_TELEMETRY: '1',
					CUDA_VISIBLE_DEVICES: '',
					PYTHONNOUSERSITE: '1',
					XDG_CACHE_HOME: join(paths.runtime, 'cache'),
				},
			},
		) as ChildProcessWithoutNullStreams
		const worker: Worker = {
			child,
			buffer: '',
			decoder: new StringDecoder('utf8'),
			closed: Promise.resolve(),
		}
		worker.closed = new Promise((resolve) =>
			child.once('close', () => {
				if (worker.resourcesTimer) clearInterval(worker.resourcesTimer)
				if (this.worker === worker)
					this.failWorker(worker, 'Local speech worker stopped unexpectedly.')
				resolve()
			}),
		)
		this.worker = worker
		child.stdout.on('data', (chunk: Buffer) => {
			if (this.worker !== worker) return
			worker.buffer += worker.decoder.write(chunk)
			while (worker.buffer.includes('\n')) {
				const boundary = worker.buffer.indexOf('\n')
				if (boundary > MAX_WORKER_FRAME) {
					this.failWorker(worker, 'Local speech worker returned invalid audio.')
					return
				}
				const frame = worker.buffer.slice(0, boundary)
				worker.buffer = worker.buffer.slice(boundary + 1)
				try {
					this.readWorkerFrame(worker, JSON.parse(frame))
				} catch {
					this.failWorker(worker, 'Local speech worker returned invalid audio.')
					return
				}
				if (this.worker !== worker) return
			}
			if (worker.buffer.length > MAX_WORKER_FRAME)
				this.failWorker(worker, 'Local speech worker returned invalid audio.')
		})
		child.stderr.resume()
		child.once('error', () => this.failWorker(worker, 'Local speech worker could not start.'))
		worker.resourcesTimer = setInterval(() => {
			if (this.worker === worker) this.write(worker, { type: 'sample' })
		}, 2_000)
		worker.resourcesTimer.unref()
		return worker
	}
	private updateResources(value: unknown): void {
		if (!value || typeof value !== 'object') return
		const resources = value as Record<string, unknown>
		for (const field of ['ramBytes', 'cpuPercent'] as const) {
			const sample = resources[field]
			if (sample === null || (typeof sample === 'number' && Number.isFinite(sample) && sample >= 0))
				this.current.resources[field] = sample
		}
		this.current.resources.measuredAt = new Date().toISOString()
	}
	private readWorkerFrame(worker: Worker, value: unknown): void {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid speech frame.')
		const frame = value as Record<string, unknown>
		if (['started', 'resources', 'ready'].includes(frame.type as string)) {
			this.updateResources(frame.resources)
			if (frame.type === 'ready') this.current.worker = this.active ? 'speaking' : 'ready'
			this.changed()
			return
		}
		if (frame.type === 'loading') {
			this.current.worker = 'loading'
			this.changed()
			return
		}
		const active = this.active
		if (!active || frame.requestId !== active.id) return
		if (frame.type === 'audio') {
			if (
				frame.sequence !== active.sequence ||
				frame.sampleRate !== LOCAL_SPEECH_SAMPLE_RATE ||
				typeof frame.pcmBase64 !== 'string' ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(frame.pcmBase64) ||
				frame.pcmBase64.length > Math.ceil(MAX_PCM_BYTES / 3) * 4 ||
				active.pending.size >= 2
			)
				throw new Error('Invalid speech audio.')
			const pcm = Buffer.from(frame.pcmBase64, 'base64')
			if (
				!pcm.length ||
				pcm.length > MAX_PCM_BYTES ||
				pcm.length % 2 !== 0 ||
				pcm.toString('base64') !== frame.pcmBase64
			)
				throw new Error('Invalid speech audio.')
			active.bytes += pcm.length
			if (active.bytes > MAX_REQUEST_AUDIO_BYTES)
				throw new Error('Speech audio exceeded its limit.')
			active.pending.add(active.sequence)
			active.sequence += 1
			if (frame.sequence === 0) {
				// Includes model cold loading and IPC overhead observed on this device.
				this.current.resources.firstAudioMs = performance.now() - active.startedAt
				this.current.resources.measuredAt = new Date().toISOString()
				this.current.worker = 'speaking'
				this.changed()
			}
			this.emit({
				type: 'audio',
				requestId: active.id,
				sequence: frame.sequence as number,
				sampleRate: LOCAL_SPEECH_SAMPLE_RATE,
				format: 'pcm_s16le',
				channels: 1,
				pcmBase64: frame.pcmBase64,
			})
			return
		}
		if (frame.type === 'end') {
			if (active.pending.size !== 0)
				throw new Error('Speech ended before playback acknowledged audio.')
			this.active = undefined
			this.current.worker = 'ready'
			this.updateResources(frame.resources)
			this.emit({ type: 'end', requestId: active.id, reason: 'completed' })
			this.changed()
			this.scheduleIdleUnload()
			return
		}
		if (frame.type === 'error') {
			this.failWorker(worker, 'Local speech generation failed. Try a shorter Turkish sentence.')
			return
		}
		throw new Error('Invalid speech event.')
	}
	private failWorker(worker: Worker, message: string): void {
		if (this.worker !== worker) return
		const requestId = this.active?.id
		this.active = undefined
		this.current.error = message
		if (requestId) this.emit({ type: 'error', requestId, message })
		this.stopWorker()
	}
	private stopWorker(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = undefined
		const worker = this.worker
		this.worker = undefined
		if (worker) {
			if (worker.resourcesTimer) clearInterval(worker.resourcesTimer)
			worker.child.stdin.destroy()
			if (worker.child.exitCode === null && worker.child.signalCode === null)
				worker.child.kill('SIGTERM')
			this.stopping = worker.closed
		}
		this.current.worker = 'unloaded'
		this.current.resources.ramBytes = null
		this.current.resources.cpuPercent = null
		this.current.resources.measuredAt = null
		this.changed()
	}
	private scheduleIdleUnload(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.idleTimer = undefined
		if (
			this.disposed ||
			!this.worker ||
			this.active ||
			this.current.settings.idleUnloadSeconds === 0
		)
			return
		this.idleTimer = setTimeout(
			() => this.stopWorker(),
			this.current.settings.idleUnloadSeconds * 1_000,
		)
		this.idleTimer.unref()
	}
	async dispose(): Promise<void> {
		if (this.disposed) return this.installerProcesses.close()
		this.disposed = true
		this.speakRevision += 1
		this.starting = undefined
		this.installController?.abort()
		if (this.active) this.cancel(this.active.id)
		else this.stopWorker()
		await Promise.all([
			this.stopping,
			this.settingsWrites,
			this.installing,
			this.installerProcesses.close(),
		])
		this.listeners.clear()
	}
}

/** Structural @namzu/live SpeechSynthesizer adapter without introducing a Desktop dependency. */
export class LocalSpeechSynthesizer {
	constructor(private readonly service: LocalSpeechService) {}
	async *synthesize(
		text: AsyncIterable<string>,
		context: { signal: AbortSignal; turnId: string },
	): AsyncIterable<{
		final: boolean
		frame: {
			channels: number
			data: Uint8Array
			format: 'pcm_s16le'
			sampleRateHz: number
			samplesPerChannel: number
			sequence: number
		}
	}> {
		let segment = ''
		let outputSequence = 0
		const speak = async function* (service: LocalSpeechService, body: string) {
			const requestId = `synthesis_${randomUUID()}`
			const inbox: LocalSpeechEvent[] = []
			let wake: (() => void) | undefined
			let finished = false
			const unsubscribe = service.subscribe((event) => {
				if (event.type === 'state' || event.requestId !== requestId) return
				inbox.push(event)
				wake?.()
			})
			const abort = () => service.cancel(requestId)
			context.signal.addEventListener('abort', abort, { once: true })
			try {
				if (context.signal.aborted) return
				await service.speak({ requestId, text: body })
				while (!finished && !context.signal.aborted) {
					if (!inbox.length)
						await new Promise<void>((resolve) => {
							wake = resolve
						})
					wake = undefined
					while (inbox.length) {
						const event = inbox.shift()
						if (!event || event.type === 'state') continue
						if (event.type === 'audio') {
							const data = Buffer.from(event.pcmBase64, 'base64')
							yield {
								final: false,
								frame: {
									channels: 1,
									data,
									format: 'pcm_s16le' as const,
									sampleRateHz: event.sampleRate,
									samplesPerChannel: data.length / 2,
									sequence: outputSequence++,
								},
							}
							service.acknowledge(requestId, event.sequence)
						} else if (event.type === 'error') throw new Error(event.message)
						else finished = true
					}
				}
			} finally {
				context.signal.removeEventListener('abort', abort)
				unsubscribe()
				if (!finished) service.cancel(requestId)
			}
		}
		for await (const delta of text) {
			if (context.signal.aborted) return
			if (typeof delta !== 'string' || delta.length > 8_000)
				throw new Error('Invalid or oversized speech text stream segment.')
			segment += delta
			while (segment.length >= 500 || /[.!?\n]\s*$/.test(segment)) {
				const boundary = Math.min(segment.length, 500)
				const body = segment.slice(0, boundary)
				segment = segment.slice(boundary)
				if (body.trim()) yield* speak(this.service, body)
			}
		}
		if (segment.trim() && !context.signal.aborted) yield* speak(this.service, segment)
		if (!context.signal.aborted)
			yield {
				final: true,
				frame: {
					channels: 1,
					data: new Uint8Array(),
					format: 'pcm_s16le',
					sampleRateHz: LOCAL_SPEECH_SAMPLE_RATE,
					samplesPerChannel: 0,
					sequence: outputSequence,
				},
			}
	}
}
