/**
 * Ratified §9 of docs.local/sessions/ses_007-probe-and-doctor/design.md.
 * D4 = registerDoctorCheck + plugin auto-discovery + standalone-CLI /
 * embedded-runDoctor split. D5 = sysexits exit codes (0/1/2/70).
 */

import { describe, expect, it } from 'vitest'

import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { createDoctorRegistry, runDoctor } from './registry.js'

function check(
	id: string,
	result: DoctorCheckResult,
	category: DoctorCheck['category'] = 'custom',
): DoctorCheck {
	return {
		id,
		category,
		run: async () => result,
	}
}

describe('DoctorRegistry — registration', () => {
	it('register + list returns the registered check', () => {
		const reg = createDoctorRegistry()
		const c = check('a', { status: 'pass' })
		reg.register(c)
		expect(reg.list()).toEqual([c])
	})

	it('throws when registering a duplicate id without unregister', () => {
		const reg = createDoctorRegistry()
		reg.register(check('dup', { status: 'pass' }))
		expect(() => reg.register(check('dup', { status: 'pass' }))).toThrow(/already registered/)
	})

	it('unregister removes the check', () => {
		const reg = createDoctorRegistry()
		reg.register(check('x', { status: 'pass' }))
		expect(reg.unregister('x')).toBe(true)
		expect(reg.list()).toEqual([])
	})

	it('clear removes everything', () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'fail' }))
		reg.clear()
		expect(reg.list()).toEqual([])
	})
})

describe('runDoctor — aggregation + summary', () => {
	it('aggregates check results into a DoctorReport with the right summary', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'fail', message: 'broken' }))
		reg.register(check('c', { status: 'inconclusive' }))
		reg.register(check('d', { status: 'warn' }))
		const report = await runDoctor({ registry: reg, version: '0.0.1' })
		expect(report.summary).toEqual({
			pass: 1,
			fail: 1,
			inconclusive: 1,
			warn: 1,
			total: 4,
		})
		expect(report.checks).toHaveLength(4)
		expect(report.version).toBe('0.0.1')
	})

	it('exit = 0 when all pass / no fail', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'inconclusive' }))
		reg.register(check('c', { status: 'warn' }))
		const report = await runDoctor({ registry: reg })
		expect(report.exit).toBe(0)
	})

	it('exit = 1 when any check fails', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'fail' }))
		const report = await runDoctor({ registry: reg })
		expect(report.exit).toBe(1)
	})

	it('exit = 2 (no config) when no checks registered', async () => {
		const reg = createDoctorRegistry()
		const report = await runDoctor({ registry: reg })
		expect(report.exit).toBe(2)
		expect(report.summary.total).toBe(0)
	})

	it('inconclusive + warn do not affect exit code', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'inconclusive' }))
		reg.register(check('b', { status: 'warn' }))
		const report = await runDoctor({ registry: reg })
		expect(report.exit).toBe(0)
	})
})

describe('runDoctor — failure isolation', () => {
	it('a throwing check is reported as fail; other checks still run', async () => {
		const reg = createDoctorRegistry()
		reg.register({
			id: 'thrower',
			category: 'custom',
			run: async () => {
				throw new Error('boom')
			},
		})
		reg.register(check('ok', { status: 'pass' }))
		const report = await runDoctor({ registry: reg })
		expect(report.summary.total).toBe(2)
		expect(report.summary.fail).toBe(1)
		expect(report.summary.pass).toBe(1)
		const thrower = report.checks.find((r) => r.id === 'thrower')
		expect(thrower?.status).toBe('fail')
		expect(thrower?.message).toMatch(/boom/)
	})

	it('a slow check that exceeds perCheckTimeoutMs is recorded as inconclusive', async () => {
		const reg = createDoctorRegistry()
		reg.register({
			id: 'slow',
			category: 'custom',
			run: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'pass' }), 200)),
		})
		const report = await runDoctor({ registry: reg, perCheckTimeoutMs: 30 })
		expect(report.summary.total).toBe(1)
		const slow = report.checks[0]
		expect(slow?.status).toBe('inconclusive')
		expect(slow?.message).toMatch(/did not return within 30ms/)
	})
})

describe('runDoctor — wall-clock timeout preserves completed records (ses_013 C5 fix)', () => {
	it('fast pass + slow check exceeding wall budget → 1 pass + 1 inconclusive (NOT 2 inconclusive)', async () => {
		const reg = createDoctorRegistry()
		reg.register({
			id: 'fast',
			category: 'custom',
			run: async () => ({ status: 'pass', message: 'instantly done' }),
		})
		reg.register({
			id: 'slow',
			category: 'custom',
			run: () =>
				new Promise<DoctorCheckResult>((resolve) =>
					setTimeout(() => resolve({ status: 'pass' }), 200),
				),
		})
		const report = await runDoctor({
			registry: reg,
			wallClockTimeoutMs: 50,
			perCheckTimeoutMs: 1000,
		})
		expect(report.summary.total).toBe(2)
		expect(report.summary.pass).toBe(1)
		expect(report.summary.inconclusive).toBe(1)
		const fast = report.checks.find((r) => r.id === 'fast')
		const slow = report.checks.find((r) => r.id === 'slow')
		expect(fast?.status).toBe('pass')
		expect(fast?.message).toBe('instantly done')
		expect(slow?.status).toBe('inconclusive')
		expect(slow?.message).toMatch(/wall-clock timeout/)
		expect(slow?.message).toMatch(/before this check completed/)
	})

	it('all checks finish before wall-clock budget → all preserved (no overwrite)', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass', message: 'first' }))
		reg.register(check('b', { status: 'fail', message: 'second' }))
		reg.register(check('c', { status: 'warn', message: 'third' }))
		const report = await runDoctor({ registry: reg, wallClockTimeoutMs: 5_000 })
		expect(report.summary.total).toBe(3)
		expect(report.checks.find((r) => r.id === 'a')?.message).toBe('first')
		expect(report.checks.find((r) => r.id === 'b')?.message).toBe('second')
		expect(report.checks.find((r) => r.id === 'c')?.message).toBe('third')
	})

	it('mixed: 2 fast pass + 1 fast fail + 1 slow → preserves 3 + 1 inconclusive on wall timeout', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'pass' }))
		reg.register(check('c', { status: 'fail', message: 'expected fail' }))
		reg.register({
			id: 'd',
			category: 'custom',
			run: () =>
				new Promise<DoctorCheckResult>((resolve) =>
					setTimeout(() => resolve({ status: 'pass' }), 300),
				),
		})
		const report = await runDoctor({
			registry: reg,
			wallClockTimeoutMs: 50,
			perCheckTimeoutMs: 1000,
		})
		expect(report.summary.pass).toBe(2)
		expect(report.summary.fail).toBe(1)
		expect(report.summary.inconclusive).toBe(1)
		expect(report.summary.total).toBe(4)
		// exit code respects: fail > 0 → 1 (not affected by inconclusive)
		expect(report.exit).toBe(1)
		expect(report.checks.find((r) => r.id === 'd')?.status).toBe('inconclusive')
	})
})

describe('runDoctor — double-fire defense (ses_013 C4)', () => {
	it('a check whose per-check timeout fires after the check resolved produces exactly one record', async () => {
		// This timing is fragile by nature; the test asserts the contract
		// "exactly one record per id" which holds regardless of which side
		// of the race wins.
		const reg = createDoctorRegistry()
		reg.register({
			id: 'racer',
			category: 'custom',
			run: () =>
				new Promise<DoctorCheckResult>((resolve) =>
					setTimeout(() => resolve({ status: 'pass' }), 25),
				),
		})
		const report = await runDoctor({
			registry: reg,
			perCheckTimeoutMs: 25, // intentionally close to the check's 25ms
			wallClockTimeoutMs: 1000,
		})
		expect(report.summary.total).toBe(1)
		expect(report.checks).toHaveLength(1)
		const racer = report.checks[0]
		// Whichever side won, exactly ONE record exists (no duplicate).
		expect(['pass', 'inconclusive']).toContain(racer?.status)
	})
})

describe('runDoctor — category filter', () => {
	it('only runs checks matching the requested category', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }, 'sandbox'))
		reg.register(check('b', { status: 'pass' }, 'providers'))
		reg.register(check('c', { status: 'pass' }, 'sandbox'))
		const report = await runDoctor({ registry: reg, categories: ['sandbox'] })
		expect(report.summary.total).toBe(2)
		expect(report.checks.every((r) => r.category === 'sandbox')).toBe(true)
	})
})

describe('runDoctor — context plumbing', () => {
	it('passes cwd / env / projectRoot to the check', async () => {
		const reg = createDoctorRegistry()
		let observedCwd: string | undefined
		let observedRoot: string | null | undefined
		reg.register({
			id: 'context-probe',
			category: 'custom',
			run: async (ctx) => {
				observedCwd = ctx.cwd
				observedRoot = ctx.projectRoot
				return { status: 'pass' }
			},
		})
		await runDoctor({
			registry: reg,
			cwd: '/tmp/fake',
			projectRoot: '/projects/x',
		})
		expect(observedCwd).toBe('/tmp/fake')
		expect(observedRoot).toBe('/projects/x')
	})
})

describe('runDoctor — report shape', () => {
	it('produces a frozen report with timestamp', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		const report = await runDoctor({ registry: reg })
		expect(Object.isFrozen(report)).toBe(true)
		expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	})
})

describe('runDoctor — onCheckStart / onCheckComplete callbacks (ses_013 Phase 1)', () => {
	it('onCheckStart fires before onCheckComplete for the same id', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'fail', message: 'broken' }))
		const events: string[] = []
		await runDoctor({
			registry: reg,
			onCheckStart: (c) => events.push(`start:${c.id}`),
			onCheckComplete: (r) => events.push(`done:${r.id}`),
		})
		// Independently per id, start must precede done.
		const startA = events.indexOf('start:a')
		const doneA = events.indexOf('done:a')
		const startB = events.indexOf('start:b')
		const doneB = events.indexOf('done:b')
		expect(startA).toBeGreaterThanOrEqual(0)
		expect(doneA).toBeGreaterThan(startA)
		expect(startB).toBeGreaterThanOrEqual(0)
		expect(doneB).toBeGreaterThan(startB)
	})

	it('both callbacks fire exactly once per check, even when per-check timeout races', async () => {
		const reg = createDoctorRegistry()
		reg.register({
			id: 'racer',
			category: 'custom',
			run: () =>
				new Promise<DoctorCheckResult>((resolve) =>
					setTimeout(() => resolve({ status: 'pass' }), 25),
				),
		})
		const startCount: Record<string, number> = {}
		const doneCount: Record<string, number> = {}
		await runDoctor({
			registry: reg,
			perCheckTimeoutMs: 25,
			onCheckStart: (c) => {
				startCount[c.id] = (startCount[c.id] ?? 0) + 1
			},
			onCheckComplete: (r) => {
				doneCount[r.id] = (doneCount[r.id] ?? 0) + 1
			},
		})
		expect(startCount.racer).toBe(1)
		expect(doneCount.racer).toBe(1)
	})

	it('a throwing onCheckStart does NOT affect the DoctorReport (ses_013 C3)', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass', message: 'still here' }))
		reg.register(check('b', { status: 'fail', message: 'still failed' }))
		const report = await runDoctor({
			registry: reg,
			onCheckStart: () => {
				throw new Error('start handler exploded')
			},
		})
		expect(report.summary.total).toBe(2)
		expect(report.summary.pass).toBe(1)
		expect(report.summary.fail).toBe(1)
		expect(report.checks.find((r) => r.id === 'a')?.message).toBe('still here')
	})

	it('a throwing onCheckComplete does NOT affect the DoctorReport (ses_013 C3)', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		const report = await runDoctor({
			registry: reg,
			onCheckComplete: () => {
				throw new Error('complete handler exploded')
			},
		})
		expect(report.summary.total).toBe(1)
		expect(report.summary.pass).toBe(1)
		expect(report.exit).toBe(0)
	})
})

describe('runDoctor — signal abort (ses_013 Phase 1)', () => {
	it('signal already aborted before run → all checks marked inconclusive immediately', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('a', { status: 'pass' }))
		reg.register(check('b', { status: 'pass' }))
		const controller = new AbortController()
		controller.abort()
		const report = await runDoctor({
			registry: reg,
			signal: controller.signal,
			perCheckTimeoutMs: 5_000,
			wallClockTimeoutMs: 5_000,
		})
		expect(report.summary.total).toBe(2)
		// Either all inconclusive (abort wins the race), OR some completed
		// if the synchronous check resolved before the race. The contract is
		// "no checks should hang indefinitely" — the report should return
		// promptly, not wait 5s.
		expect(report.summary.fail).toBe(0)
		expect(report.checks.every((r) => ['pass', 'inconclusive'].includes(r.status))).toBe(true)
		// Inconclusive records carry the "aborted by signal" message.
		const inconclusiveOnes = report.checks.filter((r) => r.status === 'inconclusive')
		for (const r of inconclusiveOnes) {
			expect(r.message).toMatch(/aborted by signal/)
		}
	})

	it('signal aborted mid-run → completed checks preserved, in-flight marked aborted-inconclusive', async () => {
		const reg = createDoctorRegistry()
		reg.register(check('fast', { status: 'pass', message: 'finished' }))
		reg.register({
			id: 'slow',
			category: 'custom',
			run: () =>
				new Promise<DoctorCheckResult>((resolve) =>
					setTimeout(() => resolve({ status: 'pass' }), 500),
				),
		})
		const controller = new AbortController()
		// Abort after the fast check has had time to finish but before the
		// slow check resolves.
		setTimeout(() => controller.abort(), 50)
		const report = await runDoctor({
			registry: reg,
			signal: controller.signal,
			perCheckTimeoutMs: 5_000,
			wallClockTimeoutMs: 5_000,
		})
		expect(report.summary.total).toBe(2)
		const fast = report.checks.find((r) => r.id === 'fast')
		const slow = report.checks.find((r) => r.id === 'slow')
		expect(fast?.status).toBe('pass')
		expect(fast?.message).toBe('finished')
		expect(slow?.status).toBe('inconclusive')
		expect(slow?.message).toMatch(/aborted by signal/)
	})
})
