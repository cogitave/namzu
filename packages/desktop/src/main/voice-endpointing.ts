/**
 * Deciding when a spoken message is finished, and whether it is a command rather than a message.
 * Pure rules plus one small timer-driven class; nothing here touches audio or the window.
 */
export const DEFAULT_ENDPOINT_MS = 800
/** Longer when the sentence ends on a word that usually continues it. */
export const DEFAULT_CONNECTIVE_ENDPOINT_MS = 1600
/** A speech segment the recognizer never answers (too short, or blank) stops blocking after this. */
export const DEFAULT_TRANSCRIPT_GRACE_MS = 1000
/** A spoken message is committed at once past this length, so it can never outgrow a message. */
export const MAX_SPOKEN_MESSAGE_CHARS = 8_000

/**
 * Letters compared without case, accents or punctuation: the recognizer may write "İptal.",
 * "IPTAL" or "iptal" for the same word. Turkish lowercasing first, so "I" and "İ" differ correctly.
 */
export function foldSpoken(text: string): string {
	return text
		.toLocaleLowerCase('tr')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/ı/g, 'i')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

const STOP_WORDS = new Set(['dur', 'durdur', 'iptal', 'vazgec', 'stop'])
const CONNECTIVES = [
	've',
	'ama',
	'fakat',
	'sonra',
	'ile',
	'veya',
	'ya da',
	'cunku',
	'ki',
	'da',
	'de',
]

export const SPOKEN_STOP_WORDS: readonly string[] = ['dur', 'durdur', 'iptal', 'vazgeç', 'stop']
export const SPOKEN_CONNECTIVES: readonly string[] = [
	've',
	'ama',
	'fakat',
	'sonra',
	'ile',
	'veya',
	'ya da',
	'çünkü',
	'ki',
	'da',
	'de',
]

/**
 * Lines the recognizer is known to invent from noise or silence: subtitle credits and video
 * sign-offs that fill its training data. Compared folded, so "Altyazı M.K." matches "altyazi m k".
 */
const INVENTED_PHRASES = [
	'altyazi m k',
	'abone olmayi unutmayin',
	'izlediginiz icin tesekkurler',
	'izlediginiz icin tesekkur ederim',
]

/** A transcript that is one of those invented lines, never something the person said to Namzu. */
export function isInventedTranscript(text: string): boolean {
	const folded = foldSpoken(text)
	return folded.length > 0 && INVENTED_PHRASES.some((phrase) => folded.includes(phrase))
}

/** Only stop words, nothing else: "Dur.", "iptal", "Stop, stop!". */
export function isStopCommand(text: string): boolean {
	const words = foldSpoken(text).split(' ').filter(Boolean)
	return words.length > 0 && words.every((word) => STOP_WORDS.has(word))
}

export function endsWithConnective(text: string): boolean {
	const folded = foldSpoken(text)
	if (!folded) return false
	return CONNECTIVES.some((word) => folded === word || folded.endsWith(` ${word}`))
}

export interface EndpointOptions {
	endpointMs?: number
	connectiveEndpointMs?: number
	transcriptGraceMs?: number
	now?: () => number
}

export function endpointDelayMs(text: string, options: EndpointOptions = {}): number {
	return endsWithConnective(text)
		? (options.connectiveEndpointMs ?? DEFAULT_CONNECTIVE_ENDPOINT_MS)
		: (options.endpointMs ?? DEFAULT_ENDPOINT_MS)
}

interface Interval {
	startMs: number
	endMs: number
	deadline: number
}

/**
 * Collects the transcripts of consecutive speech segments and reports the whole utterance once
 * the person has stopped: after the last segment ends, no new one starts within the delay, and
 * no transcript is still being worked out.
 */
export class UtteranceEndpointer {
	private segments: string[] = []
	private intervals: Interval[] = []
	/** Transcripts that arrived before the end of the speech they belong to. */
	private early: number[] = []
	private speaking = false
	private recognizing = false
	private lastEnd = Number.NEGATIVE_INFINITY
	private timer: ReturnType<typeof setTimeout> | undefined
	private disposed = false
	private readonly now: () => number
	constructor(
		private readonly options: EndpointOptions & {
			onUtterance(text: string): void
			/** Called when `busy` may have changed. */
			onChange?(): void
		},
	) {
		this.now = options.now ?? Date.now
	}

	/** Speech was heard, or a transcript is on its way, and no message is complete yet. */
	get busy(): boolean {
		return this.recognizing || this.intervals.length > 0
	}
	get hearing(): boolean {
		return this.speaking
	}

	speechStart(): void {
		if (this.disposed) return
		this.speaking = true
		this.cancelTimer()
		this.options.onChange?.()
	}
	/** `startMs` and `endMs` are on the audio timeline; a transcript names a time inside them. */
	speechEnd(startMs: number, endMs: number): void {
		if (this.disposed) return
		this.speaking = false
		this.lastEnd = this.now()
		const answered = this.early.findIndex((at) => at >= startMs - 1 && at <= endMs + 1)
		if (answered >= 0) {
			this.early.splice(answered, 1)
			this.options.onChange?.()
			this.check()
			return
		}
		this.intervals.push({
			startMs,
			endMs,
			deadline: this.lastEnd + (this.options.transcriptGraceMs ?? DEFAULT_TRANSCRIPT_GRACE_MS),
		})
		this.options.onChange?.()
		this.check()
	}
	transcript(text: string, timestampMs: number): void {
		if (this.disposed) return
		const clean = text.trim()
		const at = this.intervals.findIndex(
			(item) => timestampMs >= item.startMs - 1 && timestampMs <= item.endMs + 1,
		)
		if (at >= 0) this.intervals.splice(at, 1)
		else this.early = [...this.early, timestampMs].slice(-8)
		if (clean) this.segments.push(clean)
		this.options.onChange?.()
		if (this.segments.join(' ').length >= MAX_SPOKEN_MESSAGE_CHARS && !this.speaking) {
			this.complete()
			return
		}
		this.check()
	}
	/** The recognizer is working (or not); a complete message waits for it to finish. */
	recognition(active: boolean): void {
		if (this.disposed || this.recognizing === active) return
		this.recognizing = active
		if (!active) {
			// The answer to the recognition that just ended, and the start of the next queued one,
			// are a few steps away: segments still waiting get a fresh grace period from here.
			const until = this.now() + (this.options.transcriptGraceMs ?? DEFAULT_TRANSCRIPT_GRACE_MS)
			for (const item of this.intervals) item.deadline = Math.max(item.deadline, until)
		}
		this.options.onChange?.()
		if (!active) this.check()
	}
	dispose(): void {
		this.disposed = true
		this.cancelTimer()
		this.segments = []
		this.intervals = []
		this.early = []
	}

	private cancelTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
	}
	private schedule(inMs: number): void {
		this.cancelTimer()
		this.timer = setTimeout(
			() => {
				this.timer = undefined
				this.check()
			},
			Math.max(0, Math.ceil(inMs)),
		)
	}
	private check(): void {
		if (this.disposed || this.speaking) return
		const at = this.now()
		if (this.recognizing) {
			this.cancelTimer()
			return
		}
		const before = this.intervals.length
		const waiting = this.intervals.filter((item) => at < item.deadline)
		if (waiting.length !== before) {
			this.intervals = waiting
			this.options.onChange?.()
		}
		if (waiting.length > 0) {
			this.schedule(Math.min(...waiting.map((item) => item.deadline)) - at)
			return
		}
		if (this.segments.length === 0) return
		const text = this.segments.join(' ')
		const due = this.lastEnd + endpointDelayMs(text, this.options)
		if (at < due) {
			this.schedule(due - at)
			return
		}
		this.complete()
	}
	private complete(): void {
		const text = this.segments.join(' ')
		this.segments = []
		this.cancelTimer()
		this.options.onChange?.()
		if (text.trim()) this.options.onUtterance(text)
	}
}
