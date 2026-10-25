/**
 * Turns a command's stdout into a few model-sized events.
 *
 * A watcher (`tail -f`, a poll loop, `gh run watch`) can print a line every
 * millisecond, and every line the model is told about costs a context resend.
 * So a monitor does not forward lines, it forwards BATCHES: lines are split,
 * trimmed and truncated here, held for a short fixed window, and delivered
 * together, and the batches themselves are rationed by a token bucket. A
 * source that outruns the ration is first told so, then stopped, because a
 * model that is flooded stops reading and one that is silenced does not know
 * to look.
 *
 * Pure: no process, no registry, no model. The clock and the timer are
 * injectable (and default to the globals read at call time, so fake timers
 * work without any injection), which is what lets the tests advance a window
 * by calling a function rather than by waiting for one.
 *
 * The constants and the wording are fixed here.
 */

/** A longer line keeps its first this-many characters. */
export const MONITOR_LINE_MAX_CHARS = 500
/** A joined batch longer than this keeps its first this-many characters. */
export const MONITOR_BATCH_MAX_CHARS = 3000
/**
 * The first buffered line arms ONE timer for this long; everything that
 * arrives before it fires rides in the same batch. A fixed window, not a
 * debounce: a source that never pauses still gets a batch every window
 * instead of never.
 */
export const MONITOR_BATCH_WINDOW_MS = 200
/** A partial line (no newline yet) keeps its tail past this many bytes. */
export const MONITOR_PARTIAL_LINE_MAX_BYTES = 1024 * 1024
/** One token per BATCH, not per line. */
export const MONITOR_BUCKET_CAPACITY = 10
export const MONITOR_BUCKET_REFILL_MS = 2000
/** Suppression older than this, with another batch dropped, stops the monitor. */
export const MONITOR_SUPPRESSION_LIMIT_MS = 30_000
/** The effective ceiling on a monitor's life; a host may lower it, never raise it past the schema. */
export const MONITOR_TIMEOUT_CAP_MS = 1_800_000
export const MONITOR_TIMEOUT_DEFAULT_MS = 300_000
export const MONITOR_TIMEOUT_MIN_MS = 1000
/** The schema ceiling; anything between the cap and this is clamped, not refused. */
export const MONITOR_TIMEOUT_MAX_MS = 3_600_000
/** One notification handed to the model is cut to this many characters, in the middle. */
export const MONITOR_NOTIFICATION_MAX_CHARS = 100_000
/**
 * One event's content is shrunk to this many characters BEFORE it is framed,
 * so the notification cap never has to cut inside an envelope. A batch is at
 * most 3000, so this only matters to a notice or a caller that outgrew that.
 */
export const MONITOR_EVENT_CONTENT_MAX_CHARS = 20_000

const LINE_TRUNCATED = '...(truncated)'
const BATCH_TRUNCATED = '\n...(truncated)'

/** `30m`, `5m`, `90s`: whole minutes as minutes, anything else in seconds. */
export function formatMonitorDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000))
	return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`
}

export function suppressionNotice(count: number): string {
	return `[${count} events suppressed — output rate too high. Consider stopping this monitor and starting it with a more selective command.]`
}

export function tooMuchOutputNotice(count: number, overMs: number): string {
	return `[Monitor stopped — too much output (${count} events suppressed over ${formatMonitorDuration(overMs)}). Restart it with a more selective command.]`
}

export function expiryNotice(ms: number, delivered: number): string {
	return delivered > 0
		? `[Monitor expired after ${formatMonitorDuration(ms)} with ${delivered} events delivered. Start it again if you still need the watch.]`
		: `[Monitor expired after ${formatMonitorDuration(ms)} with no events delivered. Start it again if you still need the watch — and widen the filter if silence was unexpected.]`
}

export interface MonitorStreamStats {
	/** Batches handed to `onBatch`. */
	readonly eventsDelivered: number
	/** Batches the bucket dropped, over the monitor's whole life. */
	readonly suppressed: number
	/** Characters pushed in, before any trimming: zero means the command never wrote to stdout. */
	readonly stdoutChars: number
}

export interface MonitorStreamOptions {
	/** One batch of lines, joined with `\n`. */
	onBatch(text: string): void
	/** Housekeeping text from the stream itself (the suppression notice). Not rationed. */
	onNotice(text: string): void
	/**
	 * The source was suppressed for too long and another batch was dropped. The
	 * stream is closed before this is called; stopping the process is the
	 * caller's.
	 */
	onOverflow(info: { readonly suppressed: number; readonly overMs: number }): void
	now?: () => number
	setTimer?: (callback: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}

export interface MonitorStream {
	/** Feed raw stdout text; chunks may split a line anywhere. */
	push(text: string): void
	/** Emit the pending batch now, without the partial line. For expiry. */
	flush(): void
	/** The end of the stream: the partial line counts as a line, then everything pending is emitted. */
	drain(): void
	/** Stop for good. Whatever is pending is discarded. */
	close(): void
	stats(): MonitorStreamStats
}

/** The tail of `text` that fits `maxBytes`, starting on a whole code point. */
function keepTail(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text)
	if (bytes.length <= maxBytes) return text
	let start = bytes.length - maxBytes
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
	return bytes.subarray(start).toString('utf8')
}

export function createMonitorStream(options: MonitorStreamOptions): MonitorStream {
	const now = options.now ?? (() => Date.now())
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => {
			const handle = setTimeout(callback, ms)
			// A pending batch must not keep a process alive; the job's own exit
			// drains it.
			handle.unref?.()
			return handle
		})
	const clearTimer =
		options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))

	let closed = false
	let partial = ''
	let lines: string[] = []
	let timer: unknown
	let timerArmed = false

	let tokens = MONITOR_BUCKET_CAPACITY
	let refilledAt = now()

	let eventsDelivered = 0
	let suppressedTotal = 0
	let stdoutChars = 0

	// The suppression tracker. `count` is what the auto-stop reports; `unannounced`
	// is what the next notice reports. They differ after a notice, because the
	// tracker outlives it on purpose: a source that is told and keeps going must
	// still reach the 30 s rule.
	let suppressionStartedAt: number | undefined
	let lastDropAt = 0
	let count = 0
	let unannounced = 0
	let noticeEmitted = false

	const refill = (at: number): void => {
		const elapsed = at - refilledAt
		if (elapsed <= 0) return
		tokens = Math.min(MONITOR_BUCKET_CAPACITY, tokens + elapsed / MONITOR_BUCKET_REFILL_MS)
		refilledAt = at
	}

	const deliver = (batch: string): void => {
		const at = now()
		// Reset only after a notice went out AND the source has been quiet for
		// three refills. Resetting on quiet alone would let a source that is
		// dropped every other window never reach the stop rule.
		if (noticeEmitted && at - lastDropAt > 3 * MONITOR_BUCKET_REFILL_MS) {
			suppressionStartedAt = undefined
			count = 0
			unannounced = 0
			noticeEmitted = false
		}
		refill(at)
		if (tokens >= 1) {
			tokens -= 1
			if (unannounced > 0) {
				options.onNotice(suppressionNotice(unannounced))
				unannounced = 0
				noticeEmitted = true
			}
			eventsDelivered++
			options.onBatch(batch)
			return
		}
		// Whether the rule fires is decided by when suppression BEGAN, before
		// this drop is counted, and the count reported includes it.
		const began = suppressionStartedAt
		suppressionStartedAt ??= at
		lastDropAt = at
		suppressedTotal++
		count++
		unannounced++
		if (began !== undefined && at - began > MONITOR_SUPPRESSION_LIMIT_MS) {
			stop()
			options.onOverflow({ suppressed: count, overMs: at - began })
		}
	}

	const emitPending = (): void => {
		if (timerArmed) {
			clearTimer(timer)
			timerArmed = false
		}
		if (lines.length === 0) return
		let batch = lines.join('\n')
		lines = []
		if (batch.length > MONITOR_BATCH_MAX_CHARS) {
			batch = batch.slice(0, MONITOR_BATCH_MAX_CHARS) + BATCH_TRUNCATED
		}
		deliver(batch)
	}

	const addLine = (raw: string): void => {
		const line = raw.trim()
		if (line.length === 0) return
		lines.push(
			line.length > MONITOR_LINE_MAX_CHARS
				? line.slice(0, MONITOR_LINE_MAX_CHARS) + LINE_TRUNCATED
				: line,
		)
		if (!timerArmed) {
			timerArmed = true
			timer = setTimer(() => {
				timerArmed = false
				if (!closed) emitPending()
			}, MONITOR_BATCH_WINDOW_MS)
		}
	}

	const stop = (): void => {
		closed = true
		if (timerArmed) {
			clearTimer(timer)
			timerArmed = false
		}
		lines = []
		partial = ''
	}

	return {
		push(text) {
			if (closed || text.length === 0) return
			stdoutChars += text.length
			const buffered = partial + text
			const parts = buffered.split('\n')
			partial = keepTail(parts.pop() ?? '', MONITOR_PARTIAL_LINE_MAX_BYTES)
			for (const part of parts) addLine(part)
		},
		flush() {
			if (closed) return
			emitPending()
		},
		drain() {
			if (closed) return
			const rest = partial
			partial = ''
			addLine(rest)
			emitPending()
		},
		close: stop,
		stats: () => ({ eventsDelivered, suppressed: suppressedTotal, stdoutChars }),
	}
}
