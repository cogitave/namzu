import { expect, it } from 'vitest'
import {
	RING_SAMPLES,
	SampleRing,
	TAIL_SILENCE_SAMPLES,
	VadTimeline,
	listeningFrameSamples,
	utteranceSamples,
} from './local-listening-stream.js'

it('keeps only the latest window of audio and slices by absolute index', () => {
	const ring = new SampleRing()
	const block = new Float32Array(RING_SAMPLES / 3).map((_, index) => index)
	for (let count = 0; count < 5; count++) ring.push(block)
	expect(ring.length).toBe(5 * block.length)
	expect(Array.from(ring.slice(4 * block.length + 2, 4 * block.length + 5))).toEqual([2, 3, 4])
	// The oldest audio is gone; asking for it yields what remains rather than failing.
	expect(ring.slice(0, 10).length).toBeLessThanOrEqual(10)
	expect(ring.slice(100, 50).length).toBe(0)
})

it('clamps the roll at the start of the stream and always appends the silent tail', () => {
	const ring = new SampleRing()
	ring.push(new Float32Array(3_000).fill(0.5))
	const input = utteranceSamples(ring, { startSample: 1_000, endSample: 2_000 })
	// No 400 ms of earlier audio exists; the post-roll is what was heard after the segment.
	expect(input.length).toBe(3_000 + TAIL_SILENCE_SAMPLES)
	expect(input[2_999]).toBe(0.5)
	expect(input.subarray(3_000).every((sample) => sample === 0)).toBe(true)
})

it('converts signed 16-bit and float frames and rejects the rest in plain words', () => {
	const s16 = new Uint8Array(4)
	new DataView(s16.buffer).setInt16(0, 16_384, true)
	new DataView(s16.buffer).setInt16(2, -32_768, true)
	const base = { channels: 1, sampleRateHz: 16_000, samplesPerChannel: 2 }
	expect(Array.from(listeningFrameSamples({ ...base, data: s16, format: 'pcm_s16le' }))).toEqual([
		0.5, -1,
	])
	expect(() =>
		listeningFrameSamples({ ...base, data: s16, format: 'pcm_s16le', sampleRateHz: 44_100 }),
	).toThrow(/16 kHz mono/)
	expect(() => listeningFrameSamples({ ...base, data: s16, format: 'pcm_f32le' })).toThrow(
		/doesn’t match/,
	)
	expect(() =>
		listeningFrameSamples({ ...base, data: s16, format: 'opus' as unknown as 'pcm_s16le' }),
	).toThrow(/can’t read/)
})

it('closes a blip the model discarded, and never ends before it started', () => {
	const timeline = new VadTimeline(1_000)
	expect(timeline.consume({ detected: true, segments: [] }, 1_600)).toEqual([
		{ type: 'speech_start', timestampMs: 1_100 },
	])
	expect(timeline.consume({ detected: false, segments: [] }, 3_200)).toEqual([
		{ type: 'speech_end', timestampMs: 1_200, startMs: 1_100 },
	])
	// A segment that began before its detection time still ends no earlier than it started.
	const next = timeline.consume(
		{ detected: false, segments: [{ start: 3_200, length: 160 }] },
		4_000,
	)
	expect(next).toHaveLength(2)
	expect(next[1]).toMatchObject({ type: 'speech_end' })
	expect((next[1]?.timestampMs ?? 0) >= (next[0]?.timestampMs ?? 0)).toBe(true)
})

it('opens the next speech in the same result that closed the last', () => {
	const timeline = new VadTimeline(0)
	const events = timeline.consume(
		{ detected: true, segments: [{ start: 0, length: 1_600 }] },
		3_200,
	)
	expect(events.map((event) => event.type)).toEqual(['speech_start', 'speech_end', 'speech_start'])
	expect(events[2]?.timestampMs).toBe(200)
})
