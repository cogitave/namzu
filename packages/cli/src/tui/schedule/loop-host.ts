/**
 * `/loop` and the `session_loop` tool: a prompt the open session re-sends to
 * itself on an interval.
 *
 * It fires only between turns. A loop that comes due while a turn runs fires
 * once when the session is idle again — never once per missed interval: the
 * session is the operator's, and a pile of queued prompts would take it over.
 * At most 20 loops, at least a minute apart, each expiring seven days after it
 * was made. They live in `<session-id>/loops.json` beside the session log and
 * come back with `/resume` (expired ones do not). A loop the model made says
 * so wherever it is shown.
 *
 * A loop made without an interval is self-paced: it ticks at once, the model
 * says each time (`wake_up`) when the next tick is, a minute to an hour away, and why,
 * and a tick that names no next wake-up ends the loop. Runs of quiet ticks print
 * nothing of their own.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
	type ScheduleSpec,
	type SelfPacedHost,
	type SessionLoop,
	type SessionLoopHost,
	clampWakeUpDelay,
	describeSchedule,
	hostTimeZone,
	nextFireTime,
	parseScheduleSpec,
} from '@namzu/sdk'
import { writeJsonAtomic } from '../../schedule/store/atomic.js'

export const MAX_LOOPS = 20
export const LOOP_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

interface StoredLoop extends SessionLoop {
	/** Absent on a self-paced loop. */
	readonly spec?: ScheduleSpec
	readonly pending?: boolean
}

interface LoopsFile {
	readonly v: 1
	readonly kind: 'session-loops'
	readonly loops: readonly StoredLoop[]
}

export interface LoopHostDeps {
	/** `<session-id>/loops.json` of the conversation on screen, or undefined before there is one. */
	readonly file: () => string | undefined
	/** No turn is running and nothing waits for an answer. */
	readonly isIdle: () => boolean
	/** Send the loop's prompt as the next turn. */
	readonly fire: (loop: SessionLoop) => void
	readonly now?: () => number
	/** A line for the transcript: where a self-paced loop wakes next, or that it ended. */
	readonly say?: (text: string) => void
}

/** `5m`, `every 1h`, or five-field cron, as a spec. */
export function loopSpec(interval: string, now: Date): ScheduleSpec {
	const text = interval.trim()
	if (/^\d+\s*[a-z]+$/i.test(text))
		return parseScheduleSpec(`every ${text}`, { now, tz: hostTimeZone() })
	return parseScheduleSpec(text, { now, tz: hostTimeZone() })
}

export class SessionLoopScheduler implements SessionLoopHost, SelfPacedHost {
	readonly #deps: LoopHostDeps
	#file: string | undefined
	#loops: StoredLoop[] = []

	constructor(deps: LoopHostDeps) {
		this.#deps = deps
	}

	#now(): number {
		return (this.#deps.now ?? Date.now)()
	}

	/** Follow the conversation on screen: load its loops when it changes. */
	#sync(): void {
		const file = this.#deps.file()
		if (file === this.#file) return
		// Loops made before the conversation had a log belong to it once it does.
		const carried = this.#file === undefined ? this.#loops : []
		this.#file = file
		this.#loops = []
		if (!file) return
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf8')) as LoopsFile
			if (parsed.kind === 'session-loops' && Array.isArray(parsed.loops)) {
				const now = this.#now()
				this.#loops = parsed.loops
					.filter(
						(l) =>
							(!l.expiresAt || Date.parse(l.expiresAt) > now) &&
							// A one-shot whose time passed is not restored.
							!(l.spec?.kind === 'at' && Date.parse(l.spec.at) <= now),
					)
					// A tick that was running when Namzu closed is simply due again.
					.map((l) =>
						l.paced?.awaitingWakeUp ? { ...l, paced: { quietTicks: l.paced.quietTicks } } : l,
					)
			}
		} catch {}
		if (carried.length > 0) {
			this.#loops = [...this.#loops, ...carried].slice(0, MAX_LOOPS)
			this.#save()
		}
	}

	#save(): void {
		if (!this.#file) return
		try {
			writeJsonAtomic(this.#file, {
				v: 1,
				kind: 'session-loops',
				loops: this.#loops,
			} satisfies LoopsFile)
		} catch {}
	}

	async create(request: {
		readonly interval?: string
		readonly prompt: string
		readonly createdBy: 'model' | 'operator'
	}): Promise<SessionLoop> {
		// Before the conversation has a log the loop is held here, and saved
		// beside the log once the first turn creates it.
		this.#sync()
		if (this.#loops.length >= MAX_LOOPS)
			throw new Error(`A conversation holds at most ${MAX_LOOPS} loops.`)
		const now = new Date(this.#now())
		const spec = request.interval === undefined ? undefined : loopSpec(request.interval, now)
		const loop: StoredLoop = {
			id: randomBytes(3).toString('hex'),
			schedule: spec ? describeSchedule(spec, { tz: hostTimeZone() }) : 'self-paced',
			prompt: request.prompt,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + LOOP_LIFETIME_MS).toISOString(),
			createdBy: request.createdBy,
			...(spec ? { spec } : { paced: { quietTicks: 0 } }),
		}
		this.#loops.push(loop)
		this.#save()
		return loop
	}

	list(): readonly SessionLoop[] {
		this.#sync()
		return this.#loops
	}

	async delete(id: string): Promise<number> {
		this.#sync()
		const before = this.#loops.length
		this.#loops = id === 'all' ? [] : this.#loops.filter((l) => l.id !== id)
		this.#save()
		return before - this.#loops.length
	}

	/**
	 * Fire what is due, when idle. Called on a timer and when a turn ends
	 * (`turnEnded`): a self-paced loop whose tick ended without choosing a next
	 * wake-up is over.
	 */
	tick(options: { readonly turnEnded?: boolean } = {}): void {
		this.#sync()
		const now = this.#now()
		let changed = false
		const kept: StoredLoop[] = []
		let fired = false
		for (const loop of this.#loops) {
			if (loop.expiresAt && Date.parse(loop.expiresAt) <= now) {
				changed = true
				if (loop.paced) this.#deps.say?.(`↻ Loop ${loop.id} ended: it reached its 7 days.`)
				continue
			}
			if (loop.paced?.awaitingWakeUp) {
				if (options.turnEnded && this.#deps.isIdle()) {
					changed = true
					this.#deps.say?.(
						`↻ Loop ${loop.id} ended: the tick finished without choosing a next wake-up.`,
					)
					continue
				}
				kept.push(loop)
				continue
			}
			let isDue = loop.pending === true
			if (loop.paced) {
				isDue = isDue || loop.paced.dueAt === undefined || Date.parse(loop.paced.dueAt) <= now
			} else if (loop.spec) {
				const last = Date.parse(loop.lastFiredAt ?? loop.createdAt)
				const due = nextFireTime(loop.spec, new Date(last))
				isDue = isDue || (due !== null && due.getTime() <= now)
			}
			if (!isDue) {
				kept.push(loop)
				continue
			}
			if (fired || !this.#deps.isIdle()) {
				// Once, when the session is idle again — not once per missed interval.
				if (!loop.pending) changed = true
				kept.push({ ...loop, pending: true })
				continue
			}
			fired = true
			changed = true
			const { pending: _pending, ...rest } = loop
			if (loop.paced) {
				const { dueAt: _due, ...pace } = loop.paced
				kept.push({
					...rest,
					lastFiredAt: new Date(now).toISOString(),
					paced: { ...pace, awaitingWakeUp: true },
				})
			} else if (loop.spec?.kind !== 'at') {
				kept.push({ ...rest, lastFiredAt: new Date(now).toISOString() })
			}
			this.#deps.fire(loop)
		}
		this.#loops = kept
		if (changed) this.#save()
	}

	wakeUp(request: {
		readonly delaySeconds: number
		readonly reason: string
		readonly quiet: boolean
	}): { readonly dueAt: string; readonly delaySeconds: number; readonly clamped: boolean } {
		this.#sync()
		const now = this.#now()
		const loop = this.#loops.find((l) => l.paced?.awaitingWakeUp)
		if (!loop?.paced) throw new Error('No self-paced loop is waiting for a wake-up.')
		if (loop.expiresAt && Date.parse(loop.expiresAt) <= now) {
			this.#loops = this.#loops.filter((l) => l !== loop)
			this.#save()
			throw new Error(
				'Wake-up not scheduled. The loop reached its maximum duration and has ended; do not start it again.',
			)
		}
		const { seconds, clamped } = clampWakeUpDelay(request.delaySeconds)
		const dueAt = new Date(now + seconds * 1000).toISOString()
		const quietTicks = request.quiet ? loop.paced.quietTicks + 1 : 0
		const reason = request.reason.replace(/\s+/g, ' ').trim().slice(0, 200)
		this.#loops = this.#loops.map((l) =>
			l === loop ? { ...l, paced: { dueAt, reason, quietTicks } } : l,
		)
		this.#save()
		// A run of quiet ticks says nothing of its own: the first one, and the tick
		// that breaks the run, do.
		if (quietTicks <= 1)
			this.#deps.say?.(
				`↻ Loop ${loop.id} wakes again at ${clockText(dueAt)} (${untilText(seconds)}): ${reason}${quietTicks === 1 ? ' (quiet)' : loop.paced.quietTicks > 1 ? ` (after ${loop.paced.quietTicks} quiet ticks)` : ''}`,
			)
		return { dueAt, delaySeconds: seconds, clamped }
	}

	stop(): number {
		this.#sync()
		const waiting = this.#loops.filter((l) => l.paced?.awaitingWakeUp)
		const ending = waiting.length > 0 ? waiting : this.#loops.filter((l) => l.paced)
		if (ending.length === 0) return 0
		this.#loops = this.#loops.filter((l) => !ending.includes(l))
		this.#save()
		for (const l of ending) this.#deps.say?.(`↻ Loop ${l.id} ended: the model stopped it.`)
		return ending.length
	}
}

function clockText(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function untilText(seconds: number): string {
	return seconds < 3600 ? `in ${Math.round(seconds / 60)} min` : 'in 1 hour'
}

/**
 * What a self-paced loop sends on each tick: the task, and the rules for
 * choosing the next wake-up.
 */
export function pacedTickPrompt(loop: SessionLoop): string {
	return [
		`This is a tick of loop ${loop.id}, which you pace yourself (it has no fixed interval).`,
		`The loop's task: ${loop.prompt}`,
		'Do the task now. Then, before you end this turn, call wake_up with delay_seconds (60 to 3600; for idle checks prefer 1200 to 1800), a one-sentence reason, and quiet true if nothing changed this tick (false if something happened). If the task is finished or cannot make progress, call wake_up with stop true. If you do not call wake_up, the loop ends after this turn.',
	].join('\n')
}

/** Whether a self-paced loop's last tick found nothing, for the line printed when it fires. */
export function pacedLoopWasQuiet(loop: SessionLoop): boolean {
	return (loop.paced?.quietTicks ?? 0) > 0
}

/** One line per loop, for `/loop list`. */
export function describeLoops(loops: readonly SessionLoop[]): string {
	if (loops.length === 0) return 'No loops in this conversation. /loop 5m <prompt> adds one.'
	return loops
		.map(
			(l) =>
				`↻ ${l.id}  ${describeLoopSchedule(l)}${l.createdBy === 'model' ? '  (created by the model)' : ''}${l.lastFiredAt ? `  last ${new Date(l.lastFiredAt).toLocaleTimeString()}` : ''}\n    ${l.prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
		)
		.join('\n')
}

function describeLoopSchedule(l: SessionLoop): string {
	if (!l.paced) return l.schedule
	const next = l.paced.awaitingWakeUp
		? 'a tick is running'
		: l.paced.dueAt
			? `next wake-up ${clockText(l.paced.dueAt)}${l.paced.reason ? `, ${l.paced.reason}` : ''}`
			: 'first tick due'
	const quiet = l.paced.quietTicks > 1 ? `, ${l.paced.quietTicks} quiet ticks in a row` : ''
	return `self-paced, ${next}${quiet}`
}
