/**
 * The timers the model sets (`timer_set`) and the self-paced loop it paces
 * (`wake_up`): firing, queueing behind a turn, the delay clamp, expiry,
 * cancel, the end of a session, and what the person is told.
 *
 * Time is a clock the test moves; nothing here waits on the real one.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoop, SessionTimer } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLoopCommand } from './host-commands.js'
import { createScheduleIntegration } from './integration.js'
import {
	LOOP_LIFETIME_MS,
	SessionLoopScheduler,
	describeLoops,
	pacedTickPrompt,
} from './loop-host.js'
import {
	MAX_TIMERS,
	SessionTimerScheduler,
	TIMER_LIFETIME_MS,
	timerJitterMs,
	timerSpec,
} from './timer-host.js'

const START = Date.parse('2026-11-20T10:07:00.000Z')
const MIN = 60_000

function clock() {
	let t = START
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms
		},
	}
}

describe('session timers', () => {
	it('fires a one-shot once, when due and idle, then forgets it', async () => {
		const c = clock()
		const fired: SessionTimer[] = []
		const timers = new SessionTimerScheduler({
			isIdle: () => true,
			fire: (t) => fired.push(t),
			now: c.now,
		})
		const made = await timers.create({ when: '10m', prompt: 'check the build', recurring: false })
		expect(made.recurring).toBe(false)
		c.advance(5 * MIN)
		timers.tick()
		expect(fired).toHaveLength(0)
		c.advance(6 * MIN)
		timers.tick()
		expect(fired.map((t) => t.prompt)).toEqual(['check the build'])
		expect(timers.list()).toEqual([])
		c.advance(60 * MIN)
		timers.tick()
		expect(fired).toHaveLength(1)
	})

	it('queues behind a running turn and fires once when it is over, not once per missed time', async () => {
		const c = clock()
		let idle = false
		const fired: SessionTimer[] = []
		const timers = new SessionTimerScheduler({
			isIdle: () => idle,
			fire: (t) => fired.push(t),
			now: c.now,
		})
		await timers.create({ when: '5m', prompt: 'ping', recurring: true })
		c.advance(40 * MIN)
		timers.tick()
		expect(fired).toHaveLength(0)
		idle = true
		timers.tick()
		expect(fired).toHaveLength(1)
		timers.tick()
		expect(fired).toHaveLength(1)
		// Still recurring, next time is in the future.
		expect(Date.parse(timers.list()[0]?.nextFireAt ?? '')).toBeGreaterThan(c.now())
	})

	it('fires one timer per idle moment', async () => {
		const c = clock()
		const fired: string[] = []
		const timers = new SessionTimerScheduler({
			isIdle: () => true,
			fire: (t) => fired.push(t.prompt),
			now: c.now,
		})
		await timers.create({ when: '2m', prompt: 'a', recurring: false })
		await timers.create({ when: '2m', prompt: 'b', recurring: false })
		c.advance(3 * MIN)
		timers.tick()
		expect(fired).toEqual(['a'])
		timers.tick()
		expect(fired).toEqual(['a', 'b'])
	})

	it('ends a recurring timer after seven days', async () => {
		const c = clock()
		const fired: SessionTimer[] = []
		const timers = new SessionTimerScheduler({
			isIdle: () => true,
			fire: (t) => fired.push(t),
			now: c.now,
		})
		const made = await timers.create({ when: '1h', prompt: 'x', recurring: true })
		expect(Date.parse(made.expiresAt ?? '') - START).toBe(TIMER_LIFETIME_MS)
		c.advance(TIMER_LIFETIME_MS + MIN)
		timers.tick()
		expect(fired).toHaveLength(0)
		expect(timers.list()).toEqual([])
	})

	it('holds at most 50 and says what to do', async () => {
		const c = clock()
		const timers = new SessionTimerScheduler({ isIdle: () => true, fire: () => {}, now: c.now })
		for (let i = 0; i < MAX_TIMERS; i++)
			await timers.create({ when: '1h', prompt: `p${i}`, recurring: true })
		await expect(
			timers.create({ when: '1h', prompt: 'one more', recurring: true }),
		).rejects.toThrow('Too many timers (max 50). Cancel one first.')
	})

	it('cancels by id and reports an unknown id', async () => {
		const c = clock()
		const timers = new SessionTimerScheduler({ isIdle: () => true, fire: () => {}, now: c.now })
		const made = await timers.create({ when: '1h', prompt: 'x', recurring: true })
		expect(await timers.cancel('nope')).toBe(false)
		expect(await timers.cancel(made.id)).toBe(true)
		expect(timers.list()).toEqual([])
	})

	it('starts empty in another conversation and is gone with the session', async () => {
		const c = clock()
		let session: string | undefined = 's1'
		const timers = new SessionTimerScheduler({
			isIdle: () => true,
			fire: () => {},
			sessionId: () => session,
			now: c.now,
		})
		await timers.create({ when: '1h', prompt: 'x', recurring: true })
		expect(timers.list()).toHaveLength(1)
		session = 's2'
		expect(timers.list()).toEqual([])
	})

	it('keeps a timer set before the conversation had an id', async () => {
		const c = clock()
		const current: { id: string | undefined } = { id: undefined }
		const timers = new SessionTimerScheduler({
			isIdle: () => true,
			fire: () => {},
			sessionId: () => current.id,
			now: c.now,
		})
		await timers.create({ when: '1h', prompt: 'x', recurring: true })
		current.id = 's1'
		expect(timers.list()).toHaveLength(1)
	})

	it('turns a bare interval into a repeat or a single wait', () => {
		const now = new Date(START)
		expect(timerSpec('10m', true, now).kind).toBe('every')
		expect(timerSpec('10m', false, now).kind).toBe('at')
		expect(timerSpec('every 10m', false, now).kind).toBe('at')
		expect(timerSpec('*/10 * * * *', true, now).kind).toBe('cron')
	})

	it('nudges a recurring timer late by at most half its interval and 30 minutes', () => {
		const every = {
			kind: 'every',
			everyMs: 10 * MIN,
			anchorAt: new Date(START).toISOString(),
		} as const
		expect(timerJitterMs(every, true, 0.5, START, 10 * MIN, START)).toBe(2.5 * MIN)
		expect(timerJitterMs(every, true, 0.99999, START, 24 * 60 * MIN, START)).toBe(30 * MIN)
		expect(timerJitterMs(every, true, 0, START, 10 * MIN, START)).toBe(0)
	})

	it('nudges a one-shot on :00 or :30 up to 90 seconds early, never before it was set, others not at all', () => {
		const at = { kind: 'at', at: new Date(START).toISOString() } as const
		const onHalfHour = new Date(START)
		onHalfHour.setMinutes(30, 0, 0)
		const target = onHalfHour.getTime()
		expect(timerJitterMs(at, false, 0.5, target, 0, 0)).toBe(-45_000)
		expect(timerJitterMs(at, false, 1, target, 0, target - 10_000)).toBe(-10_000)
		const other = new Date(target + 7 * MIN).getTime()
		expect(timerJitterMs(at, false, 0.5, other, 0, 0)).toBe(0)
	})
})

describe('self-paced loops', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-paced-'))
	})

	function host(c: ReturnType<typeof clock>, extra: { idle?: () => boolean } = {}) {
		const fired: SessionLoop[] = []
		const said: string[] = []
		const loops = new SessionLoopScheduler({
			file: () => join(dir, 'loops.json'),
			isIdle: extra.idle ?? (() => true),
			fire: (l) => fired.push(l),
			say: (t) => said.push(t),
			now: c.now,
		})
		return { loops, fired, said }
	}

	it('ticks at once, then waits for the delay the model chose, clamped to a minute..an hour', async () => {
		const c = clock()
		const { loops, fired } = host(c)
		const made = await loops.create({ prompt: 'watch the deploy', createdBy: 'model' })
		expect(made.paced).toEqual({ quietTicks: 0 })
		expect(made.schedule).toBe('self-paced')
		loops.tick()
		expect(fired).toHaveLength(1)
		const next = loops.wakeUp({ delaySeconds: 5, reason: 'checking soon', quiet: false })
		expect(next).toMatchObject({ delaySeconds: 60, clamped: true })
		c.advance(59_000)
		loops.tick()
		expect(fired).toHaveLength(1)
		c.advance(2_000)
		loops.tick()
		expect(fired).toHaveLength(2)
		expect(loops.wakeUp({ delaySeconds: 99_999, reason: 'long hold', quiet: false })).toMatchObject(
			{
				delaySeconds: 3600,
				clamped: true,
			},
		)
		expect(loops.wakeUp).toBeDefined()
	})

	it('treats a delay that is not a number as the shortest and infinity as the longest', async () => {
		const c = clock()
		const { loops } = host(c)
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		expect(loops.wakeUp({ delaySeconds: Number.NaN, reason: 'r', quiet: false }).delaySeconds).toBe(
			60,
		)
		c.advance(61_000)
		loops.tick()
		expect(
			loops.wakeUp({ delaySeconds: Number.POSITIVE_INFINITY, reason: 'r', quiet: false })
				.delaySeconds,
		).toBe(3600)
	})

	it('ends the loop when a tick finishes without a next wake-up', async () => {
		const c = clock()
		const { loops, fired, said } = host(c)
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		loops.tick()
		expect(loops.list()).toHaveLength(1)
		loops.tick({ turnEnded: true })
		expect(loops.list()).toEqual([])
		expect(fired).toHaveLength(1)
		expect(said.join('\n')).toContain('finished without choosing a next wake-up')
	})

	it('does not end a loop whose turn is still running', async () => {
		const c = clock()
		let idle = true
		const { loops } = host(c, { idle: () => idle })
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		idle = false
		loops.tick({ turnEnded: true })
		expect(loops.list()).toHaveLength(1)
	})

	it('waits behind a running turn and fires once when idle', async () => {
		const c = clock()
		let idle = true
		const { loops, fired } = host(c, { idle: () => idle })
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		loops.wakeUp({ delaySeconds: 60, reason: 'r', quiet: false })
		idle = false
		c.advance(10 * MIN)
		loops.tick()
		expect(fired).toHaveLength(1)
		idle = true
		loops.tick()
		expect(fired).toHaveLength(2)
	})

	it('stop ends the loop and says so; with nothing to stop it returns zero', async () => {
		const c = clock()
		const { loops, said } = host(c)
		expect(loops.stop()).toBe(0)
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		expect(loops.stop()).toBe(1)
		expect(loops.list()).toEqual([])
		expect(said.join('\n')).toContain('the model stopped it')
	})

	it('refuses a wake-up when no loop is waiting for one', () => {
		const { loops } = host(clock())
		expect(() => loops.wakeUp({ delaySeconds: 60, reason: 'r', quiet: false })).toThrow(
			'No self-paced loop is waiting for a wake-up.',
		)
	})

	it('ends at its maximum duration and tells the model not to restart it', async () => {
		const c = clock()
		const { loops } = host(c)
		await loops.create({ prompt: 'p', createdBy: 'model' })
		loops.tick()
		c.advance(LOOP_LIFETIME_MS + MIN)
		expect(() => loops.wakeUp({ delaySeconds: 60, reason: 'r', quiet: false })).toThrow(
			/maximum duration/,
		)
		expect(loops.list()).toEqual([])
	})

	it('folds a run of quiet ticks: only the first and the one that breaks the run print', async () => {
		const c = clock()
		const { loops, said } = host(c)
		await loops.create({ prompt: 'p', createdBy: 'model' })
		const tickAndWake = (quiet: boolean) => {
			c.advance(2 * MIN)
			loops.tick()
			loops.wakeUp({ delaySeconds: 60, reason: 'still waiting', quiet })
		}
		tickAndWake(true)
		tickAndWake(true)
		tickAndWake(true)
		tickAndWake(false)
		const wakes = said.filter((t) => t.includes('wakes again'))
		expect(wakes).toHaveLength(2)
		expect(wakes[0]).toContain('(quiet)')
		expect(wakes[1]).toContain('after 3 quiet ticks')
		expect(describeLoops(loops.list())).toContain('next wake-up')
	})

	it('comes back with /resume, a tick that was running due again', async () => {
		const c = clock()
		const a = host(c)
		await a.loops.create({ prompt: 'p', createdBy: 'model' })
		a.loops.tick()
		const saved = JSON.parse(readFileSync(join(dir, 'loops.json'), 'utf8'))
		expect(saved.loops[0].paced.awaitingWakeUp).toBe(true)
		const b = host(c)
		expect(b.loops.list()[0]?.paced).toEqual({ quietTicks: 0 })
		b.loops.tick()
		expect(b.fired).toHaveLength(1)
	})

	it('sends the task and the rules for choosing the next wake-up as plain text', async () => {
		const { loops } = host(clock())
		const made = await loops.create({ prompt: '/permissions auto', createdBy: 'operator' })
		const text = pacedTickPrompt(made)
		expect(text.startsWith('This is a tick of loop')).toBe(true)
		expect(text).toContain('wake_up')
		expect(text).toContain('If you do not call wake_up, the loop ends')
	})
})

describe('/loop without an interval', () => {
	it('makes a self-paced loop, and keeps an interval loop as it was', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-paced-'))
		const loops = new SessionLoopScheduler({
			file: () => join(dir, 'loops.json'),
			isIdle: () => true,
			fire: () => {},
		})
		const said: string[] = []
		await runLoopCommand(['watch', 'the', 'deploy'], loops, (t) => said.push(t))
		await runLoopCommand(['10m', 'check', 'CI'], loops, (t) => said.push(t))
		const [paced, fixed] = loops.list()
		expect(paced?.paced).toBeDefined()
		expect(paced?.prompt).toBe('watch the deploy')
		expect(fixed?.paced).toBeUndefined()
		expect(fixed?.prompt).toBe('check CI')
		expect(said[0]).toContain('self-paced')
	})
})

describe('the integration', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	function integration(idle: () => boolean) {
		const said: string[] = []
		const submitted: string[] = []
		const dir = mkdtempSync(join(tmpdir(), 'namzu-paced-'))
		const it = createScheduleIntegration({
			home: () => undefined,
			cwd: () => dir,
			extraRoots: () => [],
			config: () => ({ limits: {} }) as never,
			model: () => undefined,
			sessionId: () => 's1',
			sourceConversation: () => undefined,
			loopsFile: () => join(dir, 'loops.json'),
			isIdle: idle,
			say: (t) => said.push(t),
			ask: (() => Promise.reject(new Error('no'))) as never,
			askPermission: (() => Promise.reject(new Error('no'))) as never,
			submit: (text) => submitted.push(text),
		})
		return { it, said, submitted }
	}

	it('offers the timer tools and the wake-up tool next to the reviewed ones', () => {
		const { it } = integration(() => true)
		const names = it.tools().map((t) => t.name)
		expect(names).toEqual(
			expect.arrayContaining([
				'schedule',
				'session_loop',
				'timer_set',
				'timer_list',
				'timer_cancel',
				'wake_up',
			]),
		)
		it.dispose()
	})

	it('fires a due timer on the interval tick, tells the person what fired, and sends a plain prompt', async () => {
		const { it, said, submitted } = integration(() => true)
		await it.timers.create({ when: '2m', prompt: '/clear then check mail', recurring: false })
		await vi.advanceTimersByTimeAsync(3 * 60_000)
		expect(said.some((t) => t.startsWith('⏰ timer') && t.includes('set by the model'))).toBe(true)
		expect(submitted).toEqual(['/clear then check mail'])
		it.dispose()
	})

	it('waits while a turn runs and fires when the turn is over', async () => {
		let idle = false
		const { it, submitted } = integration(() => idle)
		await it.timers.create({ when: '2m', prompt: 'later', recurring: false })
		await vi.advanceTimersByTimeAsync(5 * 60_000)
		expect(submitted).toEqual([])
		idle = true
		it.tick({ turnEnded: true })
		expect(submitted).toEqual(['later'])
		it.dispose()
	})

	it('forgets its timers when the session closes', async () => {
		const { it, submitted } = integration(() => true)
		await it.timers.create({ when: '2m', prompt: 'x', recurring: true })
		expect(it.hasPending()).toBe(true)
		it.dispose()
		expect(it.timers.list()).toEqual([])
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(submitted).toEqual([])
	})
})
