/**
 * The two sounds Namzu plays, synthesised in code.
 *
 * There is no audio asset to ship, license or keep in step with a package
 * file list: a sound is a short list of notes, and the WAV bytes are computed
 * from it. Each note is a soft bell — a fundamental with two quiet partials,
 * a few milliseconds of attack and an exponential fall — so it reads as a
 * chime rather than a beep, and two notes a fifth apart make the "done"
 * figure. The "request" figure is the same bell struck twice on one pitch,
 * which no one confuses with it.
 */

/** What a sound is for. */
export type SoundKind = 'done' | 'request'

interface Note {
	/** Pitch in hertz. */
	readonly hz: number
	/** Seconds from the start of the sound. */
	readonly at: number
	/** Seconds the note rings before it is inaudible. */
	readonly ring: number
	/** Linear level, 0..1, before the sound is normalised. */
	readonly level: number
}

const FIGURES: Readonly<Record<SoundKind, readonly Note[]>> = {
	// E5 then B5: a settled, rising fifth.
	done: [
		{ hz: 659.25, at: 0, ring: 0.42, level: 0.8 },
		{ hz: 987.77, at: 0.13, ring: 0.62, level: 1 },
	],
	// A5 struck twice.
	request: [
		{ hz: 880, at: 0, ring: 0.22, level: 0.9 },
		{ hz: 880, at: 0.17, ring: 0.34, level: 1 },
	],
}

const SAMPLE_RATE = 22_050
const ATTACK_SECONDS = 0.006
/** Leaves headroom: a notification must never be the loudest thing on the machine. */
const PEAK = 0.42
/** The partials above the fundamental, as (multiple, level). */
const PARTIALS: readonly (readonly [number, number])[] = [
	[1, 1],
	[2, 0.3],
	[3.01, 0.1],
]

/** Seconds of sound `kind` lasts, silence at the end included. */
export function chimeSeconds(kind: SoundKind): number {
	return Math.max(...FIGURES[kind].map((note) => note.at + note.ring)) + 0.05
}

/** The sound as a 16-bit mono PCM WAV file. Pure: the same bytes every time. */
export function chimeWav(kind: SoundKind): Buffer {
	const length = Math.ceil(chimeSeconds(kind) * SAMPLE_RATE)
	const samples = new Float64Array(length)
	for (const note of FIGURES[kind]) {
		const start = Math.round(note.at * SAMPLE_RATE)
		const count = Math.min(length - start, Math.round(note.ring * SAMPLE_RATE))
		// -60 dB by the end of the ring.
		const fall = Math.log(1000) / note.ring
		for (let i = 0; i < count; i++) {
			const t = i / SAMPLE_RATE
			const envelope = Math.min(1, t / ATTACK_SECONDS) * Math.exp(-fall * t)
			let value = 0
			for (const [multiple, level] of PARTIALS) {
				value += level * Math.sin(2 * Math.PI * note.hz * multiple * t)
			}
			samples[start + i] = (samples[start + i] ?? 0) + value * envelope * note.level
		}
	}

	let peak = 0
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
	const gain = peak > 0 ? PEAK / peak : 0

	const dataBytes = length * 2
	const wav = Buffer.alloc(44 + dataBytes)
	wav.write('RIFF', 0, 'ascii')
	wav.writeUInt32LE(36 + dataBytes, 4)
	wav.write('WAVE', 8, 'ascii')
	wav.write('fmt ', 12, 'ascii')
	wav.writeUInt32LE(16, 16)
	wav.writeUInt16LE(1, 20) // PCM
	wav.writeUInt16LE(1, 22) // mono
	wav.writeUInt32LE(SAMPLE_RATE, 24)
	wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
	wav.writeUInt16LE(2, 32)
	wav.writeUInt16LE(16, 34)
	wav.write('data', 36, 'ascii')
	wav.writeUInt32LE(dataBytes, 40)
	for (let i = 0; i < length; i++) {
		const sample = Math.max(-1, Math.min(1, (samples[i] ?? 0) * gain))
		wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2)
	}
	return wav
}
