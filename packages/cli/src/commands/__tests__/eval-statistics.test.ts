import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EVAL_EXIT, evalCommand } from '../eval.js'
import type { CommandContext } from '../types.js'

/**
 * Repeats, seeds and comparison from the command line. The suites here are
 * scripted and touch no provider and no network.
 */

function makeCtx() {
	const printed: unknown[] = []
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => printed.push(data),
			info: () => {},
			error: (payload: { message: string }) => errors.push(payload.message),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors }
}

/**
 * A suite that calls the real `runExperiment` over six scripted cases. It
 * takes no option for repeats or a seed: they have to reach it from the
 * command, as they do for every suite written before the option existed.
 */
const sdkUrl = import.meta.resolve('@namzu/sdk')
const suiteThatRuns = (failing: string[] = []) => `
import { runExperiment, customScorer } from ${JSON.stringify(sdkUrl)}
export const tags = ['ci']
export default function () {
	const failing = new Set(${JSON.stringify(failing)})
	return runExperiment({
		name: 'scripted',
		scorers: [customScorer('ok', (turn) => ({ score: turn.output === 'pass' ? 1 : 0, reason: 'scripted' }))],
		cases: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, input: name })),
		run: async (input) => ({
			output: failing.has(input) ? 'fail' : 'pass',
			steps: [], toolCalls: [], totalTokens: 0, totalCostUsd: 0, durationMs: 0,
		}),
		disclosure: { mode: 'scripted', roles: { agent: { provider: 'mock', model: 'script' } } },
	})
}
`

describe('namzu eval statistics', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-eval-stats-'))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await rm(dir, { recursive: true, force: true })
	})

	const run = async (args: string[]) => {
		const made = makeCtx()
		const code = await evalCommand.handler({ ctx: made.ctx, rawArgs: ['--dir', dir, ...args] })
		return { code, ...made }
	}

	const written = async (out: string) =>
		JSON.parse(await readFile(out, 'utf-8')) as {
			schemaVersion: number
			run: Record<string, any>
			suites: Array<{ suite: string; report: Record<string, any> }>
		}

	it('runs every case of a suite that knows nothing of repeats as many times as asked', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(), 'utf-8')
		const out = join(dir, 'out.json')
		const { code } = await run(['--repeat', '3', '--seed', '7', '--out', out])
		expect(code).toBe(EVAL_EXIT.ok)
		const file = await written(out)
		const report = file.suites[0]?.report as Record<string, any>
		expect(file.schemaVersion).toBe(2)
		expect(report.repeats).toBe(3)
		expect(report.cases).toHaveLength(18)
		expect(report.seed).toBe(7)
		expect(report.disclosure.harnessVersion).toMatch(/^\d+\.\d+\.\d+/)
		expect(report.disclosure.mode).toBe('scripted')
		expect(report.disclosure.suiteVersion).not.toBe('')
		expect(file.run.disclosure).toMatchObject({
			seed: 7,
			repeats: 3,
			suites: 1,
			cases: 6,
			runs: 18,
		})
		expect(file.run.intervals.mean.computed).toBe(true)
		expect(file.run.reliability).toEqual({ cases: 6, passedEveryRepeat: 6, fraction: 1 })
	})

	it('keeps the exit rule: a failed repeat is a failure', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(['c']), 'utf-8')
		expect((await run(['--repeat', '2'])).code).toBe(EVAL_EXIT.failed)
	})

	it('runs once and writes no repeat summaries by default', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(), 'utf-8')
		const out = join(dir, 'out.json')
		await run(['--out', out])
		const report = (await written(out)).suites[0]?.report as Record<string, any>
		expect(report.repeats).toBe(1)
		expect(report.cases).toHaveLength(6)
		expect(report.caseSummaries).toBeUndefined()
	})

	it('prints the intervals and the whole-run line', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(['c']), 'utf-8')
		const { printed } = await run([])
		const text = printed.map((p) => (p as { text: string }).text).join('\n')
		expect(text).toContain('95% interval')
		expect(text).toContain('Whole run: 5/6 runs passed')
		expect(text).toContain('no held-out cases')
	})

	it.each([['0'], ['101'], ['x'], ['1.5'], ['-2']])(
		'refuses --repeat %s as a usage error',
		async (value) => {
			await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(), 'utf-8')
			const { code, errors } = await run([`--repeat=${value}`])
			expect(code).toBe(EVAL_EXIT.usage)
			expect(errors[0]).toContain('--repeat takes a whole number from 1 to 100')
		},
	)

	it('refuses a seed it cannot use', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(), 'utf-8')
		const { code, errors } = await run(['--seed', '-1'])
		expect(code).toBe(EVAL_EXIT.usage)
		expect(errors[0]).toContain('--seed takes a whole number')
	})
})
