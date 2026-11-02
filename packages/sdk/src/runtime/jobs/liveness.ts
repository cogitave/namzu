/**
 * What a host can say about one running item, from three facts it reads
 * itself: where it is, when it last made progress, and whether it is alive.
 *
 * Pure: no clock, no process probe. The caller passes `now` and the probe's
 * answer, so the same table of cases runs under a fake clock. The kinds
 * (background job, monitor, delegated agent, workflow run) share one verdict
 * so the outstanding-work note and every status read print the same words.
 */

/** Silence shorter than this still reads as progress. */
export const LIVENESS_QUIET_MS = 30_000

/**
 * Silence from an item that is alive and has no known reason to wait. The
 * same number `wait_for_job` uses for its idle bound, so there is one
 * threshold to explain.
 */
export const LIVENESS_STALLED_MS = 2 * 60 * 1000

export type LivenessKind = 'job' | 'monitor' | 'agent' | 'workflow'

export type LivenessVerdict = 'progressing' | 'waiting' | 'stalled' | 'dead' | 'finished'

export interface LivenessInput {
	readonly kind: LivenessKind
	readonly id: string
	/** Short name the person would recognise: a command, a description, a workflow name. */
	readonly label: string
	/** Where it is: the last output line, the current tool, the phase. One line, already bounded. */
	readonly where?: string
	readonly startedAt: number
	/** When it last made progress (epoch ms). Absent means it has not yet: the start counts. */
	readonly lastProgressAt?: number
	/** The probe's answer: is the process or run still there. */
	readonly alive: boolean
	/** A result or an end has arrived. */
	readonly finished?: boolean
	/** What it is known to be waiting on, when it is waiting for a reason (a tool, a free slot). */
	readonly waitingOn?: string
	readonly waitingSince?: number
}

export interface Liveness {
	readonly kind: LivenessKind
	readonly id: string
	readonly label: string
	readonly where?: string
	readonly verdict: LivenessVerdict
	/** Whole seconds since the last progress (or the start). */
	readonly idleSeconds: number
	/** Whole seconds since it started. */
	readonly ageSeconds: number
	/** Present when the verdict is `waiting` with a reason. */
	readonly waitingOn?: string
	readonly waitingSeconds?: number
}

export interface LivenessThresholds {
	readonly quietMs?: number
	readonly stalledMs?: number
}

const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000))

/** Decide the verdict. Order matters: a result beats everything, then death, then the reason to wait. */
export function judgeLiveness(
	input: LivenessInput,
	now: number,
	thresholds: LivenessThresholds = {},
): Liveness {
	const quietMs = thresholds.quietMs ?? LIVENESS_QUIET_MS
	const stalledMs = thresholds.stalledMs ?? LIVENESS_STALLED_MS
	const last = Math.max(input.startedAt, input.lastProgressAt ?? input.startedAt)
	const idle = Math.max(0, now - last)
	let verdict: LivenessVerdict
	if (input.finished) verdict = 'finished'
	else if (!input.alive) verdict = 'dead'
	else if (input.waitingOn !== undefined) verdict = 'waiting'
	else if (idle >= stalledMs) verdict = 'stalled'
	else if (idle >= quietMs) verdict = 'waiting'
	else verdict = 'progressing'
	const waitingOn =
		verdict === 'waiting' && input.waitingOn !== undefined ? input.waitingOn : undefined
	const waitingSince = input.waitingSince ?? last
	return {
		kind: input.kind,
		id: input.id,
		label: input.label,
		...(input.where !== undefined ? { where: input.where } : {}),
		verdict,
		idleSeconds: seconds(idle),
		ageSeconds: seconds(now - input.startedAt),
		...(waitingOn !== undefined ? { waitingOn, waitingSeconds: seconds(now - waitingSince) } : {}),
	}
}

/** `45s`, `3m 05s`, `1h 02m`: short, for a line a person or the model reads. */
export function formatLivenessAge(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds))
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const LABEL_MAX = 80
const WHERE_MAX = 120

/**
 * One line per item, the same for the note and for the list reads:
 * `job b1a2 "npm test" - progressing - last progress 4s ago - at: compiling`.
 * Everything free-form is clipped and flattened; the line carries data, not
 * instructions.
 */
export function formatLivenessLine(item: Liveness): string {
	const parts = [`${item.kind} ${item.id} "${oneLine(item.label, LABEL_MAX)}"`]
	if (item.verdict === 'waiting' && item.waitingOn !== undefined) {
		parts.push(
			`waiting on ${oneLine(item.waitingOn, LABEL_MAX)} for ${formatLivenessAge(item.waitingSeconds ?? item.idleSeconds)}`,
		)
	} else if (item.verdict === 'finished') {
		parts.push(`finished after ${formatLivenessAge(item.ageSeconds)}`)
	} else if (item.verdict === 'dead') {
		parts.push(
			`dead: gone without a result after ${formatLivenessAge(item.ageSeconds)}, last progress ${formatLivenessAge(item.idleSeconds)} ago`,
		)
	} else {
		parts.push(item.verdict)
		parts.push(
			item.idleSeconds === 0
				? 'last progress just now'
				: `last progress ${formatLivenessAge(item.idleSeconds)} ago`,
		)
	}
	if (item.where !== undefined && item.where.length > 0)
		parts.push(`at: ${oneLine(item.where, WHERE_MAX)}`)
	return parts.join(' - ')
}
