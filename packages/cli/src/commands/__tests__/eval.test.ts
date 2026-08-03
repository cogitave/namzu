import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EVAL_EXIT, discoverSuites, evalCommand } from '../eval.js'
import type { CommandContext } from '../types.js'

/**
 * The eval surface was a library function and a string formatter: no
 * command, no CI step, and `formatReport` ending at `lines.join('\n')`
 * with no file write and no exit code. The harness exists to give a
 * behaviour change a regression signal, and that signal could not reach CI
 * without every consumer hand-writing the runner and the
 * report-to-exit-code mapping.
 */

function makeCtx() {
	const printed: unknown[] = []
	const errors: string[] = []
	const infos: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => printed.push(data),
			info: (message: string) => infos.push(message),
			error: (payload: { message: string }) => errors.push(payload.message),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors, infos }
}

/** A suite module returning a report with the given counts. */
const suiteSource = (
	opts: { passed?: number; failed?: number; inconclusive?: number; tags?: string[] } = {},
) => `
export const tags = ${JSON.stringify(opts.tags ?? [])}
export default async function () {
	return {
		name: 'suite',
		cases: [],
		mean: 1,
		passed: ${opts.passed ?? 1},
		failed: ${opts.failed ?? 0},
		inconclusive: ${opts.inconclusive ?? 0},
		byScorer: {},
		durationMs: 1,
	}
}
`

describe('discovering suites', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-eval-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('derives an id from the path, so two commits can be diffed', async () => {
		await mkdir(join(dir, 'tools'), { recursive: true })
		await writeFile(join(dir, 'tools', 'read.eval.js'), suiteSource(), 'utf-8')

		const [suite] = await discoverSuites(dir)
		// Posix-separated regardless of host, or the id changes per machine.
		expect(suite?.id).toBe('tools/read')
	})

	it('ignores files that are not suites', async () => {
		await writeFile(join(dir, 'helpers.js'), 'export default 1', 'utf-8')
		expect(await discoverSuites(dir)).toEqual([])
	})

	it('does not walk into dependency or dot directories', async () => {
		await mkdir(join(dir, 'node_modules'), { recursive: true })
		await mkdir(join(dir, '.cache'), { recursive: true })
		await writeFile(join(dir, 'node_modules', 'a.eval.js'), suiteSource(), 'utf-8')
		await writeFile(join(dir, '.cache', 'b.eval.js'), suiteSource(), 'utf-8')

		expect(await discoverSuites(dir)).toEqual([])
	})

	it('returns nothing for a directory that does not exist', async () => {
		expect(await discoverSuites(join(dir, 'missing'))).toEqual([])
	})
})

describe('the exit code', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-eval-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const run = async (args: string[] = []) => {
		const { ctx, printed, errors, infos } = makeCtx()
		const code = await evalCommand.handler({ ctx, rawArgs: ['--dir', dir, ...args] })
		return { code, printed, errors, infos }
	}

	it('is 0 when everything passed', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteSource(), 'utf-8')
		expect((await run()).code).toBe(EVAL_EXIT.ok)
	})

	it('is 1 on a failure — the regression signal', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ failed: 1 }), 'utf-8')
		expect((await run()).code).toBe(EVAL_EXIT.failed)
	})

	it('is 2 on inconclusive, which is a broken harness rather than a regression', async () => {
		// Collapsing this into 1 sends somebody hunting a behaviour change
		// that never happened.
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ inconclusive: 1 }), 'utf-8')
		expect((await run()).code).toBe(EVAL_EXIT.inconclusive)
	})

	it('reports inconclusive even when something also failed', async () => {
		// A suite that could not judge says nothing about the cases it did
		// judge, so the failure count covers less evidence than it appears to.
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ failed: 1, inconclusive: 1 }), 'utf-8')
		expect((await run()).code).toBe(EVAL_EXIT.inconclusive)
	})

	it('is a usage error when no suite exists', async () => {
		// Not 0. A CI gate that finds nothing to run must not report green.
		const { code, errors } = await run()
		expect(code).toBe(EVAL_EXIT.usage)
		expect(errors[0]).toMatch(/No eval suites found/)
	})

	it('is a usage error when a suite does not export a runner', async () => {
		await writeFile(join(dir, 'a.eval.js'), 'export const tags = []', 'utf-8')
		const { code, errors } = await run()
		expect(code).toBe(EVAL_EXIT.usage)
		expect(errors[0]).toMatch(/must default-export a function/)
	})
})

describe('filtering and artifacts', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-eval-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const run = async (args: string[]) => {
		const { ctx, printed, errors, infos } = makeCtx()
		const code = await evalCommand.handler({ ctx, rawArgs: ['--dir', dir, ...args] })
		return { code, printed, errors, infos }
	}

	it('runs only the suites carrying the tag', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ tags: ['fast'] }), 'utf-8')
		await writeFile(join(dir, 'b.eval.js'), suiteSource({ tags: ['slow'], failed: 1 }), 'utf-8')

		const { code } = await run(['--tag', 'fast'])
		expect(code).toBe(EVAL_EXIT.ok)
	})

	it('says how many suites the filter skipped', async () => {
		// A filter that quietly matched nothing looks exactly like a green
		// run, which is the worst way for a CI gate to fail open.
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ tags: ['fast'] }), 'utf-8')
		await writeFile(join(dir, 'b.eval.js'), suiteSource({ tags: ['slow'] }), 'utf-8')

		const { infos } = await run(['--tag', 'fast'])
		expect(infos.some((m) => m.includes('1 suite(s) skipped'))).toBe(true)
	})

	it('is a usage error when the filter matches nothing at all', async () => {
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ tags: ['fast'] }), 'utf-8')
		const { code } = await run(['--tag', 'nope'])
		expect(code).toBe(EVAL_EXIT.usage)
	})

	it('writes the whole report, not a summary', async () => {
		const out = join(dir, 'artifacts', 'report.json')
		await writeFile(join(dir, 'a.eval.js'), suiteSource({ failed: 2 }), 'utf-8')

		await run(['--out', out])

		const { readFile } = await import('node:fs/promises')
		const written = JSON.parse(await readFile(out, 'utf-8')) as {
			suites: Array<{ suite: string; report: { failed: number } }>
		}
		// Two commits' artifacts are meant to be diffable, and a summary
		// cannot say which scorer moved.
		expect(written.suites[0]?.suite).toBe('a')
		expect(written.suites[0]?.report.failed).toBe(2)
	})
})
