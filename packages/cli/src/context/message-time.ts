/**
 * The line that tells the model when the person sent a message.
 *
 * The first message of a conversation says the time and the zone. From the
 * second on, a line is added only when the gap from the person's previous
 * message is long enough to matter, and then it states the gap in plain words:
 * small models do time arithmetic badly, so they are handed the answer and
 * never two clock readings to subtract. The date is not repeated here; the
 * environment note says it.
 *
 * The line is written once, with the message (`UserMessage.timeNote`), so a
 * resumed conversation sends the same bytes and the cache holds.
 */

/** A gap shorter than this adds no line: nothing a model could do differently. */
export const MESSAGE_GAP_NOTE_MS = 5 * 60_000

export interface MessageZone {
	/** Minutes east of UTC at the moment of the message. */
	readonly offsetMinutes: number
	/** The zone's name, when the system knows one. */
	readonly name?: string
}

/** The system's zone at `at`. */
export function systemZone(at: Date): MessageZone {
	let name: string | undefined
	try {
		name = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
	} catch {
		name = undefined
	}
	return { offsetMinutes: -at.getTimezoneOffset(), ...(name ? { name } : {}) }
}

function two(n: number): string {
	return String(n).padStart(2, '0')
}

function clock(at: number, zone: MessageZone): string {
	const local = new Date(at + zone.offsetMinutes * 60_000)
	return `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`
}

function offsetLabel(zone: MessageZone): string {
	const sign = zone.offsetMinutes < 0 ? '-' : '+'
	const abs = Math.abs(zone.offsetMinutes)
	return `UTC${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`
}

/** `45 min`, `2 h 15 min`, `3 d 4 h`: whole units, the two largest that are not zero. */
export function describeGap(ms: number): string {
	const minutes = Math.floor(ms / 60_000)
	const days = Math.floor(minutes / 1440)
	const hours = Math.floor((minutes % 1440) / 60)
	const mins = minutes % 60
	if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
	if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`
	return `${mins} min`
}

/**
 * The line for a message sent at `now`, or `undefined` when none is owed.
 * `previous` is when the person's previous message in this conversation was
 * sent; absent means this is the first.
 */
export function messageTimeNote(input: {
	readonly now: number
	readonly previous?: number
	readonly zone?: MessageZone
}): string | undefined {
	const zone = input.zone ?? systemZone(new Date(input.now))
	const where = `${offsetLabel(zone)}${zone.name ? ` ${zone.name}` : ''}`
	if (input.previous === undefined) return `[Sent at ${clock(input.now, zone)}, ${where}]`
	const gap = input.now - input.previous
	if (!Number.isFinite(gap) || gap < MESSAGE_GAP_NOTE_MS) return undefined
	return `[Sent ${describeGap(gap)} after the previous message, at ${clock(input.now, zone)}, ${where}]`
}

/** When the person's last typed message in `messages` was sent. */
export function previousSentAt(
	messages: readonly {
		readonly role: string
		readonly source?: unknown
		readonly timestamp?: number
	}[],
): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === 'user' && message.source === undefined && message.timestamp !== undefined)
			return message.timestamp
	}
	return undefined
}
