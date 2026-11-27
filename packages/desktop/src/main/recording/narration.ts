import { LOCAL_LISTENING_SAMPLE_RATE } from '../../shared/local-listening-protocol.js'
import {
	AsyncChannel,
	type ListeningFrame,
	SampleRing,
	utteranceSamples,
} from '../local-listening-stream.js'
import { type LocalListeningService, pumpFrames } from '../local-listening.js'
import { isInventedTranscript } from '../voice-endpointing.js'

/**
 * The person's voice during a recording, turned into `say` events on this computer. Audio from the
 * window goes through the same pinned voice-activity model the voice input uses; each finished
 * segment is decoded by the local recognizer directly (`transcribe`), with no language label, and
 * only that text is kept. Audio is held for the segment being decoded and no longer; nothing is
 * written anywhere, and nothing here feeds a conversation.
 */

/** What narration needs of the listening service; the real one and a test's fake both fit. */
export type NarrationService = Pick<LocalListeningService, 'openVad' | 'transcribe'>

export interface NarrationOptions {
	service: NarrationService
	/** One piece of the person's speech and the recorded millisecond it began. */
	say(text: string, startMs: number): void
	/** The models stopped answering. Recording goes on without voice. */
	onDisconnect(error: unknown): void
}

export class RecordingNarration {
	private readonly channel = new AsyncChannel<ListeningFrame>()
	private readonly abort = new AbortController()
	private readonly ring = new SampleRing()
	private chain: Promise<void> = Promise.resolve()
	private loop: Promise<void> | undefined
	private pushed = 0
	private stopped = false
	private failed = false

	constructor(private readonly options: NarrationOptions) {}

	get running(): boolean {
		return this.loop !== undefined && !this.stopped && !this.failed
	}

	start(): void {
		if (this.loop) return
		const signal = this.abort.signal
		this.loop = pumpFrames(this.options.service as LocalListeningService, this.channel, signal, {
			samples: (samples) => this.ring.push(samples),
			events: (events) => {
				for (const event of events) {
					if (event.type !== 'speech_end' || !event.segment) continue
					const samples = utteranceSamples(this.ring, event.segment)
					const startMs = event.startMs
					this.chain = this.chain.then(() => this.decode(samples, startMs))
				}
			},
		}).then(
			async () => {
				await this.chain
			},
			(error) => this.fail(error),
		)
	}

	/** Takes ownership of 16 kHz mono samples. */
	push(samples: Float32Array): void {
		if (this.stopped || this.failed) return
		this.channel.push({
			channels: 1,
			format: 'pcm_f32le',
			sampleRateHz: LOCAL_LISTENING_SAMPLE_RATE,
			samplesPerChannel: samples.length,
			data: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
			timestampMs: (this.pushed * 1000) / LOCAL_LISTENING_SAMPLE_RATE,
		})
		this.pushed += samples.length
	}

	private async decode(samples: Float32Array, startMs: number): Promise<void> {
		if (this.stopped || this.failed) return
		try {
			const text = (await this.options.service.transcribe(samples, this.abort.signal)).trim()
			if (!text || this.abort.signal.aborted || isInventedTranscript(text)) return
			this.options.say(text, startMs)
		} catch (error) {
			if (!this.abort.signal.aborted) this.fail(error)
		}
	}

	private fail(error: unknown): void {
		if (this.failed || this.stopped) return
		this.failed = true
		this.channel.close()
		this.options.onDisconnect(error)
	}

	/** Ends narration and waits for the segment being decoded. */
	async stop(): Promise<void> {
		if (this.stopped) return
		this.channel.close()
		// Let the last segment finish before the abort cuts decoding.
		await this.loop?.catch(() => undefined)
		this.stopped = true
		this.abort.abort()
	}
}
