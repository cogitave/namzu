/**
 * Spoken input between the window and Desktop's main process. Audio is captured in the window,
 * checked and turned into text in main, and never leaves the computer.
 */
export const VOICE_INPUT_SAMPLE_RATE = 16_000
/** The window sends about 100 ms at a time; main accepts up to half a second in one piece. */
export const VOICE_INPUT_CHUNK_SAMPLES = 1_600
export const VOICE_INPUT_MAX_CHUNK_SAMPLES = 8_000
/** Barge-in: speech must last this long while a reply is being read before the reading stops. */
export const VOICE_BARGE_IN_MS = 300

/** What the person sees: off is the absence of a session. */
export type VoiceInputPhase = 'listening' | 'hearing' | 'transcribing'
export type VoiceInputEndReason =
	| 'stopped'
	| 'conversation'
	| 'window'
	| 'quit'
	| 'sleep'
	| 'uninstalled'
	| 'error'

export type VoiceInputEvent =
	| { type: 'phase'; sessionId: string; phase: VoiceInputPhase }
	/** A spoken message went out the way a typed one does; its reply may be read aloud. */
	| { type: 'sent'; sessionId: string }
	/** A question is waiting on screen, so what was said was not sent. */
	| { type: 'held'; sessionId: string; text: string }
	/** A stop word ended the running reply. */
	| { type: 'reply-stopped'; sessionId: string }
	| { type: 'not-sent'; sessionId: string; text: string }
	| { type: 'ended'; sessionId: string; reason: VoiceInputEndReason }

/** Checks one chunk of audio from a window. Returns a copy that main owns. */
export function readVoiceChunk(value: unknown): Float32Array {
	if (!(value instanceof Float32Array)) throw new Error('Invalid voice input audio.')
	if (value.length === 0 || value.length > VOICE_INPUT_MAX_CHUNK_SAMPLES)
		throw new Error('Invalid voice input audio length.')
	for (let index = 0; index < value.length; index++) {
		const sample = value[index] as number
		if (!Number.isFinite(sample) || Math.abs(sample) > 2)
			throw new Error('Invalid voice input audio.')
	}
	return new Float32Array(value)
}

/**
 * Audio may arrive a little faster than it plays (a short burst after a stall) but never much more:
 * a budget of seconds of audio refills at 1.5 times real time and holds at most two seconds.
 */
export class VoiceChunkRateLimit {
	private budget: number
	private last: number
	constructor(
		private readonly now: () => number = Date.now,
		private readonly capacitySeconds = 2,
		private readonly refillPerSecond = 1.5,
	) {
		this.budget = capacitySeconds
		this.last = now()
	}
	take(samples: number): boolean {
		const at = this.now()
		this.budget = Math.min(
			this.capacitySeconds,
			this.budget + Math.max(0, at - this.last) * (this.refillPerSecond / 1000),
		)
		this.last = at
		const cost = samples / VOICE_INPUT_SAMPLE_RATE
		// A hair of tolerance: 0.1 s is not exact in floating point, so twenty of them must still fit in two.
		if (this.budget + 1e-9 < cost) return false
		this.budget -= cost
		return true
	}
}
