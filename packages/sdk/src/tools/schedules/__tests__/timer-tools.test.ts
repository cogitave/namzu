import { describe, expect, it } from 'vitest'
import { buildSessionTimerTools, buildWakeUpTool, clampWakeUpDelay } from '../timer-tools.js'
import type { SelfPacedHost, SessionTimer, SessionTimerHost } from '../types.js'

const ctx = {} as never

describe('clampWakeUpDelay', () => {
	it('holds the delay between a minute and an hour', () => {
		expect(clampWakeUpDelay(30)).toEqual({ seconds: 60, clamped: true })
		expect(clampWakeUpDelay(1200)).toEqual({ seconds: 1200, clamped: false })
		expect(clampWakeUpDelay(1200.4)).toEqual({ seconds: 1200, clamped: false })
		expect(clampWakeUpDelay(7200)).toEqual({ seconds: 3600, clamped: true })
	})
	it('reads not-a-number and infinities as the nearest bound', () => {
		expect(clampWakeUpDelay(Number.NaN).seconds).toBe(60)
		expect(clampWakeUpDelay(Number.POSITIVE_INFINITY).seconds).toBe(3600)
		expect(clampWakeUpDelay(Number.NEGATIVE_INFINITY).seconds).toBe(60)
	})
})

function fakeTimers(): SessionTimerHost & { made: SessionTimer[] } {
	const made: SessionTimer[] = []
	return {
		made,
		async create(r) {
			if (r.when === 'bad') throw new Error('"bad" is not a schedule')
			const t: SessionTimer = {
				id: 'abc123',
				schedule: r.when,
				prompt: r.prompt,
				recurring: r.recurring,
				createdAt: '2026-11-20T10:00:00.000Z',
				nextFireAt: '2026-11-20T10:10:00.000Z',
			}
			made.push(t)
			return t
		},
		list: () => made,
		async cancel(id) {
			return id === 'abc123'
		},
	}
}

describe('timer tools', () => {
	it('need no review and only list is read-only', () => {
		const tools = buildSessionTimerTools(fakeTimers())
		expect(tools.map((t) => t.name)).toEqual(['timer_set', 'timer_list', 'timer_cancel'])
		for (const t of tools) expect(t.permissions).toEqual([])
		expect(tools.map((t) => t.isReadOnly({} as never))).toEqual([false, true, false])
	})

	it('sets a recurring timer by default and says it is session-only', async () => {
		const host = fakeTimers()
		const [set] = buildSessionTimerTools(host)
		const r = await set?.execute({ when: '10m', prompt: 'check' } as never, ctx)
		expect(host.made[0]?.recurring).toBe(true)
		expect(r?.success).toBe(true)
		expect(r?.output).toContain('Session-only')
		expect(r?.output).toContain('timer_cancel abc123')
	})

	it('says a one-shot fires once', async () => {
		const [set] = buildSessionTimerTools(fakeTimers())
		const r = await set?.execute({ when: '10m', prompt: 'check', recurring: false } as never, ctx)
		expect(r?.output).toContain('fires once')
	})

	it('reports a refused schedule as the error', async () => {
		const [set] = buildSessionTimerTools(fakeTimers())
		const r = await set?.execute({ when: 'bad', prompt: 'x' } as never, ctx)
		expect(r).toMatchObject({ success: false, error: '"bad" is not a schedule' })
	})

	it('lists and cancels', async () => {
		const host = fakeTimers()
		const [set, list, cancel] = buildSessionTimerTools(host)
		expect((await list?.execute({} as never, ctx))?.output).toBe('No timers.')
		await set?.execute({ when: '10m', prompt: 'check' } as never, ctx)
		expect((await list?.execute({} as never, ctx))?.output).toContain('abc123')
		expect((await cancel?.execute({ id: 'abc123' } as never, ctx))?.output).toBe(
			'Cancelled timer abc123.',
		)
		expect(await cancel?.execute({ id: 'zzz' } as never, ctx)).toMatchObject({ success: false })
	})
})

describe('wake_up', () => {
	function paced(): SelfPacedHost & { calls: unknown[]; stopped: number } {
		return {
			calls: [],
			stopped: 1,
			wakeUp(r) {
				this.calls.push(r)
				const c = clampWakeUpDelay(r.delaySeconds)
				return { dueAt: '2026-11-20T10:20:00.000Z', delaySeconds: c.seconds, clamped: c.clamped }
			},
			stop() {
				return this.stopped
			},
		}
	}

	it('needs a delay and a reason unless it stops', async () => {
		const tool = buildWakeUpTool(paced())
		expect(await tool.execute({ delay_seconds: 60 } as never, ctx)).toMatchObject({
			success: false,
		})
		expect(await tool.execute({ reason: 'x' } as never, ctx)).toMatchObject({ success: false })
	})

	it('passes quiet through and names a clamped delay', async () => {
		const host = paced()
		const tool = buildWakeUpTool(host)
		const r = await tool.execute({ delay_seconds: 5, reason: 'soon', quiet: true } as never, ctx)
		expect(host.calls).toEqual([{ delaySeconds: 5, reason: 'soon', quiet: true }])
		expect(r.output).toContain('in 60s')
		expect(r.output).toContain('held to 60s')
	})

	it('stops the loop and ignores the other fields', async () => {
		const host = paced()
		const tool = buildWakeUpTool(host)
		expect((await tool.execute({ stop: true, delay_seconds: 5 } as never, ctx)).output).toContain(
			'Loop stopped',
		)
		expect(host.calls).toEqual([])
		host.stopped = 0
		expect((await tool.execute({ stop: true } as never, ctx)).output).toContain('nothing to stop')
	})

	it('reports a refusal from the host', async () => {
		const host = paced()
		host.wakeUp = () => {
			throw new Error('No self-paced loop is waiting for a wake-up.')
		}
		const r = await buildWakeUpTool(host).execute({ delay_seconds: 90, reason: 'r' } as never, ctx)
		expect(r).toMatchObject({
			success: false,
			error: 'No self-paced loop is waiting for a wake-up.',
		})
	})
})
