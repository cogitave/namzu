import { LOCAL_LISTENING_SAMPLE_RATE } from '../shared/local-listening-protocol.js'
import type { VadFeedResult } from './local-listening-protocol.js'

const RATE = LOCAL_LISTENING_SAMPLE_RATE
export const MS_PER_SAMPLE = 1000 / RATE
/** Audio kept before a segment's first sample, and after its last, in each recognizer input. */
export const PRE_ROLL_SAMPLES = Math.round(0.4 * RATE)
export const POST_ROLL_SAMPLES = Math.round(0.5 * RATE)
/** The recognizer drops the end of a short input; silence after the speech prevents it. */
export const TAIL_SILENCE_SAMPLES = Math.round(0.5 * RATE)
/** A voice-activity model is fed in pieces no longer than 100 ms. */
export const FEED_SAMPLES = Math.round(0.1 * RATE)
/** Longest span the sample ring remembers: an utterance cap plus its rolls. */
export const RING_SAMPLES = 33 * RATE

/** Structural twin of the live package's audio frame, so Desktop needs no runtime import. */
export interface ListeningFrame {
	readonly channels: number
	readonly data: Uint8Array
	readonly format: 'pcm_f32le' | 'pcm_s16le'
	readonly sampleRateHz: number
	readonly samplesPerChannel: number
	readonly timestampMs?: number
}

/** Converts a 16 kHz mono frame to float samples, or says plainly why it cannot. */
export function listeningFrameSamples(frame: ListeningFrame): Float32Array {
	if (frame.sampleRateHz !== RATE || frame.channels !== 1)
		throw new Error(
			`Listening needs 16 kHz mono audio, but this frame is ${frame.sampleRateHz} Hz with ${frame.channels} channel${frame.channels === 1 ? '' : 's'}.`,
		)
	const width = frame.format === 'pcm_s16le' ? 2 : frame.format === 'pcm_f32le' ? 4 : 0
	if (width === 0) throw new Error(`Listening can’t read ${String(frame.format)} audio.`)
	if (frame.data.byteLength !== frame.samplesPerChannel * width)
		throw new Error('This audio frame’s size doesn’t match its declared format.')
	const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
	const samples = new Float32Array(frame.samplesPerChannel)
	for (let index = 0; index < samples.length; index++)
		samples[index] =
			width === 2 ? view.getInt16(index * 2, true) / 32768 : view.getFloat32(index * 4, true)
	return samples
}

/** The latest `RING_SAMPLES` of the stream, addressed by absolute sample index. */
export class SampleRing {
	private chunks: { start: number; samples: Float32Array }[] = []
	private total = 0
	get length(): number {
		return this.total
	}
	push(samples: Float32Array): void {
		this.chunks.push({ start: this.total, samples })
		this.total += samples.length
		const floor = this.total - RING_SAMPLES
		while (this.chunks.length > 1) {
			const first = this.chunks[0]
			if (!first || first.start + first.samples.length > floor) break
			this.chunks.shift()
		}
	}
	/** Samples in [start, end), clamped to what is still remembered. */
	slice(start: number, end: number): Float32Array {
		const from = Math.max(0, Math.floor(start))
		const to = Math.min(this.total, Math.ceil(end))
		const out = new Float32Array(Math.max(0, to - from))
		for (const chunk of this.chunks) {
			const chunkEnd = chunk.start + chunk.samples.length
			if (chunkEnd <= from || chunk.start >= to) continue
			const lo = Math.max(from, chunk.start)
			const hi = Math.min(to, chunkEnd)
			out.set(chunk.samples.subarray(lo - chunk.start, hi - chunk.start), lo - from)
		}
		return out
	}
}

export interface SegmentSpan {
	startSample: number
	endSample: number
}
export type TimelineEvent =
	| { type: 'speech_start'; timestampMs: number }
	| { type: 'speech_end'; timestampMs: number; startMs: number; segment?: SegmentSpan }

/**
 * Turns voice-activity results into speech_start / speech_end on the source timeline. Both
 * adapters run one, so a recognizer's timestamp always lands inside the detector's interval.
 */
export class VadTimeline {
	private open = false
	private startMs = 0
	private lastEndMs = Number.NEGATIVE_INFINITY
	constructor(private baseMs: number) {}
	timeOf(sample: number): number {
		return this.baseMs + sample * MS_PER_SAMPLE
	}
	/** `fed` is how many samples the stream has been given so far. */
	consume(result: VadFeedResult, fed: number, ended = false): TimelineEvent[] {
		const events: TimelineEvent[] = []
		const now = this.timeOf(fed)
		const detected = result.detected && !ended
		for (const segment of result.segments) {
			const first = this.timeOf(segment.start)
			const last = this.timeOf(segment.start + segment.length)
			if (!this.open) {
				this.startMs = Math.max(first, this.lastEndMs)
				events.push({ type: 'speech_start', timestampMs: this.startMs })
			}
			const endMs = Math.max(last, this.startMs)
			events.push({
				type: 'speech_end',
				timestampMs: endMs,
				startMs: this.startMs,
				segment: { startSample: segment.start, endSample: segment.start + segment.length },
			})
			this.open = false
			this.lastEndMs = endMs
		}
		if (detected && !this.open) {
			this.open = true
			this.startMs = Math.max(now, this.lastEndMs)
			events.push({ type: 'speech_start', timestampMs: this.startMs })
		} else if (this.open && !detected) {
			// Speech too short for the model to keep closes without a segment, so nothing is transcribed.
			const endMs = Math.max(now, this.startMs)
			events.push({ type: 'speech_end', timestampMs: endMs, startMs: this.startMs })
			this.open = false
			this.lastEndMs = endMs
		}
		return events
	}
}

/** The recognizer input for one segment: roll before and after, then silence at the tail. */
export function utteranceSamples(ring: SampleRing, segment: SegmentSpan): Float32Array {
	const speech = ring.slice(
		segment.startSample - PRE_ROLL_SAMPLES,
		segment.endSample + POST_ROLL_SAMPLES,
	)
	const padded = new Float32Array(speech.length + TAIL_SILENCE_SAMPLES)
	padded.set(speech)
	return padded
}

/** A small unbounded-free async queue: one consumer, many producers, explicit close and fail. */
export class AsyncChannel<T> {
	private items: T[] = []
	private waiting?: () => void
	private closed = false
	private failure?: { error: unknown }
	push(item: T): void {
		if (this.closed) return
		this.items.push(item)
		this.wake()
	}
	close(): void {
		this.closed = true
		this.wake()
	}
	fail(error: unknown): void {
		this.failure ??= { error }
		this.closed = true
		this.wake()
	}
	private wake(): void {
		const wake = this.waiting
		this.waiting = undefined
		wake?.()
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		for (;;) {
			const item = this.items.shift()
			if (item !== undefined) {
				yield item
				continue
			}
			if (this.failure) throw this.failure.error
			if (this.closed) return
			await new Promise<void>((resolve) => {
				this.waiting = resolve
			})
		}
	}
}
