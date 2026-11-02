/**
 * Tests for the budget file and argument rules of `scripts/bench-startup.mjs --check`.
 *
 * The timing itself is not tested here: a test that decided its outcome by how fast the
 * machine is would measure the machine. What can be pinned without a clock is the shape of
 * the gate, so it cannot quietly stop gating: every metric the check measures has a wall and a
 * CPU budget, the multipliers cannot be below one, and a sample count too small to be a
 * median is refused before anything runs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..')
const budgets = JSON.parse(readFileSync(join(scripts, 'bench-startup.budgets.json'), 'utf8'))

const MEASURED = [
	'version',
	'help',
	'exec-request-stdin-pipe',
	'exec-request-stdin-null',
	'tui-ready',
	'resume-request',
]

test('every measured metric has a positive wall and CPU reference, and nothing else is listed', () => {
	assert.deepEqual(Object.keys(budgets.metrics).sort(), [...MEASURED].sort())
	for (const name of MEASURED) {
		for (const key of ['wallMs', 'cpuMs']) {
			const ref = budgets.metrics[name][key]
			assert.ok(typeof ref === 'number' && ref > 0, `${name}.${key} must be a positive number`)
		}
	}
})

test('the multipliers can only loosen a reference by a known, bounded factor', () => {
	assert.ok(budgets.ciScale >= 1 && budgets.ciScale <= 4, 'ciScale is how much slower CI may be')
	assert.ok(budgets.headroom >= 1 && budgets.headroom <= 2, 'headroom is noise slack, not a second scale')
	assert.ok(budgets.minLimitMs >= 10 && budgets.minLimitMs <= 500)
})

test('--check refuses fewer than five samples before running anything', () => {
	const r = spawnSync(process.execPath, [join(scripts, 'bench-startup.mjs'), '--check', '--runs', '4'], {
		encoding: 'utf8',
	})
	assert.notEqual(r.status, 0)
	assert.match(r.stderr, /at least 5/)
})
