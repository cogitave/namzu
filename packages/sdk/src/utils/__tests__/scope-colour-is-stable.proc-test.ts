import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The scope column's colour has to be the same on Tuesday as it was on
 * Monday, in a different process, on a different machine.
 *
 * That is the whole value of colouring by hash rather than by allocation
 * order: a reader learns that `sandbox` is the cyan one and keeps that
 * across sessions. A colour derived from anything process-local — the pid,
 * module load order, a `Map` insertion counter, `Math.random` seeded at
 * import — looks perfectly stable inside a single test run and moves every
 * time the process restarts.
 *
 * So this cannot be asserted in-process. Two runs of the same code in the
 * same runner share module state and would agree no matter how the colour
 * was derived. Two real `node` invocations do not, which is why this lives
 * in the proc suite.
 */

const DIST = join(import.meta.dirname, '../../../dist/utils/log/templates.js')

/** Renders the palette for a fixed scope list in a fresh process. */
function inFreshProcess(): string {
	return execFileSync(
		process.execPath,
		[
			'-e',
			`import(${JSON.stringify(DIST)}).then((m) => {
				const scopes = ['boot', 'config', 'sandbox', 'provider', 'telemetry', 'discovery', 'session']
				process.stdout.write(scopes.map((s) => s + '=' + m.scopeColour(s)).join(','))
			})`,
		],
		{ encoding: 'utf-8' },
	)
}

describe('a scope keeps its colour across processes', () => {
	it('produces identical bytes from two separate node invocations', () => {
		const first = inFreshProcess()
		const second = inFreshProcess()

		// Non-empty first: `execFileSync` returning '' twice would satisfy an
		// equality check while proving nothing at all.
		expect(first).toMatch(/^boot=\d+,/)
		expect(second).toBe(first)
	})

	it('assigns more than one colour, so stability is not a constant', () => {
		// The check above passes trivially against `scopeColour = () => 31`.
		const codes = new Set(
			inFreshProcess()
				.split(',')
				.map((pair) => pair.split('=')[1]),
		)

		expect(codes.size).toBeGreaterThan(1)
	})
})
