import {
	type PillNote,
	type PillView,
	RECORDING_LIMITS,
	RECORDING_WORDS,
	type RecordingResult,
	type RecordingReviewView,
	type RecordingStopReason,
	type RecordingVoice,
	formatClock,
} from '../../shared/recording-protocol.js'
import {
	type AssemblerNote,
	type FrameSource,
	RecordingAssembler,
	type WatchedEvent,
} from './assembler.js'
import type { ContentProtection } from './protection.js'
import { ReviewDraft } from './review.js'

/**
 * One recording from Start to Send or Discard, as a state machine over injected parts: the clock,
 * the timers, the picture source, the accessibility event source, the pill, the narration and the
 * content protection. Nothing here is Electron or the real clock, so every transition and every
 * limit can be exercised with a fake clock that a test moves by hand.
 */

export type SessionState = 'idle' | 'running' | 'paused' | 'away' | 'processing' | 'review'

export interface Scheduler {
	/** Calls `fn` every `ms` until the returned function is called. */
	every(ms: number, fn: () => void): () => void
	/** Calls `fn` once after `ms`, unless cancelled. */
	after(ms: number, fn: () => void): () => void
}

export interface WatchSource {
	/** False when nothing could be subscribed: pictures and the cursor only. */
	start(): Promise<{ controls: boolean }>
	poll(): Promise<{ events: readonly WatchedEvent[]; dropped: number }>
	stop(): Promise<void>
}

export interface PillOutput {
	show(view: PillView): void
	hide(): void
}

export interface NarrationHandle {
	start(): void
	push(samples: Float32Array): void
	stop(): Promise<void>
}

export interface SessionDeps {
	/** Monotonic milliseconds. */
	clock: () => number
	/** Wall time in epoch milliseconds, for "kept until 14:32". */
	wall: () => number
	scheduler: Scheduler
	frames: FrameSource
	watch?: WatchSource
	/** Where the pointer is, in pixels of the chosen display. */
	cursor: () => { x: number; y: number } | undefined
	protection: ContentProtection
	pill: PillOutput
	/** Opens narration; absent when listening is not installed. */
	narration?: (hooks: {
		say: (text: string, startMs: number) => void
		disconnected: () => void
	}) => NarrationHandle
	display: { w: number; h: number; shownW: number; shownH: number }
	nextId: () => string
	/** The review sheet's thumbnail for a picture. */
	thumb: (jpeg: Uint8Array) => string
	/** Local counts only; never content. */
	count?: (what: 'started' | 'finished' | 'discarded') => void
	onState?: (state: SessionState) => void
	onReview?: (view: RecordingReviewView) => void
	onReviewClosed?: (reason: 'sent' | 'discarded' | 'expired') => void
	onMessage?: (text: string) => void
}

const TICK_MS = 100
const CURSOR_MS = 1000 / RECORDING_LIMITS.cursorHz
const PILL_MS = 1000
const NOTE_MS = 6_000
const CONTROLS_CHECK_MS = 3_000
const LEVEL_PAINT_MS = 150

const hhmm = (epoch: number): string => {
	const date = new Date(epoch)
	return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`
}

export class RecordingSession {
	private current: SessionState = 'idle'
	private assembler: RecordingAssembler | undefined
	private narration: NarrationHandle | undefined
	private narrationOn = false
	private voice: RecordingVoice = 'off'
	private stops: (() => void)[] = []
	private ticking = false
	private polling = false
	private note: PillNote | undefined
	private noteTimer: (() => void) | undefined
	private awayUntil = 0
	private awayTimer: (() => void) | undefined
	private reviewTimer: (() => void) | undefined
	private draft: ReviewDraft | undefined
	private controls = false
	private startedWall = 0
	private holdProtection = false
	private level = 0
	private levelPaintedAt = Number.NEGATIVE_INFINITY

	constructor(private readonly deps: SessionDeps) {}

	get state(): SessionState {
		return this.current
	}

	get busy(): boolean {
		return this.current !== 'idle' && this.current !== 'review'
	}

	get review(): ReviewDraft | undefined {
		return this.draft
	}

	private setState(next: SessionState): void {
		if (this.current === next) return
		this.current = next
		this.deps.onState?.(next)
	}

	/** Begins recording. `voice` asks for narration; it quietly stays off when it cannot run. */
	async start(options: { voice: boolean }): Promise<void> {
		if (this.busy) throw new Error(RECORDING_WORDS.alreadyRunning)
		// A recording left for review is replaced by the new one.
		if (this.draft) this.closeReview('discarded')
		try {
			this.deps.protection.engage()
		} catch (error) {
			// A window that cannot be hidden from the pictures is a reason not to record at all.
			this.deps.protection.release()
			throw error
		}
		this.holdProtection = true
		const deps = this.deps
		this.voice = 'off'
		if (options.voice && deps.narration) {
			this.narration = deps.narration({
				say: (text, startMs) => this.assembler?.say(text, startMs),
				disconnected: () => this.showNote('narration-disconnected'),
			})
			this.narrationOn = true
			this.voice = 'on'
		} else if (options.voice) {
			this.voice = 'unavailable'
		}
		this.assembler = new RecordingAssembler({
			clock: deps.clock,
			frames: deps.frames,
			display: deps.display,
			voice: this.voice,
			id: deps.nextId(),
			note: (note) => this.onAssemblerNote(note),
		})
		this.startedWall = deps.wall()
		try {
			const started = deps.watch ? await deps.watch.start() : { controls: false }
			this.controls = started.controls
		} catch {
			this.controls = false
		}
		await this.assembler.start()
		this.narration?.start()
		this.setState('running')
		deps.count?.('started')
		this.paintPill()
		const schedule = deps.scheduler
		this.stops = [
			schedule.every(TICK_MS, () => void this.tick()),
			schedule.every(CURSOR_MS, () => this.sampleCursor()),
			schedule.every(PILL_MS, () => this.paintPill()),
			schedule.after(CONTROLS_CHECK_MS, () => {
				if (!this.controls) this.assembler?.noteControls()
			}),
		]
	}

	private sampleCursor(): void {
		if (this.current !== 'running') return
		const point = this.deps.cursor()
		if (point) this.assembler?.cursor(point)
	}

	private async tick(): Promise<void> {
		if (this.ticking || this.current !== 'running' || !this.assembler) return
		this.ticking = true
		try {
			if (this.deps.watch && this.controls && !this.polling) {
				this.polling = true
				try {
					const polled = await this.deps.watch.poll()
					this.assembler.hear(polled.events, polled.dropped)
				} catch {
					// A poll that fails is a poll that found nothing; the next one tries again.
				} finally {
					this.polling = false
				}
			}
			if (this.current !== 'running') return
			await this.assembler.tick()
			if (this.current === 'running' && this.assembler.limitReached()) {
				this.deps.onMessage?.(RECORDING_WORDS.limitReached)
				await this.done('limit')
			}
		} finally {
			this.ticking = false
		}
	}

	private onAssemblerNote(note: AssemblerNote): void {
		this.showNote(note === 'secure-field' ? 'secure-field' : note)
	}

	private showNote(note: PillNote): void {
		this.note = note
		this.noteTimer?.()
		this.noteTimer = this.deps.scheduler.after(NOTE_MS, () => {
			this.note = undefined
			this.paintPill()
		})
		this.paintPill()
	}

	private paintPill(): void {
		const assembler = this.assembler
		if (!assembler) return
		const elapsedMs = assembler.elapsed()
		const note = this.note
		const attach = (view: PillView): PillView => (note ? { ...view, note } : view)
		switch (this.current) {
			case 'running':
				this.deps.pill.show(
					attach({
						state: {
							kind: 'recording',
							elapsedMs,
							...(elapsedMs >= RECORDING_LIMITS.countdownFromMs
								? { leftMs: Math.max(0, RECORDING_LIMITS.maxDurationMs - elapsedMs) }
								: {}),
							voice: this.voice === 'on',
							...(this.voice === 'on' ? { level: this.level } : {}),
						},
					}),
				)
				return
			case 'paused':
				this.deps.pill.show(attach({ state: { kind: 'paused', elapsedMs } }))
				return
			case 'away':
				this.deps.pill.show({
					state: { kind: 'away', elapsedMs, keptUntil: hhmm(this.awayUntil) },
				})
				return
			case 'processing':
				this.deps.pill.show({ state: { kind: 'processing' } })
				return
			default:
				return
		}
	}

	pause(): void {
		if (this.current !== 'running') return
		this.assembler?.pause('user')
		this.setState('paused')
		this.paintPill()
	}

	resume(): void {
		if (this.current !== 'paused' && this.current !== 'away') return
		this.awayTimer?.()
		this.awayTimer = undefined
		this.assembler?.resume()
		this.setState('running')
		this.paintPill()
	}

	/**
	 * The computer was locked, went to sleep, or the user was switched: capture stops and the
	 * recording is kept for an hour, so coming back lets the person go on or finish it.
	 */
	away(reason: 'lock' | 'sleep'): void {
		if (this.current !== 'running' && this.current !== 'paused') return
		if (this.current === 'running') this.assembler?.pause(reason)
		this.awayUntil = this.deps.wall() + RECORDING_LIMITS.awayKeepMs
		this.setState('away')
		this.awayTimer = this.deps.scheduler.after(RECORDING_LIMITS.awayKeepMs, () => {
			void this.discard('expired')
		})
		this.paintPill()
	}

	/** Narration audio from the window; ignored while paused, away or not recording. */
	audio(samples: Float32Array): void {
		if (this.current !== 'running' || !this.narrationOn) return
		this.narration?.push(samples)
		let sum = 0
		for (const sample of samples) sum += sample * sample
		const rms = Math.sqrt(sum / Math.max(1, samples.length))
		this.level = Math.min(1, rms * 6)
		const now = this.deps.clock()
		if (now - this.levelPaintedAt >= LEVEL_PAINT_MS) {
			this.levelPaintedAt = now
			this.paintPill()
		}
	}

	/** The person clicked "Narration disconnected": open narration again, and say so if it cannot. */
	reconnectNarration(): void {
		if (this.current !== 'running' && this.current !== 'paused') return
		if (!this.deps.narration) return
		void this.narration?.stop()
		this.narration = this.deps.narration({
			say: (text, startMs) => this.assembler?.say(text, startMs),
			disconnected: () => this.showNote('narration-disconnected'),
		})
		this.narrationOn = true
		this.narration.start()
		this.note = undefined
		this.paintPill()
	}

	/** Ends the recording and opens it for review. */
	async done(reason: RecordingStopReason = 'done'): Promise<void> {
		if (
			!this.assembler ||
			(this.current !== 'running' && this.current !== 'paused' && this.current !== 'away')
		)
			return
		this.awayTimer?.()
		this.awayTimer = undefined
		this.setState('processing')
		this.paintPill()
		this.stopTimers()
		let result: RecordingResult
		try {
			try {
				await this.deps.watch?.stop()
			} catch {
				// Subscriptions go down with the helper anyway.
			}
			await this.narration?.stop()
			result = await this.assembler.finish(reason)
		} finally {
			this.narration = undefined
			this.narrationOn = false
			this.releaseProtection()
			this.deps.pill.hide()
		}
		this.assembler = undefined
		this.draft = new ReviewDraft(result)
		this.setState('review')
		this.deps.count?.('finished')
		this.reviewTimer = this.deps.scheduler.after(RECORDING_LIMITS.reviewHoldMs, () => {
			this.closeReview('expired')
			this.deps.onMessage?.(RECORDING_WORDS.expired)
		})
		this.deps.onReview?.(this.reviewView())
	}

	reviewView(): RecordingReviewView {
		if (!this.draft) throw new Error(RECORDING_WORDS.expired)
		return this.draft.view((frame) => this.deps.thumb(frame.jpeg), RECORDING_LIMITS.reviewHoldMs)
	}

	/** Throws away a recording in progress or one awaiting review. */
	async discard(why: 'discarded' | 'expired' = 'discarded'): Promise<void> {
		if (this.current === 'review') {
			this.closeReview(why)
			return
		}
		if (!this.assembler) return
		this.awayTimer?.()
		this.awayTimer = undefined
		this.stopTimers()
		this.setState('processing')
		try {
			await this.deps.watch?.stop().catch(() => undefined)
			await this.narration?.stop()
		} finally {
			this.narration = undefined
			this.narrationOn = false
			this.assembler = undefined
			this.releaseProtection()
			if (why === 'expired') {
				this.deps.pill.show({ state: { kind: 'expired' } })
				this.deps.scheduler.after(NOTE_MS, () => this.deps.pill.hide())
			} else this.deps.pill.hide()
		}
		this.deps.count?.('discarded')
		this.setState('idle')
	}

	/** Review is over: sent, discarded or expired. */
	closeReview(reason: 'sent' | 'discarded' | 'expired'): void {
		this.reviewTimer?.()
		this.reviewTimer = undefined
		this.draft = undefined
		if (this.current === 'review') this.setState('idle')
		if (reason === 'discarded') this.deps.count?.('discarded')
		this.deps.onReviewClosed?.(reason)
	}

	private releaseProtection(): void {
		if (!this.holdProtection) return
		this.holdProtection = false
		this.deps.protection.release()
	}

	private stopTimers(): void {
		for (const stop of this.stops) stop()
		this.stops = []
		this.noteTimer?.()
		this.noteTimer = undefined
		this.note = undefined
	}

	/** Quitting with a recording running or waiting loses it, by design. */
	get holdsRecording(): boolean {
		return this.current !== 'idle'
	}

	/** For the pill's one-line text. */
	elapsedClock(): string {
		return formatClock(this.assembler?.elapsed() ?? 0)
	}

	get startedAtWall(): number {
		return this.startedWall
	}
}
