import { describe, expect, it } from 'vitest'
import {
	VOICE_INPUT_MAX_CHUNK_SAMPLES,
	VoiceChunkRateLimit,
	readVoiceChunk,
} from './voice-input-protocol.js'

describe('readVoiceChunk', () => {
	it('returns a copy main owns', () => {
		const source = Float32Array.of(0.25, -0.5, 1)
		const copy = readVoiceChunk(source)
		expect(Array.from(copy)).toEqual([0.25, -0.5, 1])
		source[0] = 0.9
		expect(copy[0]).toBe(0.25)
		expect(copy.buffer).not.toBe(source.buffer)
	})
	it('accepts the longest allowed chunk and nothing longer', () => {
		expect(readVoiceChunk(new Float32Array(VOICE_INPUT_MAX_CHUNK_SAMPLES)).length).toBe(
			VOICE_INPUT_MAX_CHUNK_SAMPLES,
		)
		expect(() => readVoiceChunk(new Float32Array(VOICE_INPUT_MAX_CHUNK_SAMPLES + 1))).toThrow()
	})
	it.each([
		['a plain array', [0.1]],
		['a typed array of another kind', new Float64Array(4)],
		['a buffer', new ArrayBuffer(16)],
		['a string', 'audio'],
		['null', null],
		['empty', new Float32Array(0)],
		['NaN', Float32Array.of(Number.NaN)],
		['Infinity', Float32Array.of(Number.POSITIVE_INFINITY)],
		['far out of range', Float32Array.of(5)],
	])('refuses %s', (_name, value) => {
		expect(() => readVoiceChunk(value)).toThrow(/Invalid voice input audio/)
	})
})

describe('VoiceChunkRateLimit', () => {
	it('allows real-time audio and a short burst, then refuses', () => {
		let now = 0
		const limit = new VoiceChunkRateLimit(() => now)
		// Two seconds of budget: twenty 100 ms chunks at once.
		for (let index = 0; index < 20; index++) expect(limit.take(1600)).toBe(true)
		expect(limit.take(1600)).toBe(false)
		// 100 ms later the budget has regained 150 ms of audio.
		now += 100
		expect(limit.take(1600)).toBe(true)
		expect(limit.take(1600)).toBe(false)
	})
	it('keeps up with audio sent at exactly real time for as long as it likes', () => {
		let now = 0
		const limit = new VoiceChunkRateLimit(() => now)
		for (let index = 0; index < 10_000; index++) {
			expect(limit.take(1600)).toBe(true)
			now += 100
		}
	})
	it('never banks more than its capacity while idle', () => {
		let now = 0
		const limit = new VoiceChunkRateLimit(() => now)
		now += 3_600_000
		let taken = 0
		while (limit.take(1600)) taken++
		expect(taken).toBe(20)
	})
})
