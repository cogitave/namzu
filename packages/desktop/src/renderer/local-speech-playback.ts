/** Mono PCM is scheduled as it arrives; cancellation stops both queued and playing frames. */
export interface SpeechAudioBuffer {
	copyToChannel(samples: Float32Array, channel: number): void
}

export interface SpeechAudioSource {
	buffer: SpeechAudioBuffer | null
	onended: ((event: Event) => void) | null
	connect(destination: unknown): void
	disconnect(): void
	start(at: number): void
	stop(): void
}

export interface SpeechAudioContext {
	currentTime: number
	destination: unknown
	state: string
	createBuffer(channels: number, frames: number, sampleRate: number): SpeechAudioBuffer
	createBufferSource(): SpeechAudioSource
	resume(): Promise<void>
	close(): Promise<void>
}

const MAX_BUFFERED_SECONDS = 30

export class LocalSpeechPlayback {
	private context: SpeechAudioContext | undefined
	private opening: Promise<void> | undefined
	private generation = 0
	private nextAt = 0
	private ended = false
	private sources = new Set<SpeechAudioSource>()

	constructor(
		private createContext: () => SpeechAudioContext = () => new AudioContext(),
		private onDrained: () => void = () => {},
	) {}

	/** Must be called from the user's click so Web Audio can obtain playback permission. */
	open(): Promise<void> {
		if (this.opening) return this.opening
		const generation = this.generation
		const context = this.createContext()
		this.context = context
		this.ended = false
		this.opening = context.resume().then(() => {
			if (this.generation !== generation || this.context !== context)
				throw new Error('Speech playback was stopped.')
		})
		return this.opening
	}

	append(samples: Float32Array, sampleRate: number, onPlayed?: () => void): void {
		const context = this.context
		if (!context || context.state === 'closed' || this.ended)
			throw new Error('Speech playback is not active.')
		if (
			!Number.isInteger(sampleRate) ||
			sampleRate < 8_000 ||
			sampleRate > 96_000 ||
			samples.length === 0 ||
			samples.length > sampleRate * 10 ||
			samples.some((sample) => !Number.isFinite(sample) || Math.abs(sample) > 1)
		)
			throw new Error('The local voice returned invalid audio.')
		const at = Math.max(context.currentTime + 0.03, this.nextAt)
		const until = at + samples.length / sampleRate
		if (until - context.currentTime > MAX_BUFFERED_SECONDS)
			throw new Error('The local voice returned audio faster than it can be played.')
		const buffer = context.createBuffer(1, samples.length, sampleRate)
		buffer.copyToChannel(samples, 0)
		const source = context.createBufferSource()
		source.buffer = buffer
		source.connect(context.destination)
		source.onended = () => {
			if (this.context !== context || !this.sources.has(source)) return
			this.sources.delete(source)
			source.disconnect()
			onPlayed?.()
			this.checkDrained()
		}
		this.sources.add(source)
		try {
			source.start(at)
			this.nextAt = until
		} catch (error) {
			this.sources.delete(source)
			source.disconnect()
			throw error
		}
	}

	/** Generation ended; retain playing audio until its actual ended events arrive. */
	finish(): void {
		this.ended = true
		this.checkDrained()
	}

	stop(): void {
		this.generation += 1
		this.ended = true
		for (const source of this.sources) {
			source.onended = null
			try {
				source.stop()
			} catch {
				// A source may have already ended while the owner was closing.
			}
			source.disconnect()
		}
		this.sources.clear()
		const context = this.context
		this.context = undefined
		this.opening = undefined
		this.nextAt = 0
		if (context && context.state !== 'closed') void context.close().catch(() => {})
	}

	private checkDrained(): void {
		if (!this.ended || this.sources.size !== 0 || !this.context) return
		this.stop()
		this.onDrained()
	}
}

/** The native bridge sends little-endian signed 16-bit PCM, never an audio URL. */
export function decodeSpeechPcm(base64: string): Float32Array {
	if (
		typeof base64 !== 'string' ||
		!base64 ||
		base64.length > 12_800 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
	)
		throw new Error('The local voice returned invalid audio.')
	const binary = atob(base64)
	if (binary.length % 2 !== 0) throw new Error('The local voice returned invalid audio.')
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
	const view = new DataView(bytes.buffer)
	const samples = new Float32Array(bytes.byteLength / 2)
	for (let index = 0; index < samples.length; index++)
		samples[index] = view.getInt16(index * 2, true) / 32_768
	return samples
}
