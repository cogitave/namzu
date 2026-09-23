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
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
	type ScheduleSpec,
	type SessionLoop,
	type SessionLoopHost,
	describeSchedule,
	hostTimeZone,
	nextFireTime,
	parseScheduleSpec,
} from '@namzu/sdk'
import { writeJsonAtomic } from '../../schedule/store/atomic.js'

export const MAX_LOOPS = 20
export const LOOP_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

interface StoredLoop extends SessionLoop {
	readonly spec: ScheduleSpec
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
}

/** `5m`, `every 1h`, or five-field cron, as a spec. */
export function loopSpec(interval: string, now: Date): ScheduleSpec {
	const text = interval.trim()
	if (/^\d+\s*[a-z]+$/i.test(text))
		return parseScheduleSpec(`every ${text}`, { now, tz: hostTimeZone() })
	return parseScheduleSpec(text, { now, tz: hostTimeZone() })
}

export class SessionLoopScheduler implements SessionLoopHost {
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
				this.#loops = parsed.loops.filter(
					(l) =>
						(!l.expiresAt || Date.parse(l.expiresAt) > now) &&
						// A one-shot whose time passed is not restored.
						!(l.spec.kind === 'at' && Date.parse(l.spec.at) <= now),
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
		readonly interval: string
		readonly prompt: string
		readonly createdBy: 'model' | 'operator'
	}): Promise<SessionLoop> {
		// Before the conversation has a log the loop is held here, and saved
		// beside the log once the first turn creates it.
		this.#sync()
		if (this.#loops.length >= MAX_LOOPS)
			throw new Error(`A session holds at most ${MAX_LOOPS} loops.`)
		const now = new Date(this.#now())
		const spec = loopSpec(request.interval, now)
		const loop: StoredLoop = {
			id: randomBytes(3).toString('hex'),
			schedule: describeSchedule(spec, { tz: hostTimeZone() }),
			prompt: request.prompt,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + LOOP_LIFETIME_MS).toISOString(),
			createdBy: request.createdBy,
			spec,
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

	/** Fire what is due, when idle. Called on a timer and when a turn ends. */
	tick(): void {
		this.#sync()
		const now = this.#now()
		let changed = false
		const kept: StoredLoop[] = []
		let fired = false
		for (const loop of this.#loops) {
			if (loop.expiresAt && Date.parse(loop.expiresAt) <= now) {
				changed = true
				continue
			}
			const last = Date.parse(loop.lastFiredAt ?? loop.createdAt)
			const due = nextFireTime(loop.spec, new Date(last))
			const isDue = loop.pending || (due !== null && due.getTime() <= now)
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
			const done = loop.spec.kind === 'at'
			const { pending: _pending, ...rest } = loop
			if (!done) kept.push({ ...rest, lastFiredAt: new Date(now).toISOString() })
			this.#deps.fire(loop)
		}
		this.#loops = kept
		if (changed) this.#save()
	}
}

/** One line per loop, for `/loop list`. */
export function describeLoops(loops: readonly SessionLoop[]): string {
	if (loops.length === 0) return 'No loops in this conversation. /loop 5m <prompt> adds one.'
	return loops
		.map(
			(l) =>
				`↻ ${l.id}  ${l.schedule}${l.createdBy === 'model' ? '  (created by the model)' : ''}${l.lastFiredAt ? `  last ${new Date(l.lastFiredAt).toLocaleTimeString()}` : ''}\n    ${l.prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
		)
		.join('\n')
}
