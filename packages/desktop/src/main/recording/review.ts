import {
	RECORDING_LIMITS,
	type RecordingCut,
	type RecordingEvent,
	type RecordingFrameData,
	type RecordingResult,
	type RecordingReviewStep,
	type RecordingReviewView,
	formatClock,
} from '../../shared/recording-protocol.js'

/**
 * The review sheet's side of a recording: what the person sees, what they may remove, and what is
 * left to send once the sent count and size caps are applied. All plain functions over a result, so
 * the drop order is the same in a test as in the app.
 */

/** Events that are not steps the person did; they stay in the record but are not listed or counted. */
const NOT_STEPS = new Set(['start', 'stop', 'paused', 'resumed', 'pointer'])

export function isStep(event: RecordingEvent): boolean {
	return !NOT_STEPS.has(event.type)
}

const quote = (text: string | undefined, max = 60): string => {
	const value = (text ?? '').replace(/\s+/g, ' ').trim()
	return `“${value.length > max ? `${value.slice(0, max - 1)}…` : value}”`
}

export function stepLabel(event: RecordingEvent): string {
	const control = [event.role, event.name ? quote(event.name, 40) : ''].filter(Boolean).join(' ')
	switch (event.type) {
		case 'app':
			return `Switched to ${event.name ?? 'another program'}${event.title ? `: ${event.title}` : ''}`
		case 'focus':
			return `Went to ${control || 'a control'}`
		case 'text':
			return `Typed ${quote(event.value)} in ${event.field ?? 'a field'}`
		case 'say':
			return `Said ${quote(event.text, 90)}`
		case 'invoke':
			return `Pressed ${control || 'a control'}`
		case 'select':
			return `Chose ${control || 'an item'}`
		case 'menu':
			return `${event.phase === 'close' ? 'Closed' : 'Opened'} a menu${event.name ? ` ${quote(event.name, 40)}` : ''}`
		case 'window':
			return `${event.phase === 'close' ? 'Closed' : 'Opened'} a window${event.title ? ` ${quote(event.title, 50)}` : ''}`
		case 'pointer':
			return 'Pointer rested here'
		case 'paused':
			return event.reason === 'secure-field'
				? 'Paused: a password field'
				: event.reason === 'protected-screen'
					? 'Paused: a protected screen'
					: 'Paused'
		case 'resumed':
			return 'Resumed'
		case 'start':
			return 'Started'
		case 'stop':
			return 'Finished'
	}
}

/** The sentences that say what a recording left out. */
export function cutLines(cut: Readonly<RecordingCut>): string[] {
	const lines: string[] = []
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
	if (cut.redacted)
		lines.push(
			`${plural(cut.redacted, 'piece of text', 'pieces of text')} that looked like a secret ${cut.redacted === 1 ? 'was' : 'were'} replaced with [removed].`,
		)
	if (cut.paused)
		lines.push(
			`Recording paused ${cut.paused === 1 ? 'once' : `${cut.paused} times`} for a password field or a protected screen.`,
		)
	if (cut.events)
		lines.push(
			`${plural(cut.events, 'step', 'steps')} past the limit of 2000 ${cut.events === 1 ? 'was' : 'were'} not kept.`,
		)
	if (cut.text)
		lines.push(`${plural(cut.text, 'typed text', 'typed texts')} cut to 200 characters.`)
	if (cut.say) lines.push('Spoken text past the limit was not kept.')
	if (cut.framesHeld)
		lines.push(
			`${plural(cut.framesHeld, 'picture', 'pictures')} dropped while recording to stay under 60.`,
		)
	if (cut.framesThinned)
		lines.push(
			`${plural(cut.framesThinned, 'picture', 'pictures')} left out to send at most ${RECORDING_LIMITS.maxSentFrames} pictures and 6 MB.`,
		)
	if (cut.eventsJson)
		lines.push(`${plural(cut.eventsJson, 'step', 'steps')} left out to keep the list short.`)
	if (cut.helperDropped) lines.push('Some controls were missed while the computer was busy.')
	if (cut.frameFailures)
		lines.push(`${plural(cut.frameFailures, 'picture', 'pictures')} could not be taken.`)
	if (cut.removedSteps) lines.push(`You removed ${plural(cut.removedSteps, 'step', 'steps')}.`)
	if (cut.removedPictures)
		lines.push(`You removed ${plural(cut.removedPictures, 'picture', 'pictures')}.`)
	if (cut.removedVoice) lines.push('You removed the voice text.')
	return lines
}

/** A recording the person can edit before Send. The pictures stay in main; only what is needed leaves. */
export class ReviewDraft {
	private events: RecordingEvent[]
	private frames: RecordingFrameData[]
	private readonly cut: RecordingCut
	readonly result: RecordingResult

	constructor(result: RecordingResult) {
		this.result = result
		this.events = result.events.map((event) => ({ ...event }))
		this.frames = [...result.frames]
		this.cut = { ...result.cut }
	}

	private stepEntries(): { id: number; event: RecordingEvent }[] {
		return this.events.flatMap((event, id) => (isStep(event) ? [{ id, event }] : []))
	}

	removeStep(id: number): boolean {
		const event = this.events[id]
		if (!event || !isStep(event)) return false
		this.events.splice(id, 1)
		this.cut.removedSteps++
		return true
	}

	removePicture(index: number): boolean {
		const at = this.frames.findIndex((frame) => frame.index === index)
		if (at < 0) return false
		this.frames.splice(at, 1)
		for (const event of this.events) if (event.frame === index) event.frame = undefined
		this.cut.removedPictures++
		return true
	}

	removePictures(): void {
		this.cut.removedPictures += this.frames.length
		this.frames = []
		for (const event of this.events) event.frame = undefined
	}

	removeVoice(): void {
		const before = this.events.length
		this.events = this.events.filter((event) => event.type !== 'say')
		if (this.events.length < before) this.cut.removedVoice++
	}

	get pictureCount(): number {
		return this.frames.length
	}

	get stepCount(): number {
		return this.stepEntries().length
	}

	view(thumb: (frame: RecordingFrameData) => string, holdMs: number): RecordingReviewView {
		const steps: RecordingReviewStep[] = this.stepEntries().map(({ id, event }) => ({
			id,
			t: event.t,
			time: formatClock(event.t),
			label: stepLabel(event),
			kind: event.type,
			...(event.frame !== undefined ? { picture: event.frame } : {}),
		}))
		const duration = formatClock(this.result.durationMs)
		const pictures = this.frames.length
		const voice = this.result.voice
		const summary = `Recording ready: ${duration}, ${pictures} ${pictures === 1 ? 'picture' : 'pictures'}, ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}, voice ${voice === 'on' ? 'on' : 'off'}`
		return {
			id: this.result.id,
			durationMs: this.result.durationMs,
			duration,
			pictureCount: pictures,
			stepCount: steps.length,
			voice,
			controls: this.result.controls,
			steps,
			pictures: this.frames.map((frame) => ({
				index: frame.index,
				time: formatClock(frame.t),
				thumb: thumb(frame),
			})),
			cutLines: cutLines(this.cut),
			holdMs,
			summary,
		}
	}

	/** What goes into the message: pictures thinned to the sent caps, events fitted to the JSON cap. */
	finalize(): { result: RecordingResult; frames: RecordingFrameData[] } {
		const thinned = thinFrames(this.frames, this.events)
		const cut = { ...this.cut, framesThinned: this.cut.framesThinned + thinned.dropped }
		const fitted = fitEvents(thinned.events)
		cut.eventsJson += fitted.dropped
		const hasWords = fitted.events.some((event) => event.type === 'say')
		return {
			frames: thinned.frames,
			result: {
				...this.result,
				events: fitted.events,
				frames: thinned.frames,
				cut,
				voice:
					this.result.voice === 'on' && !hasWords && this.cut.removedVoice
						? 'off'
						: this.result.voice,
			},
		}
	}
}

/**
 * At most 24 pictures and 6 MiB. The first and the last stay; then every picture tied to an event;
 * then the rest, thinned evenly. Within a rank the picture that sits closest to its neighbours in time
 * goes first, so what is left spreads over the whole recording. The remaining pictures are numbered
 * again from 1 and the events that pointed at a dropped picture lose the pointer.
 */
export function thinFrames(
	frames: readonly RecordingFrameData[],
	events: readonly RecordingEvent[],
	limits: { count: number; bytes: number } = {
		count: RECORDING_LIMITS.maxSentFrames,
		bytes: RECORDING_LIMITS.maxSentBytes,
	},
): { frames: RecordingFrameData[]; events: RecordingEvent[]; dropped: number } {
	let kept = [...frames]
	const bytes = () => kept.reduce((sum, frame) => sum + frame.jpeg.byteLength, 0)
	const rank = (frame: RecordingFrameData, index: number): number =>
		index === 0 || index === kept.length - 1 ? 2 : frame.event ? 1 : 0
	while (kept.length > 2 && (kept.length > limits.count || bytes() > limits.bytes)) {
		let victim = -1
		let best: [number, number] = [3, Number.POSITIVE_INFINITY]
		for (let index = 1; index < kept.length - 1; index++) {
			const frame = kept[index] as RecordingFrameData
			const before = kept[index - 1] as RecordingFrameData
			const after = kept[index + 1] as RecordingFrameData
			const crowd = after.t - before.t
			const key: [number, number] = [rank(frame, index), crowd]
			if (key[0] < best[0] || (key[0] === best[0] && key[1] < best[1])) {
				best = key
				victim = index
			}
		}
		if (victim < 0) break
		kept.splice(victim, 1)
	}
	// Two pictures still over the byte cap: the last resort keeps only the first.
	while (kept.length > 1 && bytes() > limits.bytes) {
		kept = kept.slice(0, 1)
	}
	const renumber = new Map(kept.map((frame, at) => [frame.index, at + 1]))
	const out = kept.map((frame, at) => ({ ...frame, index: at + 1 }))
	const mapped = events.map((event) => {
		const copy = { ...event }
		if (copy.frame !== undefined) {
			const next = renumber.get(copy.frame)
			if (next === undefined) copy.frame = undefined
			else copy.frame = next
		}

		return copy
	})
	return { frames: out, events: mapped, dropped: Math.max(0, frames.length - kept.length) }
}

/** One event per line, so the model reads the steps in order. */
export function eventsJson(events: readonly RecordingEvent[]): string {
	return `[\n${events.map((event) => `  ${JSON.stringify(event)}`).join(',\n')}\n]`
}

/**
 * The events as JSON within 24 KB. Typed text goes first (the longest, newest ones), then pointer
 * rests, then window and menu moves, then spoken text; the start, the stop and every press stay.
 */
export function fitEvents(
	events: readonly RecordingEvent[],
	maxBytes: number = RECORDING_LIMITS.maxEventsJsonBytes,
): { events: RecordingEvent[]; dropped: number } {
	let list = [...events]
	const size = () => new TextEncoder().encode(eventsJson(list)).byteLength
	let dropped = 0
	for (const type of ['text', 'pointer', 'window', 'menu', 'say', 'focus'] as const) {
		while (size() > maxBytes) {
			let at = -1
			for (let index = list.length - 1; index >= 0; index--)
				if (list[index]?.type === type) {
					at = index
					break
				}
			if (at < 0) break
			list = list.filter((_, index) => index !== at)
			dropped++
		}
		if (size() <= maxBytes) break
	}
	return { events: list, dropped }
}
