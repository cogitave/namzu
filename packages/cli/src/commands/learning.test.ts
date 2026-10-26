import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIT_USAGE } from '../exit-codes.js'
import { runLearningCommand } from './learning.js'

const roots: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('namzu learn --sessions', () => {
	it('says there is nothing to learn from when no conversation kept an observation', async () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-learn-'))
		roots.push(home)
		vi.stubEnv('NAMZU_HOME', home)
		const printed: { text?: string }[] = []
		const ctx = {
			formatter: {
				print: (v: { text?: string }) => printed.push(v),
				error: vi.fn(),
				info: vi.fn(),
			},
		}
		const code = await runLearningCommand({
			ctx,
			rawArgs: ['learn', '--sessions', '--cwd', home, 'x.learning.js'],
		} as never)
		expect(code).toBe(EXIT_USAGE)
		expect(printed[0]?.text).toContain('nothing to learn from')
	})
})

describe('namzu learn without a module', () => {
	function run(args: string[]) {
		const home = mkdtempSync(join(tmpdir(), 'namzu-learn-'))
		roots.push(home)
		vi.stubEnv('NAMZU_HOME', home)
		const printed: { text?: string }[] = []
		const errors: string[] = []
		const ctx = {
			config: {},
			formatter: {
				print: (v: { text?: string }) => printed.push(v),
				error: (v: { message: string }) => errors.push(v.message),
				info: vi.fn(),
			},
		}
		return runLearningCommand({ ctx, rawArgs: ['learn', ...args, '--cwd', home] } as never).then(
			(code) => ({ code, printed, errors }),
		)
	}

	it('has nothing to learn from in a folder that kept nothing, and says so without an error', async () => {
		const { code, printed } = await run([])
		expect(code).toBe(0)
		expect(printed[0]?.text).toContain('nothing to learn from')
	})

	it('lists nothing learned yet', async () => {
		const { code, printed } = await run(['--list'])
		expect(code).toBe(0)
		expect(printed[0]?.text).toBe('Nothing has been learned for this folder yet.')
	})

	it('has nothing to undo in a folder that learned nothing', async () => {
		const { code, printed } = await run(['--undo'])
		expect(code).toBe(EXIT_USAGE)
		expect(printed[0]?.text).toBe('Nothing has been learned for this folder yet.')
	})

	it('refuses list and undo together, and flags that belong to a module', async () => {
		for (const args of [['--list', '--undo'], ['--trust'], ['--sessions'], ['--agent', 'x']]) {
			const { code, errors } = await run(args)
			expect(code).toBe(EXIT_USAGE)
			expect(errors).toHaveLength(1)
		}
	})

	it('keeps --list and --undo for the built-in generator only', async () => {
		const { code, errors } = await run(['x.learning.js', '--list'])
		expect(code).toBe(EXIT_USAGE)
		expect(errors[0]).toMatch(/without a module/)
	})
})
