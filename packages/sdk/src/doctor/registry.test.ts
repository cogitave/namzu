/**
 * Ratified §9 of docs.local/sessions/ses_007-probe-and-doctor/design.md.
 * D4 = registerDoctorCheck + plugin auto-discovery + standalone-CLI /
 * embedded-runDoctor split. D5 = sysexits exit codes (0/1/2/70).
 */

import { describe, expect, it } from 'vitest'

import type { DoctorCheck, DoctorCheckResult } from '../types/doctor/index.js'

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
		expect(report.summary).toEqual({ pass: 1, fail: 1, inconclusive: 1, warn: 1, total: 4 })
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
