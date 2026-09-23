import { describe, expect, it } from 'vitest'
import { evaluateJob } from '../evaluate.js'
import type { ScheduleEvaluationInput, ScheduleEvaluationJob, ScheduleSpec } from '../types.js'

const daily: ScheduleSpec = { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }

function job(spec: ScheduleSpec, over: Partial<ScheduleEvaluationJob> = {}): ScheduleEvaluationJob {
	return {
		spec,
		state: 'active',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		revision: 1,
		...over,
	}
}

function input(
	j: ScheduleEvaluationJob,
	lastEvaluatedAt: string,
	now: string,
	over: Partial<ScheduleEvaluationInput> = {},
): ScheduleEvaluationInput {
	return {
		job: j,
		state: { lastEvaluatedAt, jobRevision: j.revision },
		now: new Date(now),
		daemon: { startedAt: new Date('2026-01-01T00:00:00Z') },
		...over,
	}
}

describe('evaluateJob', () => {
	it('fires on time, a little late, and late', () => {
		const onTime = evaluateJob(input(job(daily), '2026-09-23T02:59:30Z', '2026-09-23T03:00:03Z'))
		expect(onTime.fire).toMatchObject({
			trigger: 'scheduled',
			key: String(Date.parse('2026-09-23T03:00:00Z')),
		})
		const late = evaluateJob(input(job(daily), '2026-09-23T02:59:30Z', '2026-09-23T03:01:30Z'))
		expect(late.fire?.trigger).toBe('late')
		expect(late.missed).toBeUndefined()
		expect(late.nextState.nextFireAt?.toISOString()).toBe('2026-09-24T03:00:00.000Z')
	})

	it('down six days: one catch-up for the latest and one missed record of five', () => {
		const d = evaluateJob(
			input(job(daily), '2026-09-17T04:00:00Z', '2026-09-23T10:00:00Z', {
				daemon: { startedAt: new Date('2026-09-23T09:59:00Z') },
			}),
		)
		expect(d.fire).toMatchObject({ trigger: 'catch-up' })
		expect(d.fire?.scheduledFor.toISOString()).toBe('2026-09-23T03:00:00.000Z')
		expect(d.missed).toMatchObject({ count: 5, reason: 'daemon-not-running', capped: false })
		expect(d.missed?.from.toISOString()).toBe('2026-09-18T03:00:00.000Z')
		expect(d.missed?.to.toISOString()).toBe('2026-09-22T03:00:00.000Z')
	})

	it('down nine days: catch-up for the latest, missed eight; an occurrence older than the window does not run', () => {
		const d = evaluateJob(input(job(daily), '2026-09-14T04:00:00Z', '2026-09-23T10:00:00Z'))
		expect(d.fire?.trigger).toBe('catch-up')
		expect(d.missed?.count).toBe(8)
		// Monthly on the 22nd, evaluated eight days later: older than the window.
		const monthly: ScheduleSpec = { kind: 'cron', expr: '0 3 22 * *', tz: 'UTC' }
		const w2 = evaluateJob(input(job(monthly), '2026-09-14T00:00:00Z', '2026-09-30T04:00:00Z'))
		expect(w2.fire).toBeUndefined()
		expect(w2.skip).toEqual([expect.objectContaining({ reason: 'beyond-catch-up-window' })])
		expect(w2.missed?.count).toBe(1)
	})

	it('one-shot missed by two days catches up and completes; by eight days it expires', () => {
		const once: ScheduleSpec = { kind: 'at', at: '2026-09-21T09:00:00.000Z' }
		const a = evaluateJob(input(job(once), '2026-09-21T08:00:00Z', '2026-09-23T09:00:00Z'))
		expect(a.fire?.trigger).toBe('catch-up')
		expect(a.jobTransition).toBe('completed')
		const b = evaluateJob(input(job(once), '2026-09-21T08:00:00Z', '2026-09-29T10:00:00Z'))
		expect(b.fire).toBeUndefined()
		expect(b.skip[0]?.reason).toBe('one-shot-expired')
		expect(b.jobTransition).toBe('expired')
	})

	it('paused across three occurrences: one collapsed skip, no catch-up', () => {
		const d = evaluateJob(
			input(job(daily, { state: 'paused' }), '2026-09-20T04:00:00Z', '2026-09-23T10:00:00Z'),
		)
		expect(d.fire).toBeUndefined()
		expect(d.skip).toEqual([expect.objectContaining({ reason: 'paused', count: 3 })])
		expect(d.nextState.lastEvaluatedAt.toISOString()).toBe('2026-09-23T10:00:00.000Z')
	})

	it('a job awaiting confirmation never fires', () => {
		const d = evaluateJob(
			input(
				job(daily, { state: 'pending-confirmation' }),
				'2026-09-22T04:00:00Z',
				'2026-09-23T03:00:10Z',
			),
		)
		expect(d.fire).toBeUndefined()
		expect(d.skip[0]?.reason).toBe('awaiting-confirmation')
	})

	it('an unfinished previous run skips; a parked one says so', () => {
		const base = input(job(daily), '2026-09-23T02:00:00Z', '2026-09-23T03:00:05Z')
		expect(
			evaluateJob({ ...base, state: { ...base.state, activeRun: { status: 'running' } } }).skip[0]
				?.reason,
		).toBe('previous-run-active')
		expect(
			evaluateJob({ ...base, state: { ...base.state, activeRun: { status: 'awaiting-approval' } } })
				.skip[0]?.reason,
		).toBe('previous-run-awaiting-approval')
		expect(
			evaluateJob({ ...base, state: { ...base.state, activeRun: { status: 'queued' } } }).skip[0]
				?.reason,
		).toBe('previous-run-active')
	})

	it('a backward clock jump re-fires nothing and never moves lastEvaluatedAt back', () => {
		const d = evaluateJob(input(job(daily), '2026-09-23T03:00:10Z', '2026-09-23T01:00:00Z'))
		expect(d.fire).toBeUndefined()
		expect(d.nextState.lastEvaluatedAt.toISOString()).toBe('2026-09-23T03:00:10.000Z')
		// A claimed key is not fired again even if re-evaluated.
		const again = evaluateJob(
			input(job(daily), '2026-09-23T02:00:00Z', '2026-09-23T03:00:05Z', { isClaimed: () => true }),
		)
		expect(again.fire).toBeUndefined()
	})

	it('a forward jump of three hours on an hourly job: one catch-up and two missed, reason from the observed gap', () => {
		const hourly: ScheduleSpec = { kind: 'cron', expr: '0 * * * *', tz: 'UTC' }
		const d = evaluateJob(
			input(job(hourly), '2026-09-23T10:00:30Z', '2026-09-23T13:30:00Z', {
				daemon: {
					startedAt: new Date('2026-09-23T09:00:00Z'),
					observedGap: {
						from: new Date('2026-09-23T10:00:30Z'),
						to: new Date('2026-09-23T13:30:00Z'),
						kind: 'clock-forward',
					},
				},
			}),
		)
		expect(d.fire?.trigger).toBe('catch-up')
		expect(d.missed).toMatchObject({ count: 2, reason: 'clock-jumped-forward' })
		const asleep = evaluateJob(
			input(job(hourly), '2026-09-23T10:00:30Z', '2026-09-23T13:30:00Z', {
				daemon: {
					startedAt: new Date('2026-09-23T09:00:00Z'),
					observedGap: {
						from: new Date('2026-09-23T10:00:30Z'),
						to: new Date('2026-09-23T13:30:00Z'),
						kind: 'asleep',
					},
				},
			}),
		)
		expect(asleep.missed?.reason).toBe('machine-asleep')
	})

	it('every 1m after a seven-day gap: one catch-up, missed 10 079, one record', () => {
		const spec: ScheduleSpec = {
			kind: 'every',
			everyMs: 60_000,
			anchorAt: '2026-09-01T00:00:00.000Z',
		}
		const d = evaluateJob(input(job(spec), '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'))
		expect(d.fire?.trigger).toBe('scheduled')
		expect(d.missed?.count).toBe(10_079)
	})

	it('an edited schedule does not catch up times the old schedule owned', () => {
		const edited = job(
			{ kind: 'cron', expr: '0 4 * * *', tz: 'UTC' },
			{
				revision: 2,
				updatedAt: '2026-09-23T10:00:00.000Z',
			},
		)
		const d = evaluateJob({
			job: edited,
			state: { lastEvaluatedAt: '2026-09-20T05:00:00.000Z', jobRevision: 1 },
			now: new Date('2026-09-23T10:00:05Z'),
			daemon: { startedAt: new Date('2026-09-20T00:00:00Z') },
		})
		expect(d.fire).toBeUndefined()
		expect(d.missed).toBeUndefined()
		expect(d.nextState.jobRevision).toBe(2)
		expect(d.nextState.nextFireAt?.toISOString()).toBe('2026-09-24T04:00:00.000Z')
	})

	it('a quota hold skips until it ends', () => {
		const base = input(job(daily), '2026-09-23T02:00:00Z', '2026-09-23T03:00:05Z')
		const held = evaluateJob({
			...base,
			state: { ...base.state, quotaHoldUntil: '2026-09-23T04:00:00Z' },
		})
		expect(held.fire).toBeUndefined()
		expect(held.skip[0]?.reason).toBe('quota-hold')
		const released = evaluateJob({
			...base,
			state: { ...base.state, quotaHoldUntil: '2026-09-23T02:30:00Z' },
		})
		expect(released.fire?.trigger).toBe('scheduled')
	})

	it('a new job counts from its creation, and a finished job decides nothing', () => {
		const fresh = job(daily, {
			createdAt: '2026-09-23T03:30:00.000Z',
			updatedAt: '2026-09-23T03:30:00.000Z',
		})
		const d = evaluateJob({
			job: fresh,
			state: {},
			now: new Date('2026-09-23T10:00:00Z'),
			daemon: { startedAt: new Date('2026-09-23T00:00:00Z') },
		})
		expect(d.fire).toBeUndefined()
		expect(
			evaluateJob(
				input(job(daily, { state: 'completed' }), '2026-09-01T00:00:00Z', '2026-09-23T10:00:00Z'),
			).fire,
		).toBeUndefined()
		const expiredOnce = evaluateJob(
			input(
				job({ kind: 'at', at: '2026-09-01T00:00:00.000Z' }, { state: 'paused' }),
				'2026-09-02T00:00:00Z',
				'2026-09-23T00:00:00Z',
			),
		)
		expect(expiredOnce.jobTransition).toBe('expired')
	})
})
