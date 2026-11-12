import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

	it('does not call a RangeError thrown by a suite itself a usage error', async () => {
		await writeFile(
			join(dir, 'a.eval.js'),
			'export default function () { throw new RangeError("Invalid array length") }',
			'utf-8',
		)
		await expect(run([])).rejects.toThrow('Invalid array length')
	})

	it('records the seed a suite set itself when --seed is not given', async () => {
		await writeFile(
			join(dir, 'a.eval.js'),
			suiteThatRuns().replace("name: 'scripted',", "name: 'scripted', seed: 42,"),
			'utf-8',
		)
		const out = join(dir, 'out.json')
		await run(['--out', out])
		expect((await written(out)).run.disclosure.seed).toBe(42)
	})

	it('marks the commit when tracked files have changed since it', async () => {
		const git = (...args: string[]) =>
			execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
				cwd: dir,
				stdio: 'ignore',
			})
		git('init', '-q')
		await writeFile(join(dir, 'a.eval.js'), suiteThatRuns(), 'utf-8')
		git('add', 'a.eval.js')
		git('commit', '-q', '-m', 'suite')
		const clean = join(dir, 'clean.json')
		await run(['--out', clean])
		expect((await written(clean)).run.disclosure.commit).toMatch(/^[0-9a-f]{7,64}$/)
		await writeFile(join(dir, 'a.eval.js'), `${suiteThatRuns()}\n// edited\n`, 'utf-8')
		const dirty = join(dir, 'dirty.json')
		await run(['--out', dirty])
		expect((await written(dirty)).run.disclosure.commit).toMatch(/-dirty$/)
	})

	describe('compare', () => {
		const writeRun = async (name: string, failing: string[]) => {
			// One directory per run: a module is imported once per path.
			const sub = join(dir, `${name}-suites`)
			await mkdir(sub)
			await writeFile(join(sub, 'suite.eval.js'), suiteThatRuns(failing), 'utf-8')
			const out = join(dir, name)
			await run(['--dir', sub, '--out', out])
			return out
		}

		const compare = async (args: string[]) => {
			const made = makeCtx()
			const code = await evalCommand.handler({ ctx: made.ctx, rawArgs: ['compare', ...args] })
			return { code, ...made }
		}

		it('prints a comparison of two written reports, and never names a winner on one flip', async () => {
			const a = await writeRun('a.json', ['c'])
			const b = await writeRun('b.json', [])
			const { code, printed } = await compare([a, b])
			expect(code).toBe(EVAL_EXIT.ok)
			const text = (printed[0] as { text: string }).text
			expect(text).toContain('6 paired')
			expect(text).toContain('Flips: 1 case passed on B and not on A')
			expect(text).toContain('no difference can be claimed at this size.')
			expect(text).toContain('no stated difference')
		})

		it('prints the same facts as JSON with --json', async () => {
			const a = await writeRun('a.json', ['c'])
			const b = await writeRun('b.json', [])
			const { code, printed } = await compare([a, b, '--json', '--seed', '5'])
			expect(code).toBe(EVAL_EXIT.ok)
			const output = printed[0] as string
			const parsed = JSON.parse(output) as Record<string, any>
			expect(parsed.seed).toBe(5)
			expect(parsed.paired).toBe(6)
			expect(parsed.verdict.claim).toBe('none')
			expect(parsed.flips.onlyBPasses).toBe(1)
		})

		it('is a usage error for a file that is missing or is not a report', async () => {
			const a = await writeRun('a.json', [])
			const bad = join(dir, 'bad.json')
			await writeFile(bad, '{"nope": 1}', 'utf-8')
			const missing = await compare([a, join(dir, 'missing.json')])
			expect(missing.code).toBe(EVAL_EXIT.usage)
			expect(missing.errors[0]).toContain('Cannot read')
			const notReport = await compare([a, bad])
			expect(notReport.code).toBe(EVAL_EXIT.usage)
			expect(notReport.errors[0]).toContain('is not an eval report')
		})
	})
})
