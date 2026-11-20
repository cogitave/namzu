/**
 * The `timer_set` tool: a prompt the model sets to fire into THIS conversation,
 * once or on a schedule, while the session is open.
 *
 * Kept in memory only. Nothing is written beside the session log or to the
 * durable schedule store, so a timer dies with the session (and with a switch
 * to another conversation). It fires only when the conversation is idle: one
 * that comes due during a turn waits, and fires once when the turn is over,
 * never once per missed time. At most 50 timers; a recurring one ends after
 * seven days. Firing times are nudged a little so many timers set for :00 and
 * :30 do not all land together: a recurring timer may run late by up to half its
 * interval (never more than 30 minutes), a one-shot set for :00 or :30 may run up
 * to 90 seconds early.
 */

import { randomBytes } from 'node:crypto'
import {
	type ScheduleSpec,
	type SessionTimer,
	type SessionTimerHost,
	describeSchedule,
	hostTimeZone,
	nextFireTime,
	parseScheduleSpec,
} from '@namzu/sdk'

export const MAX_TIMERS = 50
export const TIMER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const RECURRING_JITTER_FRACTION = 0.5
const RECURRING_JITTER_CAP_MS = 30 * 60 * 1000
const ONE_SHOT_EARLY_MS = 90 * 1000

interface Entry {
	readonly id: string
	readonly spec: ScheduleSpec
	readonly prompt: string
	readonly recurring: boolean
	readonly createdAt: number
	readonly expiresAt?: number
	/** 0 up to but not including 1, fixed per timer so a timer is always nudged the same way. */
	readonly jitter: number
	nextAt: number
	lastFiredAt?: number
	pending?: boolean
}

export interface TimerHostDeps {
	/** No turn is running and nothing waits for an answer. */
	readonly isIdle: () => boolean
	/** Send the timer's prompt as the next turn. */
	readonly fire: (timer: SessionTimer) => void
	/** The conversation on screen; timers belong to the one they were set in. */
	readonly sessionId?: () => string | undefined
	readonly now?: () => number
}

/** `when` as a spec: `10m`, `every 10m`, `in 10m`, `at 14:30`, or five-field cron. */
export function timerSpec(when: string, recurring: boolean, now: Date): ScheduleSpec {
	const text = when.trim()
	const tz = hostTimeZone()
	if (/^\d+\s*[a-z]+$/i.test(text))
		return parseScheduleSpec(recurring ? `every ${text}` : `in ${text}`, { now, tz })
	if (!recurring && /^every\s/i.test(text))
		return parseScheduleSpec(`in ${text.slice(6).trim()}`, { now, tz })
	return parseScheduleSpec(text, { now, tz })
}

/** The nudge for a fire at `target`, in ms: positive is later, negative earlier. */
export function timerJitterMs(
	spec: ScheduleSpec,
	recurring: boolean,
	jitter: number,
	target: number,
	periodMs: number,
	floorMs: number,
): number {
	if (spec.kind === 'at' || !recurring) {
		if (new Date(target).getMinutes() % 30 !== 0) return 0
		return -Math.min(Math.round(jitter * ONE_SHOT_EARLY_MS), Math.max(0, target - floorMs))
	}
	return Math.round(
		Math.min(jitter * RECURRING_JITTER_FRACTION * periodMs, RECURRING_JITTER_CAP_MS),
	)
}

export class SessionTimerScheduler implements SessionTimerHost {
	readonly #deps: TimerHostDeps
	#timers: Entry[] = []
	#session: string | undefined

	constructor(deps: TimerHostDeps) {
		this.#deps = deps
	}

	#now(): number {
		return (this.#deps.now ?? Date.now)()
	}

	/** Timers belong to the conversation they were set in: another one starts empty. */
	#sync(): void {
		const session = this.#deps.sessionId?.()
		if (session === this.#session) return
		if (this.#session !== undefined && session !== undefined) this.#timers = []
		this.#session = session
	}

	#plan(
		spec: ScheduleSpec,
		recurring: boolean,
		jitter: number,
		after: number,
		floor: number,
	): number | null {
		const first = nextFireTime(spec, new Date(after))
		if (!first) return null
		const second = recurring && spec.kind !== 'at' ? nextFireTime(spec, first) : null
		const period = second ? second.getTime() - first.getTime() : 0
		return first.getTime() + timerJitterMs(spec, recurring, jitter, first.getTime(), period, floor)
	}

	#view(e: Entry): SessionTimer {
		return {
			id: e.id,
			schedule: describeSchedule(e.spec, { tz: hostTimeZone() }),
			prompt: e.prompt,
			recurring: e.recurring,
			createdAt: new Date(e.createdAt).toISOString(),
			...(e.expiresAt ? { expiresAt: new Date(e.expiresAt).toISOString() } : {}),
			nextFireAt: new Date(e.nextAt).toISOString(),
			...(e.lastFiredAt ? { lastFiredAt: new Date(e.lastFiredAt).toISOString() } : {}),
		}
	}

	async create(request: {
		readonly when: string
		readonly prompt: string
		readonly recurring: boolean
	}): Promise<SessionTimer> {
		this.#sync()
		if (this.#timers.length >= MAX_TIMERS)
			throw new Error(`Too many timers (max ${MAX_TIMERS}). Cancel one first.`)
		const now = this.#now()
		const spec = timerSpec(request.when, request.recurring, new Date(now))
		const recurring = request.recurring && spec.kind !== 'at'
		const id = randomBytes(3).toString('hex')
		const jitter = Number.parseInt(id, 16) / 0x1000000
		const nextAt = this.#plan(spec, recurring, jitter, now, now)
		if (nextAt === null) throw new Error(`"${request.when}" does not fire again.`)
		const entry: Entry = {
			id,
			spec,
			prompt: request.prompt,
			recurring,
			createdAt: now,
			...(recurring ? { expiresAt: now + TIMER_LIFETIME_MS } : {}),
			jitter,
			nextAt,
		}
		this.#timers.push(entry)
		return this.#view(entry)
	}

	list(): readonly SessionTimer[] {
		this.#sync()
		return this.#timers.map((e) => this.#view(e))
	}

	async cancel(id: string): Promise<boolean> {
		this.#sync()
		const before = this.#timers.length
		this.#timers = this.#timers.filter((e) => e.id !== id)
		return this.#timers.length < before
	}

	/** Forget every timer: the session is over. */
	clear(): void {
		this.#timers = []
	}

	/** Fire what is due, one timer per idle moment. Called on a timer and when a turn ends. */
	tick(): void {
		this.#sync()
		const now = this.#now()
		const kept: Entry[] = []
		let fired = false
		for (const timer of this.#timers) {
			if (timer.expiresAt !== undefined && timer.expiresAt <= now) continue
			if (!timer.pending && timer.nextAt > now) {
				kept.push(timer)
				continue
			}
			if (fired || !this.#deps.isIdle()) {
				// Queued behind the running turn: once, when it is over.
				timer.pending = true
				kept.push(timer)
				continue
			}
			fired = true
			timer.pending = false
			timer.lastFiredAt = now
			if (timer.recurring) {
				const next = this.#plan(timer.spec, true, timer.jitter, now, now)
				if (next !== null) {
					timer.nextAt = next
					kept.push(timer)
				}
			}
			this.#deps.fire(this.#view(timer))
		}
		this.#timers = kept
	}
}
