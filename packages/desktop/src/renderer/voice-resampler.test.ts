import { describe, expect, it } from 'vitest'
import { Chunker, Resampler, clampSamples } from './voice-resampler.js'

function sine(frequency: number, rate: number, seconds: number, amplitude = 0.8): Float32Array {
	const out = new Float32Array(Math.round(rate * seconds))
	for (let index = 0; index < out.length; index++)
		out[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / rate)
	return out
}
/** Resamples in blocks the size the microphone really delivers. */
function resample(input: Float32Array, rate: number, block = 960): Float32Array {
	const resampler = new Resampler(rate)
	const pieces: Float32Array[] = []
	for (let at = 0; at < input.length; at += block)
		pieces.push(resampler.process(input.subarray(at, Math.min(input.length, at + block))))
	const out = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0))
	let at = 0
	for (const piece of pieces) {
		out.set(piece, at)
		at += piece.length
	}
	return out
}
/** The tone's amplitude at one frequency (a single-bin DFT), ignoring the filter's settling at the edges. */
function amplitudeAt(samples: Float32Array, frequency: number, rate: number): number {
	const body = samples.subarray(200, samples.length - 200)
	let re = 0
	let im = 0
	for (let index = 0; index < body.length; index++) {
		const phase = (2 * Math.PI * frequency * index) / rate
		re += (body[index] as number) * Math.cos(phase)
		im -= (body[index] as number) * Math.sin(phase)
	}
	return (2 * Math.hypot(re, im)) / body.length
}
function peak(samples: Float32Array): number {
	let max = 0
	for (let index = 200; index < samples.length - 200; index++)
		max = Math.max(max, Math.abs(samples[index] as number))
	return max
}

describe('Resampler', () => {
	it.each([48_000, 44_100, 32_000, 24_000])(
		'keeps a 1 kHz tone at 1 kHz and full level from %i Hz',
		(rate) => {
			const out = resample(sine(1000, rate, 1), rate)
			// The filter's delay holds back its last few milliseconds until more audio arrives.
			expect(out.length).toBeGreaterThan(16_000 - 20)
			expect(out.length).toBeLessThanOrEqual(16_001)
			expect(amplitudeAt(out, 1000, 16_000)).toBeGreaterThan(0.78)
			expect(amplitudeAt(out, 1000, 16_000)).toBeLessThan(0.82)
			// Nothing else is in the signal.
			for (const other of [500, 2000, 3000, 5000, 7000])
				expect(amplitudeAt(out, other, 16_000)).toBeLessThan(0.01)
		},
	)

	it('keeps the frequency of a 3.3 kHz tone, so the speech band is not shifted', () => {
		const out = resample(sine(3300, 48_000, 1), 48_000)
		expect(amplitudeAt(out, 3300, 16_000)).toBeGreaterThan(0.78)
		expect(amplitudeAt(out, 3350, 16_000)).toBeLessThan(0.3)
	})

	it('removes a tone above 8 kHz instead of folding it into the speech band', () => {
		// 10 kHz would land on 6 kHz, 12 kHz on 4 kHz, and 15 kHz on 1 kHz if samples were just dropped.
		for (const [tone, alias] of [
			[10_000, 6000],
			[12_000, 4000],
			[15_000, 1000],
		] as const) {
			const out = resample(sine(tone, 48_000, 1, 1), 48_000)
			expect(peak(out)).toBeLessThan(0.01)
			expect(amplitudeAt(out, alias, 16_000)).toBeLessThan(0.01)
		}
	})

	it('removes folded tones at a fractional ratio too', () => {
		const out = resample(sine(11_000, 44_100, 1, 1), 44_100)
		expect(peak(out)).toBeLessThan(0.01)
	})

	it('gives the same answer however the input is cut into blocks', () => {
		const input = sine(1500, 48_000, 0.5)
		const whole = resample(input, 48_000, input.length)
		const small = resample(input, 48_000, 128)
		expect(small.length).toBe(whole.length)
		for (let index = 0; index < whole.length; index++)
			expect(small[index]).toBeCloseTo(whole[index] as number, 5)
	})

	it('passes silence and DC through unchanged in level', () => {
		expect(peak(resample(new Float32Array(48_000), 48_000))).toBe(0)
		const flat = resample(new Float32Array(48_000).fill(0.5), 48_000)
		expect(flat[8000]).toBeCloseTo(0.5, 3)
	})

	it('refuses a microphone that cannot carry the speech band', () => {
		expect(() => new Resampler(8000)).toThrow('too low')
		expect(() => new Resampler(Number.NaN)).toThrow()
	})
})

describe('Chunker', () => {
	it('regroups into equal pieces and carries the rest', () => {
		const chunker = new Chunker(1600)
		expect(chunker.push(new Float32Array(1000))).toHaveLength(0)
		const pieces = chunker.push(new Float32Array(2300))
		expect(pieces.map((piece) => piece.length)).toEqual([1600, 1600])
		expect(chunker.push(new Float32Array(1500))).toHaveLength(1)
	})
	it('keeps every sample in order', () => {
		const chunker = new Chunker(4)
		const out = [
			...chunker.push(Float32Array.of(1, 2, 3)),
			...chunker.push(Float32Array.of(4, 5, 6, 7, 8, 9)),
		]
		expect(out.map((piece) => Array.from(piece))).toEqual([
			[1, 2, 3, 4],
			[5, 6, 7, 8],
		])
	})
})

describe('clampSamples', () => {
	it('keeps samples in range and replaces non-numbers with silence', () => {
		expect(
			Array.from(clampSamples(Float32Array.of(0.5, 1.7, -3, Number.NaN, Number.POSITIVE_INFINITY))),
		).toEqual([0.5, 1, -1, 0, 0])
	})
})
