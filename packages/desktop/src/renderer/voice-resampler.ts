import {
	VOICE_INPUT_CHUNK_SAMPLES,
	VOICE_INPUT_SAMPLE_RATE,
} from '../shared/voice-input-protocol.js'

/** Lobes of the interpolation kernel on each side: more means a steeper low-pass. */
const LOBES = 14
const PHASES = 512
/** The low-pass edge, as a share of the output's Nyquist frequency (8 kHz). */
const CUTOFF = 0.9

function bessel0(x: number): number {
	let sum = 1
	let term = 1
	for (let k = 1; k < 40; k++) {
		term *= (x / (2 * k)) ** 2
		sum += term
		if (term < 1e-12 * sum) break
	}
	return sum
}

/**
 * Converts a stream of mono samples to 16 kHz with a windowed-sinc low-pass, so tones above the
 * new Nyquist frequency are removed instead of folding back into the speech band. The stream
 * keeps its place between calls; feed it blocks of any size.
 */
export class Resampler {
	private readonly step: number
	private readonly half: number
	private readonly kernel: Float32Array[]
	private buffer: Float32Array
	/** Position of the next output sample, in input samples from the start of `buffer`. */
	private position: number
	constructor(
		private readonly inputRate: number,
		readonly outputRate = VOICE_INPUT_SAMPLE_RATE,
	) {
		if (!Number.isFinite(inputRate) || inputRate < outputRate)
			throw new Error('The microphone’s sample rate is too low for voice input.')
		this.step = inputRate / outputRate
		// The kernel is a sinc whose first zero sits one cutoff period out, measured in input samples.
		const scale = Math.min(1, CUTOFF / this.step)
		this.half = Math.ceil(LOBES / scale)
		const beta = 8.6
		const norm = bessel0(beta)
		this.kernel = Array.from({ length: PHASES }, (_, phase) => {
			const fraction = phase / PHASES
			const taps = new Float32Array(2 * this.half)
			let total = 0
			for (let tap = 0; tap < taps.length; tap++) {
				// Input sample (floor(position) - half + 1 + tap) sits this far from the output instant.
				const distance = tap - this.half + 1 - fraction
				const x = distance * scale
				const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
				const ratio = distance / this.half
				const window =
					Math.abs(ratio) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - ratio * ratio)) / norm
				const value = sinc * window * scale
				taps[tap] = value
				total += value
			}
			// Unity gain at 0 Hz for every phase.
			for (let tap = 0; tap < taps.length; tap++) taps[tap] = (taps[tap] as number) / total
			return taps
		})
		this.buffer = new Float32Array(this.half)
		this.position = this.half
	}

	process(input: Float32Array): Float32Array {
		const merged = new Float32Array(this.buffer.length + input.length)
		merged.set(this.buffer)
		merged.set(input, this.buffer.length)
		this.buffer = merged
		const out: number[] = []
		while (Math.floor(this.position) + this.half < this.buffer.length) {
			const base = Math.floor(this.position)
			const phase = Math.min(PHASES - 1, Math.round((this.position - base) * PHASES))
			const taps = this.kernel[phase] as Float32Array
			const start = base - this.half + 1
			let sum = 0
			for (let tap = 0; tap < taps.length; tap++)
				sum += (this.buffer[start + tap] as number) * (taps[tap] as number)
			out.push(sum)
			this.position += this.step
		}
		const keep = Math.max(0, Math.floor(this.position) - this.half)
		if (keep > 0) {
			this.buffer = this.buffer.slice(keep)
			this.position -= keep
		}
		return Float32Array.from(out)
	}
}

/** Regroups a stream into equal pieces (about 100 ms); a remainder waits for the next call. */
export class Chunker {
	private held = new Float32Array(0)
	constructor(private readonly size = VOICE_INPUT_CHUNK_SAMPLES) {}
	push(samples: Float32Array): Float32Array[] {
		const merged = new Float32Array(this.held.length + samples.length)
		merged.set(this.held)
		merged.set(samples, this.held.length)
		const pieces: Float32Array[] = []
		let at = 0
		for (; at + this.size <= merged.length; at += this.size)
			pieces.push(merged.slice(at, at + this.size))
		this.held = merged.slice(at)
		return pieces
	}
}

/** Keeps every sample inside what the speech models and the window's limits accept. */
export function clampSamples(samples: Float32Array): Float32Array {
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index] as number
		samples[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
	}
	return samples
}
