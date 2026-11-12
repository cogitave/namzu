import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EVAL_EXIT, evalCommand } from '../eval.js'
import type { CommandContext } from '../types.js'

/**
 * Settings snapshots and splits from the command line. The suite is scripted:
 * no provider, no network.
 */

function makeCtx() {
	const printed: unknown[] = []
	const errors: string[] = []
	const infos: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => printed.push(data),
			info: (line: string) => infos.push(line),
			error: (payload: { message: string }) => errors.push(payload.message),
		},
		config: {},
	} as unknown as CommandContext
	return { ctx, printed, errors, infos }
}

const sdkUrl = import.meta.resolve('@namzu/sdk')

/**
 * Thirty tasks that pass only when the settings say `limits.maxIterations` is
 * at least 3: a harness setting that matters, so a comparison has something to
 * find.
 */
const suiteThatReadsSettings = `
import { runExperiment, customScorer, evalSetting } from ${JSON.stringify(sdkUrl)}
export default function () {
	return runExperiment({
		name: 'scripted',
		scorers: [customScorer('ok', (turn) => ({ score: turn.output === 'pass' ? 1 : 0, reason: 'scripted' }))],
		cases: Array.from({ length: 30 }, (_, i) => ({ name: 'task-' + (i + 1), input: i })),
		run: async () => ({
			output: (evalSetting('limits.maxIterations') ?? 0) >= 3 ? 'pass' : 'fail',
			steps: [], toolCalls: [], totalTokens: 0, totalCostUsd: 0, durationMs: 0,
		}),
		disclosure: { mode: 'scripted', roles: { agent: { provider: 'mock', model: 'script' } } },
	})
}
`

describe('namzu eval settings and splits', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-eval-settings-'))
		await writeFile(join(dir, 'a.eval.js'), suiteThatReadsSettings, 'utf-8')
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const run = async (args: string[]) => {
		const made = makeCtx()
		const code = await evalCommand.handler({ ctx: made.ctx, rawArgs: ['--dir', dir, ...args] })
		return { code, ...made }
	}
	const compare = async (args: string[]) => {
		const made = makeCtx()
		const code = await evalCommand.handler({ ctx: made.ctx, rawArgs: ['compare', ...args] })
		return { code, ...made }
	}
	const settingsFile = async (name: string, body: unknown) => {
		const path = join(dir, name)
		await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
		return path
	}
	type Written = {
		run: { disclosure: Record<string, any> }
		suites: Array<{ suite: string; report: Record<string, any> }>
	}
	const written = async (out: string) => JSON.parse(await readFile(out, 'utf-8')) as Written

	it('with no flag, names the snapshot default and runs every task', async () => {
		const out = join(dir, 'all.json')
		expect((await run(['--out', out])).code).toBe(EVAL_EXIT.failed)
		const file = await written(out)
		const report = file.suites[0]?.report as Record<string, any>
		expect(report.settings).toMatchObject({ name: 'default', values: {}, read: true })
		expect(report.taskSplit.requested).toBe('all')
		expect(report.cases).toHaveLength(30)
		expect(report.taskSplit.tasks).toHaveLength(30)
		expect(file.run.disclosure.settings.name).toBe('default')
		expect(file.run.disclosure.split).toBe('all')
	})

	it('runs one split, the two splits together are all the tasks, and the ids are recorded', async () => {
		const held = join(dir, 'held.json')
		const tune = join(dir, 'tune.json')
		await run(['--split', 'held-out', '--out', held])
		await run(['--split', 'tune', '--out', tune])
		const h = (await written(held)).suites[0]?.report as Record<string, any>
		const t = (await written(tune)).suites[0]?.report as Record<string, any>
		expect(h.cases.length + t.cases.length).toBe(30)
		expect(h.cases.length).toBeGreaterThanOrEqual(5)
		expect(t.cases.length).toBeGreaterThanOrEqual(5)
		expect(h.taskSplit.tasks.map((x: { id: string }) => x.id)).toEqual(
			h.cases.map((c: { case: string }) => `scripted/${c.case}`),
		)
		const heldIds = new Set(h.cases.map((c: { case: string }) => c.case))
		expect(t.cases.some((c: { case: string }) => heldIds.has(c.case))).toBe(false)
	})

	it('refuses a split it does not know', async () => {
		const { code, errors } = await run(['--split', 'dev'])
		expect(code).toBe(EVAL_EXIT.usage)
		expect(errors[0]).toContain('"tune", "held-out" or "all"')
	})

	it('runs under a settings file and names the snapshot after the file, or as told', async () => {
		const file = await settingsFile('quick.json', { limits: { maxIterations: 4 } })
		const out = join(dir, 'quick.json.out')
		expect((await run(['--settings', file, '--out', out])).code).toBe(EVAL_EXIT.ok)
		const r = (await written(out)).suites[0]?.report as Record<string, any>
		expect(r.settings).toMatchObject({
			name: 'quick',
			values: { limits: { maxIterations: 4 } },
			read: true,
		})
		const named = join(dir, 'named.out')
		await run(['--settings', file, '--settings-name', 'iter-4', '--out', named])
		expect(((await written(named)).suites[0]?.report as Record<string, any>).settings.name).toBe(
			'iter-4',
		)
		// The digest is the same under another name: it is a fact about the values.
		expect(((await written(named)).suites[0]?.report as Record<string, any>).settings.digest).toBe(
			r.settings.digest,
		)
	})

	it('reads YAML as the config file does', async () => {
		const file = await settingsFile('y.yaml', 'limits:\n  maxIterations: 4\n')
		const out = join(dir, 'y.out')
		expect((await run(['--settings', file, '--out', out])).code).toBe(EVAL_EXIT.ok)
		expect(((await written(out)).suites[0]?.report as Record<string, any>).settings.values).toEqual(
			{
				limits: { maxIterations: 4 },
			},
		)
	})

	describe('refuses a settings file with a plain message', () => {
		it('for a key that is not a setting', async () => {
			const { code, errors } = await run([
				'--settings',
				await settingsFile('s.json', { nonsense: 1 }),
			])
			expect(code).toBe(EVAL_EXIT.usage)
			expect(errors[0]).toContain('"nonsense" is not a Namzu setting')
			expect(errors[0]).toContain('may set: ')
		})

		it('for a setting that holds credentials or runs commands, without echoing its value', async () => {
			const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
			for (const body of [
				{ mcpServers: { x: { command: 'x', env: { API_KEY: secret } } } },
				{ hooks: { PreToolUse: [{ command: 'x' }] } },
				{ permissions: { allow: ['bash'] } },
				{ telemetry: { headers: { authorization: secret } } },
			]) {
				const { code, errors } = await run(['--settings', await settingsFile('s.json', body)])
				expect(code).toBe(EVAL_EXIT.usage)
				expect(errors[0]).toContain('not one an eval varies')
				expect(errors.join('\n')).not.toContain(secret)
			}
		})

		it('for an allowed setting that carries a credential, and writes no report', async () => {
			const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
			const out = join(dir, 'never.json')
			const { code, errors } = await run([
				'--settings',
				await settingsFile('s.json', { smallModel: secret }),
				'--out',
				out,
			])
			expect(code).toBe(EVAL_EXIT.usage)
			expect(errors.join('\n')).not.toContain(secret)
			await expect(readFile(out, 'utf-8')).rejects.toThrow()
		})

		it("for a value the config reader refuses, with the reader's own sentence", async () => {
			const { code, errors } = await run([
				'--settings',
				await settingsFile('s.json', { limits: { maxIterations: 'many' } }),
			])
			expect(code).toBe(EVAL_EXIT.usage)
			expect(errors[0]).toContain('limits.maxIterations')
		})

		it('for a file that is missing, is not an object, or is named default while stating settings', async () => {
			expect((await run(['--settings', join(dir, 'missing.json')])).errors[0]).toContain(
				'Cannot read',
			)
			expect((await run(['--settings', await settingsFile('l.json', '[1]')])).errors[0]).toContain(
				'must hold an object',
			)
			const d = await settingsFile('default.json', { limits: { maxIterations: 4 } })
			expect((await run(['--settings', d])).errors[0]).toContain(
				'"default" is for a run with no settings',
			)
			const odd = await settingsFile('has space.json', {})
			expect((await run(['--settings', odd])).errors[0]).toContain('--settings-name')
			const alone = await run(['--settings-name', 'x'])
			expect(alone.code).toBe(EVAL_EXIT.usage)
			expect(alone.errors[0]).toContain('--settings')
		})
	})

	describe('a comparison of two settings, from two real runs', () => {
		const make = async (split: string, settings?: string) => {
			const out = join(dir, `${split}-${settings ? basename(settings) : 'default'}.out.json`)
			await run(['--split', split, ...(settings ? ['--settings', settings] : []), '--out', out])
			return out
		}

		it('names a winner only on the held-out split', async () => {
			const better = await settingsFile('better.json', { limits: { maxIterations: 4 } })
			const a = await make('held-out')
			const b = await make('held-out', better)
			const { code, printed } = await compare([a, b])
			expect(code).toBe(EVAL_EXIT.ok)
			const text = (printed[0] as { text: string }).text
			expect(text).toContain('B is better than A by 1.000')
			expect(text).toContain('A "default"')
			expect(text).toContain('B "better"')
			expect(text).toContain('limits.maxIterations: A not stated, B 4')
		})

		it('says the tasks were chosen on, on the tune split', async () => {
			const better = await settingsFile('better.json', { limits: { maxIterations: 4 } })
			const { printed } = await compare([await make('tune'), await make('tune', better)])
			const text = (printed[0] as { text: string }).text
			expect(text).toContain(
				'no winner is named: these are the tasks the settings were chosen on; run the held-out split to judge',
			)
			expect(text).not.toContain('is better than')
		})

		it('says the difference is noise between identical settings, and carries the facts in JSON', async () => {
			const one = await settingsFile('one.json', { limits: { maxIterations: 4 } })
			const two = await settingsFile('two.json', { limits: { maxIterations: 4 } })
			const a = await make('held-out', one)
			const b = await make('held-out', two)
			const { printed } = await compare([a, b, '--json'])
			const parsed = JSON.parse(printed[0] as string) as Record<string, any>
			expect(parsed.verdict.withheld).toEqual(['identical-settings'])
			expect(parsed.settings.identical).toBe(true)
			expect(parsed.settings.a.name).toBe('one')
			expect(parsed.split).toEqual({ a: 'held-out', b: 'held-out' })
		})
	})
})
