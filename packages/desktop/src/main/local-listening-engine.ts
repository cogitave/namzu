import { Worker } from 'node:worker_threads'
import { LISTENING_LANGUAGE, LISTENING_THREADS } from './local-listening-assets.js'
import type { LocalListeningModelPaths } from './local-listening-install.js'
import {
	type ListeningWorkerData,
	type ListeningWorkerRequest,
	type ListeningWorkerResponse,
	MAX_QUEUED_TRANSCRIPTIONS,
	MAX_TRANSCRIBE_SAMPLES,
	MAX_VAD_FEED_SAMPLES,
	MAX_VAD_STREAMS,
	type VadFeedResult,
} from './local-listening-protocol.js'

export type { VadFeedResult } from './local-listening-protocol.js'

export interface ListeningVadStream {
	feed(samples: Float32Array): Promise<VadFeedResult>
	/** Closes any open segment, as when the audio source ended. */
	flush(): Promise<VadFeedResult>
	close(): void
}
/** What the service and the adapters need from inference, so tests can stand in for it. */
export interface ListeningEngine {
	openVad(): Promise<ListeningVadStream>
	/** `samples` already carry their roll and tail silence. Rejects with an AbortError on abort. */
	transcribe(samples: Float32Array, signal: AbortSignal): Promise<string>
	/** Frees the speech model but keeps voice-activity streams alive. */
	unloadRecognizer(): Promise<void>
	dispose(): Promise<void>
}

/** The slice of `worker_threads.Worker` the engine uses. */
export interface ListeningWorkerHandle {
	postMessage(message: ListeningWorkerRequest): void
	on(event: 'message', listener: (message: ListeningWorkerResponse) => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	on(event: 'exit', listener: (code: number) => void): unknown
	terminate(): Promise<unknown>
}
export interface WorkerListeningEngineOptions {
	paths: LocalListeningModelPaths
	workerUrl: URL
	threads?: number
	/** Test seam. */
	createWorker?: (url: URL, data: ListeningWorkerData) => ListeningWorkerHandle
}

export function abortError(): Error {
	const error = new Error('The listening request was cancelled.')
	error.name = 'AbortError'
	return error
}

/**
 * Inside a packaged app the archive cannot host a worker script, so the unpacked copy beside it
 * is used. Anywhere else the path is unchanged.
 */
export function unpackedWorkerPath(path: string): string {
	return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

interface Pending {
	resolve(response: ListeningWorkerResponse & { ok: true }): void
	reject(error: Error): void
}

/** One worker thread and its request table. The thread is spawned on first use and respawned after a crash. */
class Channel {
	private worker?: ListeningWorkerHandle
	private nextId = 1
	private pending = new Map<number, Pending>()
	constructor(
		private readonly spawn: () => ListeningWorkerHandle,
		private readonly onLost: () => void,
	) {}
	request(
		message: DistributiveOmit<ListeningWorkerRequest, 'id'>,
	): Promise<ListeningWorkerResponse & { ok: true }> {
		const worker = this.ensure()
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			try {
				worker.postMessage({ ...message, id } as ListeningWorkerRequest)
			} catch (error) {
				this.pending.delete(id)
				reject(error instanceof Error ? error : new Error('Listening stopped unexpectedly.'))
			}
		})
	}
	private ensure(): ListeningWorkerHandle {
		if (this.worker) return this.worker
		const worker = this.spawn()
		this.worker = worker
		worker.on('message', (response) => {
			const entry = this.pending.get(response.id)
			if (!entry) return
			this.pending.delete(response.id)
			if (response.ok) entry.resolve(response)
			else entry.reject(new Error(response.message))
		})
		const lost = (error: Error) => {
			if (this.worker !== worker) return
			this.worker = undefined
			const pending = [...this.pending.values()]
			this.pending.clear()
			for (const entry of pending) entry.reject(error)
			this.onLost()
		}
		worker.on('error', (error) => lost(error))
		worker.on('exit', () => lost(new Error('Listening stopped unexpectedly. Try again.')))
		return worker
	}
	async stop(): Promise<void> {
		const worker = this.worker
		if (!worker) return
		this.worker = undefined
		const pending = [...this.pending.values()]
		this.pending.clear()
		for (const entry of pending) entry.reject(abortError())
		await worker.terminate()
	}
}

/**
 * Inference in worker threads so a decode never blocks the main process. Voice-activity detection
 * and speech recognition run on separate threads: a recognition takes seconds, and the detector
 * must keep answering while it runs.
 */
export class WorkerListeningEngine implements ListeningEngine {
	private readonly vad: Channel
	private readonly recognizer: Channel
	private nextStream = 1
	private readonly streams = new Set<number>()
	private running = false
	private readonly queue: {
		samples: Float32Array
		signal: AbortSignal
		resolve(text: string): void
		reject(error: Error): void
	}[] = []
	private disposed = false
	constructor(private readonly options: WorkerListeningEngineOptions) {
		const create =
			options.createWorker ??
			((url: URL, data: ListeningWorkerData) =>
				new Worker(url, { workerData: data }) as unknown as ListeningWorkerHandle)
		const spawn = (role: ListeningWorkerData['role']) => () =>
			create(options.workerUrl, {
				role,
				paths: options.paths,
				threads: options.threads ?? LISTENING_THREADS,
				language: LISTENING_LANGUAGE,
			})
		// A lost voice-activity thread takes its streams with it; their next feed fails and they close.
		this.vad = new Channel(spawn('voiceActivity'), () => this.streams.clear())
		this.recognizer = new Channel(spawn('recognizer'), () => undefined)
	}

	async openVad(): Promise<ListeningVadStream> {
		if (this.disposed) throw new Error('Listening is closed.')
		if (this.streams.size >= MAX_VAD_STREAMS)
			throw new Error('Too many listening sessions are open at once.')
		const stream = this.nextStream++
		await this.vad.request({ type: 'vad-open', stream })
		this.streams.add(stream)
		const feed = async (
			message: { type: 'vad-feed'; samples: Float32Array } | { type: 'vad-flush' },
		) => {
			if (!this.streams.has(stream)) throw new Error('This listening session has ended.')
			const response = await this.vad.request(
				message.type === 'vad-feed'
					? { type: 'vad-feed', stream, samples: message.samples }
					: { type: 'vad-flush', stream },
			)
			if (!response.vad) throw new Error('Listening returned an unexpected answer.')
			return response.vad
		}
		return {
			feed: (samples) => {
				if (samples.length > MAX_VAD_FEED_SAMPLES)
					return Promise.reject(new Error('That audio piece is too long to check for speech.'))
				return feed({ type: 'vad-feed', samples })
			},
			flush: () => feed({ type: 'vad-flush' }),
			close: () => {
				if (!this.streams.delete(stream)) return
				void this.vad.request({ type: 'vad-close', stream }).catch(() => undefined)
			},
		}
	}

	transcribe(samples: Float32Array, signal: AbortSignal): Promise<string> {
		if (this.disposed) return Promise.reject(new Error('Listening is closed.'))
		if (signal.aborted) return Promise.reject(abortError())
		if (samples.length === 0) return Promise.resolve('')
		if (samples.length > MAX_TRANSCRIBE_SAMPLES)
			return Promise.reject(new Error('That speech is too long to write down at once.'))
		if (this.queue.length >= MAX_QUEUED_TRANSCRIPTIONS)
			return Promise.reject(new Error('Listening is busy. Try again in a moment.'))
		return new Promise<string>((resolve, reject) => {
			const entry = { samples, signal, resolve, reject }
			signal.addEventListener(
				'abort',
				() => {
					const at = this.queue.indexOf(entry)
					// A queued request leaves the queue; one already decoding finishes in the background
					// (a native decode cannot be interrupted) and its text is dropped.
					if (at >= 0) this.queue.splice(at, 1)
					reject(abortError())
				},
				{ once: true },
			)
			this.queue.push(entry)
			void this.pump()
		})
	}

	private async pump(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			for (;;) {
				const entry = this.queue.shift()
				if (!entry) return
				if (entry.signal.aborted) continue
				try {
					const response = await this.recognizer.request({
						type: 'transcribe',
						samples: entry.samples,
					})
					entry.resolve(response.text ?? '')
				} catch (error) {
					entry.reject(error instanceof Error ? error : new Error('Listening failed.'))
				}
			}
		} finally {
			this.running = false
		}
	}

	async unloadRecognizer(): Promise<void> {
		await this.recognizer.stop()
	}

	async dispose(): Promise<void> {
		this.disposed = true
		this.streams.clear()
		for (const entry of this.queue.splice(0)) entry.reject(abortError())
		await Promise.all([this.vad.stop(), this.recognizer.stop()])
	}
}
