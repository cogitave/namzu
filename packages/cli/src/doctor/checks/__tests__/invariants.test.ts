/**
 * `unknown` must never be reported as `pass` (NZ-BOOT-03 acceptance): an
 * invariant whose check could not run is not one that ran and found nothing
 * wrong, and defaulting the aggregate to `pass` when some row could not
 * answer would be exactly the false-pass
 * `an-optional-dependency-may-not-degrade-a-check` describes.
 */

import type { DoctorCheckContext } from '@namzu/sdk'
import { createInvariantRegistry, invariants } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { createDoctorRegistry, runDoctor } from '../../registry.js'
import { describeInvariants, invariantsCheck } from '../invariants.js'

const ctx: DoctorCheckContext = { cwd: process.cwd(), env: {}, projectRoot: null }

describe('describeInvariants', () => {
	it('skips when nothing is registered', async () => {
		const reg = createInvariantRegistry()
		const result = await describeInvariants(reg)
		expect(result.status).toBe('skipped')
	})

	it('passes when every invariant holds', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'a', () => ({ state: 'holds' }))
		reg.register('mod', 'b', () => ({ state: 'holds' }))

		const result = await describeInvariants(reg)
		expect(result.status).toBe('pass')
	})

	it('reports skipped — never pass — when an invariant has no subject to answer about', async () => {
		// The important half is `not.toBe('pass')`: an unevaluated invariant
		// must never be folded in as one that holds.
		//
		// `skipped` rather than `inconclusive` because of what the latter costs
		// downstream. `doctor/registry.ts` maps any inconclusive row to exit 69,
		// which is meant to say "a check could not answer" — and every registered
		// invariant answers `unknown` outside a live run BY DESIGN, so reporting
		// it that way made `namzu doctor` exit 69 on every single run and retired
		// the code. `skipped` is the doctor's existing word for a question that
		// does not apply here, counted separately from `pass` in the summary.
		const reg = createInvariantRegistry()
		reg.register('mod', 'holding', () => ({ state: 'holds' }))
		reg.register('mod', 'pending', () => ({ state: 'unknown', reason: 'no data yet' }))

		const result = await describeInvariants(reg)

		expect(result.status).toBe('skipped')
		expect(result.status).not.toBe('pass')
		expect(result.message ?? '').toContain('mod:pending')
	})

	it('leaves a clean doctor run at exit 0 rather than 69', async () => {
		// The regression this pair exists to stop: `builtInDoctorChecks` now
		// contains the invariants row, every invariant it holds answers
		// `unknown` outside a run, and an `inconclusive` here would make the
		// whole command exit 69 unconditionally.
		const { createDoctorRegistry } = await import('../../registry.js')
		const reg = createDoctorRegistry()
		reg.register(invariantsCheck)
		const report = await reg.run()

		expect(report.exit).toBe(0)
	})

	it('fails when any invariant is violated, even alongside ones that hold', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'holding', () => ({ state: 'holds' }))
		reg.register('mod', 'broken', () => ({ state: 'violated', detail: 'a stale writer' }))

		const result = await describeInvariants(reg)

		expect(result.status).toBe('fail')
		expect(result.message ?? '').toContain('mod:broken')
		expect(result.message ?? '').toContain('a stale writer')
	})

	it('names the violation counter, not just whether one exists', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'flaky', () => ({ state: 'violated', detail: 'boom' }))

		await describeInvariants(reg)
		const second = await describeInvariants(reg)

		// Two calls, two evaluations, two counted violations — the message
		// reports the counter rather than a boolean "has this ever failed".
		expect(second.message ?? '').toContain('2 violation')
	})
})

describe('the doctor report built from this row', () => {
	it('exits 1 when the invariants row fails', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'broken', () => ({ state: 'violated', detail: 'boom' }))

		const doctor = createDoctorRegistry()
		doctor.register({
			id: 'runtime.invariants',
			category: 'runtime',
			run: () => describeInvariants(reg),
		})

		const report = await runDoctor({ registry: doctor })

		expect(report.checks[0]?.status).toBe('fail')
		expect(report.exit).toBe(1)
	})

	it('exits 0 when every invariant holds', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'fine', () => ({ state: 'holds' }))

		const doctor = createDoctorRegistry()
		doctor.register({
			id: 'runtime.invariants',
			category: 'runtime',
			run: () => describeInvariants(reg),
		})

		const report = await runDoctor({ registry: doctor })

		expect(report.checks[0]?.status).toBe('pass')
		expect(report.exit).toBe(0)
	})
})

describe('the registered check itself', () => {
	it('is what invariantsCheck.run actually asks, against the real process-wide registry', async () => {
		// `invariants.listIds().length > 0` is NOT evidence on its own: merely
		// importing `@namzu/sdk` above already populates the shared registry,
		// because the query engine's own module graph imports `compaction.ts`
		// (and `claim-disk.ts`) regardless of anything this test does. A stub
		// `run()` that never reads `invariants` at all would still see a
		// non-empty registry and still return a status in the loose
		// pass/fail/inconclusive set.
		//
		// So this test plants a uniquely-named, always-violated invariant on
		// the SAME shared singleton `invariantsCheck` closes over, and checks
		// that its own detail string comes back out. Only a `run()` that
		// actually evaluates the real `invariants` registry can produce it.
		invariants.register('nz-boot-03-review', 'always-violated-marker', () => ({
			state: 'violated',
			detail: 'planted by the wiring test',
		}))

		const result = await invariantsCheck.run(ctx)

		expect(result.status).toBe('fail')
		expect(result.message ?? '').toContain('nz-boot-03-review:always-violated-marker')
		expect(result.message ?? '').toContain('planted by the wiring test')
	})
})
