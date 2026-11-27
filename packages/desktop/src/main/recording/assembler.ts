import {
	EMPTY_CUT,
	RECORDING_LIMITS,
	type RecordingCut,
	type RecordingEvent,
	type RecordingFrameData,
	type RecordingPauseReason,
	type RecordingResult,
	type RecordingStopReason,
	type RecordingVoice,
} from '../../shared/recording-protocol.js'
import { scrub } from './scrubber.js'

/**
 * Turns what happened on the computer into a recording: events and pictures, under the caps and the
 * frame policy in the design. It owns no timer, no window and no capture API. The session feeds it
 * what it hears (`hear`, `cursor`, `say`), calls `tick` often, and it asks the injected frame source
 * for a picture when the policy says one is due. The clock is injected too, so a test advances time
 * by moving a number.
 *
 * Never recorded, by construction: a key, a mouse button, the clipboard, audio, a password field's
 * text. A watched event has no field for any of them, and a secure one pauses the recording.
 */

export const GRAY_WIDTH = 64
export const GRAY_HEIGHT = 36
const GRAY_CELLS = GRAY_WIDTH * GRAY_HEIGHT
/** A cell counts as changed when its brightness moved by this much of 255. */
const CELL_STEP = 16
/** Picture probes while nothing forces one. */
const PROBE_EVERY_MS = 1_000
/** A burst of events cannot hold the settling picture back longer than this. */
const SETTLE_CAP_MS = 1_000
const POINTER_SETTLE_MS = 300
const POINTER_MOVE = 0.02
const MAX_POINTER_EVENTS = 200
const DENY_PROCESS = /1password|keepass|bitwarden|lastpass|dashlane|enpass|nordpass|roboform/i
const DENY_TITLE = /password/i

/** What the helper reports; structurally the same as `NativeWatchEvent`. */
export interface WatchedEvent {
	kind: 'invoke' | 'focus' | 'selection' | 'menu' | 'window' | 'value' | 'app'
	tMs: number
	role?: string
	name?: string
	value?: string
	secure?: boolean
	phase?: 'open' | 'close'
	window?: string
	process?: string
	windowId?: string
}

export interface CapturedFrame {
	jpeg: Uint8Array
	/** 64 x 36 brightness, row by row. */
	gray: Uint8Array
	/** Every pixel black: the secure desktop, protected video, a permission prompt. */
	black: boolean
}

export interface FrameSource {
	/** A picture of the chosen display with a ring at `cursor` (display pixels). Rejects when it cannot. */
	capture(cursor?: { x: number; y: number }): Promise<CapturedFrame>
}

export type AssemblerNote = 'typing-not-recorded' | 'screenshots-failing' | 'secure-field'

export interface AssemblerOptions {
	/** Monotonic milliseconds. */
	clock: () => number
	frames: FrameSource
	display: { w: number; h: number; shownW: number; shownH: number }
	voice: RecordingVoice
	/** A new id for the result. */
	id: string
	/** Told when the pill should say something once. */
	note?: (note: AssemblerNote) => void
}

interface PendingText {
	field: string
	key: string
	value: string
	changedAt: number
	t: number
}

type CaptureReason = 'start' | 'end' | 'app' | 'event' | 'probe'

const FRAME_REF_KINDS = new Set(['invoke', 'select', 'menu', 'window'])

function fnv(bytes: Uint8Array): number {
	let hash = 0x811c9dc5
	for (const byte of bytes) {
		hash ^= byte
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/** The share of cells that changed between two small grayscale pictures, 0 to 1. */
export function changedShare(a: Uint8Array, b: Uint8Array): number {
	const cells = Math.min(a.length, b.length, GRAY_CELLS)
	if (!cells) return 0
	let changed = 0
	for (let index = 0; index < cells; index++)
		if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) >= CELL_STEP) changed++
	return changed / cells
}

const clip = (text: string | undefined, max: number): string | undefined =>
	text === undefined ? undefined : text.length > max ? text.slice(0, max) : text

export function isDeniedWindow(event: Pick<WatchedEvent, 'process' | 'window'>): boolean {
	return (
		(event.process !== undefined && DENY_PROCESS.test(event.process)) ||
		(event.window !== undefined && DENY_TITLE.test(event.window))
	)
}

export class RecordingAssembler {
	private readonly events: RecordingEvent[] = []
	private readonly held: (RecordingFrameData & { gray: Uint8Array; hash: number })[] = []
	private readonly cutCounts: RecordingCut = { ...EMPTY_CUT }
	private readonly pendingText = new Map<string, PendingText>()
	private frameCounter = 0
	private startedAt = 0
	private pausedTotal = 0
	private pausedAt: number | undefined
	private pauseReason: RecordingPauseReason | undefined
	private finished = false
	private inflight: Promise<void> | undefined
	private lastKept: { gray: Uint8Array; hash: number; at: number; index: number } | undefined
	private lastAttemptAt: number | undefined
	private pendingFrameAt: number | undefined
	private pendingSince = 0
	private forced: CaptureReason | undefined
	private awaiting: RecordingEvent[] = []
	private blackRun = false
	private failureRun = 0
	private failureNoted = false
	private cursorAt: { x: number; y: number } | undefined
	private cursorMovedAt = 0
	private lastPointer: { x: number; y: number } | undefined
	private pointerEvents = 0
	private sayChars = 0
	private focusKey: string | undefined
	private controlsSeen = false
	private typingNoted = false
	private deniedUntilApp = false
	private lastApp: string | undefined

	constructor(private readonly options: AssemblerOptions) {}

	/** Recorded time so far, pauses removed. */
	elapsed(): number {
		const now = this.options.clock()
		const paused = this.pausedAt === undefined ? 0 : now - this.pausedAt
		return Math.max(0, now - this.startedAt - this.pausedTotal - paused)
	}

	get paused(): boolean {
		return this.pausedAt !== undefined
	}

	get reasonPaused(): RecordingPauseReason | undefined {
		return this.pauseReason
	}

	get frameCount(): number {
		return this.held.length
	}

	get eventCount(): number {
		return this.events.length
	}

	limitReached(): boolean {
		return this.elapsed() >= RECORDING_LIMITS.maxDurationMs
	}

	cutReport(): Readonly<RecordingCut> {
		return { ...this.cutCounts }
	}

	async start(): Promise<void> {
		this.startedAt = this.options.clock()
		this.events.push({
			t: 0,
			type: 'start',
			display: { w: this.options.display.w, h: this.options.display.h },
		})
		const start = this.events[0] as RecordingEvent
		this.awaiting = [start]
		await this.capture('start')
	}

	/** Controls, windows and the foreground program, as the helper reports them. */
	hear(events: readonly WatchedEvent[], dropped = 0): void {
		if (this.finished) return
		this.cutCounts.helperDropped += dropped
		for (const event of events) this.hearOne(event)
	}

	/** A name, title or program as the review sheet shows it: secrets removed first, then clipped. */
	private named(value: string | undefined, max: number): string | undefined {
		if (value === undefined) return undefined
		const { text, redacted } = scrub(value)
		this.cutCounts.redacted += redacted
		return clip(text, max)
	}

	private hearOne(event: WatchedEvent): void {
		const now = this.options.clock()
		const denied = isDeniedWindow(event)
		if (this.paused) {
			// Only a way out of a secure pause is read while paused.
			if (this.pauseReason !== 'secure-field') return
			const leaves =
				(event.kind === 'app' && !denied) || (event.kind === 'focus' && !event.secure && !denied)
			if (!leaves) return
			this.resume()
			this.deniedUntilApp = false
		}
		if (event.secure || denied) {
			this.pendingText.clear()
			this.pause('secure-field')
			this.deniedUntilApp = denied
			this.options.note?.('secure-field')
			return
		}
		if (event.kind !== 'app') this.controlsSeen = true
		const name = this.named(event.name, RECORDING_LIMITS.maxNameChars)
		switch (event.kind) {
			case 'app': {
				this.flushText(true)
				const program = event.process ?? event.window ?? ''
				if (program === this.lastApp && !event.window) return
				this.lastApp = program
				this.add({
					t: this.elapsed(),
					type: 'app',
					...(program ? { name: this.named(program, RECORDING_LIMITS.maxNameChars) } : {}),
					...(event.window
						? { title: this.named(event.window, RECORDING_LIMITS.maxTitleChars) }
						: {}),
				})
				this.forced = this.forced ?? 'app'
				this.awaitFrame(now, true)
				return
			}
			case 'focus': {
				const key = this.fieldKey(event)
				if (this.focusKey !== key) this.flushText(true, key)
				this.focusKey = key
				this.add({
					t: this.elapsed(),
					type: 'focus',
					...(event.role ? { role: clip(event.role, 40) } : {}),
					...(name ? { name } : {}),
				})
				this.awaitFrame(now)
				return
			}
			case 'value': {
				if (event.value === undefined) return
				const key = this.fieldKey(event)
				const field = name || event.role || 'field'
				const pending = this.pendingText.get(key)
				if (pending) {
					pending.value = event.value
					pending.changedAt = now
				} else {
					this.pendingText.set(key, {
						field,
						key,
						value: event.value,
						changedAt: now,
						t: this.elapsed(),
					})
				}
				this.focusKey = this.focusKey ?? key
				return
			}
			case 'invoke':
			case 'selection':
			case 'menu':
			case 'window': {
				if (event.kind === 'invoke') this.flushText(true)
				const type =
					event.kind === 'selection' ? 'select' : (event.kind as 'invoke' | 'menu' | 'window')
				const record = this.add({
					t: this.elapsed(),
					type,
					...(event.role ? { role: clip(event.role, 40) } : {}),
					...(name ? { name } : {}),
					...(event.phase ? { phase: event.phase } : {}),
					...(event.kind === 'window' && event.window
						? { title: this.named(event.window, RECORDING_LIMITS.maxTitleChars) }
						: {}),
				})
				if (record && FRAME_REF_KINDS.has(type)) this.awaiting.push(record)
				this.awaitFrame(now)
				return
			}
		}
	}

	private fieldKey(event: WatchedEvent): string {
		return `${event.windowId ?? event.window ?? ''}|${event.role ?? ''}|${event.name ?? ''}`
	}

	private awaitFrame(now: number, immediate = false): void {
		if (this.pendingFrameAt === undefined) this.pendingSince = now
		const settle = immediate ? now : now + RECORDING_LIMITS.settleMs
		this.pendingFrameAt = Math.min(settle, this.pendingSince + SETTLE_CAP_MS)
		if (!immediate) this.pendingFrameAt = Math.max(this.pendingFrameAt, now)
	}

	/** The pointer's place on the display, in display pixels; drawn as a ring and noticed when it settles. */
	cursor(point: { x: number; y: number }): void {
		if (this.finished) return
		const previous = this.cursorAt
		if (!previous || previous.x !== point.x || previous.y !== point.y) {
			this.cursorAt = point
			this.cursorMovedAt = this.options.clock()
		}
	}

	/** Spoken words that began `spokenAt` recorded milliseconds in. */
	say(text: string, spokenAt?: number): void {
		if (this.finished) return
		const { text: clean, redacted } = scrub(text.trim())
		this.cutCounts.redacted += redacted
		if (!clean) return
		let rest = clean
		while (rest) {
			const chunk = rest.slice(0, RECORDING_LIMITS.maxSayChunkChars)
			rest = rest.slice(chunk.length)
			if (this.sayChars + chunk.length > RECORDING_LIMITS.maxSayTotalChars) {
				this.cutCounts.say++
				return
			}
			const t = Math.min(spokenAt ?? this.elapsed(), this.elapsed())
			if (this.add({ t: Math.max(0, t), type: 'say', text: chunk })) this.sayChars += chunk.length
			else this.cutCounts.say++
		}
	}

	pause(reason: RecordingPauseReason): void {
		if (this.finished || this.paused) return
		this.flushText(true)
		this.pausedAt = this.options.clock()
		this.pauseReason = reason
		this.pendingFrameAt = undefined
		this.forced = undefined
		if (reason === 'secure-field' || reason === 'protected-screen') this.cutCounts.paused++
		this.events.push({ t: this.elapsed(), type: 'paused', reason })
	}

	resume(): void {
		if (this.finished || !this.paused) return
		const at = this.options.clock()
		this.pausedTotal += at - (this.pausedAt ?? at)
		this.pausedAt = undefined
		this.pauseReason = undefined
		this.events.push({ t: this.elapsed(), type: 'resumed' })
		// What is on the screen now is not what was last kept.
		this.forced = this.forced ?? 'app'
		this.awaitFrame(at)
	}

	/** Called often by the session. Takes pictures the policy asks for and settles typed text. */
	async tick(): Promise<void> {
		if (this.finished || this.paused || this.inflight) return
		const now = this.options.clock()
		this.flushText(false)
		this.settlePointer(now)
		const gapSinceKept = this.lastKept ? now - this.lastKept.at : Number.POSITIVE_INFINITY
		const eventDue = this.pendingFrameAt !== undefined && now >= this.pendingFrameAt
		if (eventDue) {
			if (gapSinceKept < RECORDING_LIMITS.minFrameGapMs && this.lastKept) {
				this.pendingFrameAt = this.lastKept.at + RECORDING_LIMITS.minFrameGapMs
				return
			}
			await this.capture(this.forced ?? 'event')
			return
		}
		if (this.lastAttemptAt === undefined || now - this.lastAttemptAt >= PROBE_EVERY_MS) {
			await this.capture('probe')
		}
	}

	private settlePointer(now: number): void {
		const point = this.cursorAt
		if (!point || now - this.cursorMovedAt < POINTER_SETTLE_MS) return
		const { w, h } = this.options.display
		const x = Math.round((point.x / w) * 1000) / 1000
		const y = Math.round((point.y / h) * 1000) / 1000
		const last = this.lastPointer
		if (last && Math.hypot(x - last.x, y - last.y) < POINTER_MOVE) return
		if (this.pointerEvents >= MAX_POINTER_EVENTS) return
		this.lastPointer = { x, y }
		if (this.add({ t: this.elapsed(), type: 'pointer', x, y })) this.pointerEvents++
	}

	private async capture(reason: CaptureReason): Promise<void> {
		const run = this.takePicture(reason)
		this.inflight = run
		try {
			await run
		} finally {
			if (this.inflight === run) this.inflight = undefined
		}
	}

	private async takePicture(reason: CaptureReason): Promise<void> {
		const now = this.options.clock()
		this.lastAttemptAt = now
		const taking = this.awaiting
		this.awaiting = []
		const wasPending = this.pendingFrameAt !== undefined
		this.pendingFrameAt = undefined
		const forced = this.forced
		this.forced = undefined
		let frame: CapturedFrame
		try {
			const point = this.cursorAt
			frame = await this.options.frames.capture(point)
		} catch {
			this.cutCounts.frameFailures++
			this.failureRun++
			if (this.failureRun >= 3 && !this.failureNoted) {
				this.failureNoted = true
				this.options.note?.('screenshots-failing')
			}
			return
		}
		this.failureRun = 0
		if (this.finished && reason !== 'end') return
		{
			if (frame.black) {
				if (!this.blackRun) {
					this.blackRun = true
					this.cutCounts.paused++
					this.events.push({ t: this.elapsed(), type: 'paused', reason: 'protected-screen' })
				}
				return
			}
			if (this.blackRun) {
				this.blackRun = false
				this.events.push({ t: this.elapsed(), type: 'resumed' })
			}
			const hash = fnv(frame.gray)
			const last = this.lastKept
			const identical = last !== undefined && last.hash === hash
			const share = last ? changedShare(last.gray, frame.gray) : 1
			const quiet = last ? now - last.at : Number.POSITIVE_INFINITY
			const caused = reason === 'start' || reason === 'end' || wasPending || forced !== undefined
			let keep = false
			if (reason === 'start' || reason === 'end') keep = !identical || reason === 'start'
			else if (!identical) {
				keep =
					quiet >= RECORDING_LIMITS.minFrameGapMs &&
					(caused ||
						share > RECORDING_LIMITS.changeThreshold ||
						quiet >= RECORDING_LIMITS.maxQuietGapMs)
			}
			if (keep) {
				const index = ++this.frameCounter
				const entry = {
					index,
					t: this.elapsed(),
					jpeg: frame.jpeg,
					event: caused,
					gray: frame.gray,
					hash,
				}
				this.held.push(entry)
				this.lastKept = { gray: frame.gray, hash, at: now, index }
				for (const event of taking) event.frame = index
				this.trimHeld()
			} else if (identical && last) {
				// The picture on hand already shows it.
				for (const event of taking) event.frame = last.index
			} else {
				// Not kept for now; a forced reason tries again at the next tick.
				if (caused) {
					this.awaiting = [...taking, ...this.awaiting]
					this.pendingFrameAt = now + RECORDING_LIMITS.minFrameGapMs
					this.forced = forced
				}
			}
		}
	}

	/** At most the held cap: older pictures that no event needs go first, and never the first or the last. */
	private trimHeld(): void {
		while (this.held.length > RECORDING_LIMITS.maxHeldFrames) {
			let victim = this.held.findIndex((frame, index) => index > 0 && !frame.event)
			const lastIndex = this.held.length - 1
			if (victim === lastIndex) victim = -1
			if (victim < 0) victim = this.held.findIndex((_, index) => index > 0 && index < lastIndex)
			if (victim < 0) break
			const [gone] = this.held.splice(victim, 1)
			if (gone)
				for (const event of this.events) if (event.frame === gone.index) event.frame = undefined
			this.cutCounts.framesHeld++
		}
	}

	/** Typed text is the field's text when focus leaves it, or after it has been still for 700 ms. */
	private flushText(all: boolean, nextKey?: string): void {
		const now = this.options.clock()
		for (const [key, pending] of [...this.pendingText]) {
			const still = now - pending.changedAt >= RECORDING_LIMITS.textStillMs
			if (!all && !still) continue
			if (all && nextKey !== undefined && key === nextKey && !still) continue
			this.pendingText.delete(key)
			const { text, redacted } = scrub(pending.value)
			this.cutCounts.redacted += redacted
			if (!text.trim()) continue
			const clipped = clip(text, RECORDING_LIMITS.maxTextChars) as string
			if (clipped.length < text.length) this.cutCounts.text++
			this.add({
				t: pending.t,
				type: 'text',
				field: this.named(pending.field, RECORDING_LIMITS.maxNameChars) ?? '',
				value: clipped,
			})
		}
	}

	private add(event: RecordingEvent): RecordingEvent | undefined {
		// The start and the stop always fit: two places are kept for them.
		if (this.events.length >= RECORDING_LIMITS.maxEvents - 1) {
			this.cutCounts.events++
			return undefined
		}
		this.events.push(event)
		return event
	}

	/** Ends the recording: the last picture, the stop event, the result. */
	async finish(reason: RecordingStopReason): Promise<RecordingResult> {
		if (!this.finished) {
			if (this.paused) this.resume()
			this.flushText(true)
			// Wait out a picture in flight.
			await this.inflight
			const stop: RecordingEvent = { t: this.elapsed(), type: 'stop', reason }
			this.awaiting = [stop]
			await this.capture('end')
			this.finished = true

			this.events.push(stop)
		}
		const order = new Map(this.events.map((event, index) => [event, index]))
		const events = [...this.events].sort(
			(a, b) => a.t - b.t || (order.get(a) ?? 0) - (order.get(b) ?? 0),
		)
		const stopEvent = events.find((event) => event.type === 'stop')
		return {
			id: this.options.id,
			durationMs: stopEvent?.t ?? this.elapsed(),
			stopReason: reason,
			events,
			frames: this.held.map(({ index, t, jpeg, event }) => ({ index, t, jpeg, event })),
			cut: this.cutReport(),
			voice: this.options.voice,
			display: this.options.display,
			controls: this.controlsSeen,
			typingNote: this.typingNoted,
		}
	}

	/** Called once after the first stretch of recording: said when no program exposed its controls. */
	noteControls(): void {
		if (!this.controlsSeen && !this.typingNoted) {
			this.typingNoted = true
			this.options.note?.('typing-not-recorded')
		}
	}
}
