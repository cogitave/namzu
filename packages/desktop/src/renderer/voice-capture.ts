import { Chunker, Resampler, clampSamples } from './voice-resampler.js'

/** The slice of the browser the capture uses, so a test can stand in for the microphone. */
export interface CaptureTrack {
	stop(): void
	onended: ((event: unknown) => void) | null
}
export interface CaptureStream {
	getTracks(): CaptureTrack[]
}
export interface CaptureNode {
	port: { onmessage: ((event: { data: Float32Array }) => void) | null; close(): void }
	connect(destination: unknown): unknown
	disconnect(): void
}
export interface CaptureContext {
	readonly sampleRate: number
	readonly destination: unknown
	readonly audioWorklet: { addModule(url: string): Promise<void> }
	createMediaStreamSource(stream: CaptureStream): CaptureNode
	createGain(): CaptureNode & { gain: { value: number } }
	resume(): Promise<void>
	close(): Promise<void>
}
export interface CaptureEnvironment {
	getUserMedia(constraints: MediaStreamConstraints): Promise<CaptureStream>
	createContext(): CaptureContext
	createWorkletNode(context: CaptureContext): CaptureNode
	workletUrl: string
}

export type CaptureFailure = 'denied' | 'missing' | 'busy' | 'unavailable'
export class CaptureError extends Error {
	constructor(readonly kind: CaptureFailure) {
		super(captureMessage(kind))
		this.name = 'CaptureError'
	}
}
/** One plain sentence and the next step; nothing technical. */
export function captureMessage(kind: CaptureFailure): string {
	switch (kind) {
		case 'denied':
			return 'Namzu can’t use the microphone. Allow microphone access in Windows settings, then try again.'
		case 'missing':
			return 'No microphone was found. Connect one, then try again.'
		case 'busy':
			return 'The microphone is being used by another app. Close it, then try again.'
		default:
			return 'The microphone couldn’t be started. Try again.'
	}
}
function failureKind(error: unknown): CaptureFailure {
	const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
	if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
	if (name === 'NotReadableError' || name === 'AbortError') return 'busy'
	return 'unavailable'
}

export function browserEnvironment(): CaptureEnvironment {
	return {
		getUserMedia: (constraints) =>
			navigator.mediaDevices.getUserMedia(constraints) as unknown as Promise<CaptureStream>,
		createContext: () =>
			new AudioContext({ latencyHint: 'interactive' }) as unknown as CaptureContext,
		createWorkletNode: (context) =>
			new AudioWorkletNode(context as unknown as AudioContext, 'namzu-voice-capture', {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: 1,
				channelCountMode: 'explicit',
			}) as unknown as CaptureNode,
		// A real file beside the page, so the page's own script policy allows it.
		workletUrl: new URL('./voice-capture-worklet.js', document.baseURI).href,
	}
}

export const CAPTURE_CONSTRAINTS = {
	audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
} as const satisfies MediaStreamConstraints

/** Opens the microphone and delivers about 100 ms of 16 kHz mono audio at a time until stopped. */
export class VoiceCapture {
	private stream: CaptureStream | undefined
	private context: CaptureContext | undefined
	private source: CaptureNode | undefined
	private worklet: CaptureNode | undefined
	private mute: ReturnType<CaptureContext['createGain']> | undefined
	private stopped = false
	constructor(
		private readonly environment: CaptureEnvironment,
		private readonly onChunk: (samples: Float32Array) => void,
		private readonly onFailure: (error: CaptureError) => void,
	) {}

	async start(): Promise<void> {
		try {
			const stream = await this.environment.getUserMedia(CAPTURE_CONSTRAINTS)
			this.stream = stream
			if (this.stopped) return this.release()
			const context = this.environment.createContext()
			this.context = context
			const resampler = new Resampler(context.sampleRate)
			const chunker = new Chunker()
			await context.audioWorklet.addModule(this.environment.workletUrl)
			if (this.stopped) return this.release()
			const worklet = this.environment.createWorkletNode(context)
			worklet.port.onmessage = (event) => {
				if (this.stopped) return
				for (const piece of chunker.push(resampler.process(event.data)))
					this.onChunk(clampSamples(piece))
			}
			const source = context.createMediaStreamSource(stream)
			// The node must be pulled by the graph, but it writes no output, so nothing is played.
			const mute = context.createGain()
			mute.gain.value = 0
			source.connect(worklet)
			worklet.connect(mute)
			mute.connect(context.destination)
			this.source = source
			this.worklet = worklet
			this.mute = mute
			for (const track of stream.getTracks())
				track.onended = () => {
					if (!this.stopped) this.fail(new CaptureError('missing'))
				}
			await context.resume()
		} catch (error) {
			const failure = error instanceof CaptureError ? error : new CaptureError(failureKind(error))
			this.release()
			throw failure
		}
	}

	stop(): void {
		this.stopped = true
		this.release()
	}

	private fail(error: CaptureError): void {
		this.release()
		this.onFailure(error)
	}
	private release(): void {
		this.stopped = true
		for (const node of [this.source, this.worklet, this.mute]) {
			try {
				if (node && 'port' in node) node.port.onmessage = null
				node?.disconnect()
				if (node && 'port' in node) node.port.close()
			} catch {
				// A node that already closed has nothing left to release.
			}
		}
		this.source = this.worklet = this.mute = undefined
		for (const track of this.stream?.getTracks() ?? []) {
			track.onended = null
			track.stop()
		}
		this.stream = undefined
		const context = this.context
		this.context = undefined
		if (context) void context.close().catch(() => {})
	}
}
