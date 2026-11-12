import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	FIXTURE_CASES,
	type FixtureSet,
	createFixtureSet,
	goodPlugin,
} from '../__fixtures__/plugin-folders.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { validatePluginFolder } from '../integrations/plugins/validate.js'
import { createFormatter } from '../output/index.js'
import { PLUGIN_VALIDATE_EXIT, pluginCommand, renderPluginReport } from './plugin.js'
import type { CommandContext } from './types.js'

let set: FixtureSet
beforeAll(() => {
	set = createFixtureSet()
})
afterAll(() => removeTempDir(set.base))
afterEach(() => vi.restoreAllMocks())

function run(
	rawArgs: string[],
	format: 'text' | 'json' = 'text',
): Promise<{ code: number; stdout: string; stderr: string[] }> {
	let stdout = ''
	vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write)
	const stderr: string[] = []
	const text = createFormatter('text', { quiet: false })
	const ctx = {
		formatter: {
			...text,
			name: format,
			print: (data: unknown) => text.print(data),
			info: () => undefined,
			error: (payload: { message: string }) => stderr.push(payload.message),
		},
		config: {},
	} as unknown as CommandContext
	return pluginCommand.handler({ ctx, rawArgs }).then((code) => ({ code, stdout, stderr }))
}

const caseDir = (name: string): string => {
	const fixture = FIXTURE_CASES.find((f) => f.name === name)
	if (!fixture) throw new Error(name)
	return set.plugin(`cmd-${name}`, fixture.files(set))
}

describe('exit status', () => {
	it('is 0 for a clean plugin', async () => {
		const { code, stdout } = await run(['validate', goodPlugin(set, 'cmd-good')])
		expect(code).toBe(0)
		expect(stdout).toContain('No problems in 7 parts.')
	})

	it('is 10 for warnings only', async () => {
		const { code, stdout } = await run(['validate', caseDir('skill-unknown-key')])
		expect(code).toBe(PLUGIN_VALIDATE_EXIT.warnings)
		expect(code).toBe(10)
		expect(stdout).toMatch(/warning {2}skills\/reconcile\/SKILL\.md:4 {2}"allowed_tools"/)
	})

	it('is 1 for an error, even with warnings beside it', async () => {
		const { code, stdout } = await run(['validate', caseDir('skill-name-mismatch')])
		expect(code).toBe(1)
		expect(stdout).toMatch(/error {4}skills\/reconcile\/SKILL\.md:2 {2}/)
		expect(stdout).toContain('The loader refuses the whole plugin')
	})

	it('is 66 when the folder cannot be read, with the reason on standard error only', async () => {
		const { code, stdout, stderr } = await run(['validate', join(set.base, 'nowhere')])
		expect(code).toBe(66)
		expect(stdout).toBe('')
		expect(stderr).toHaveLength(1)
		expect(stderr[0]).toMatch(/^Could not read /)
	})

	it('reads what follows -- as a folder, even one that starts with a dash', async () => {
		const dir = goodPlugin(set, 'cmd-dash')
		const spy = vi.spyOn(process, 'cwd').mockReturnValue(set.base)
		const { code, stderr } = await run(['validate', '--', '-nowhere'])
		spy.mockRestore()
		expect(code).toBe(66)
		expect(stderr[0]).toContain('-nowhere')
		expect((await run(['validate', '--json', '--', dir])).code).toBe(0)
	})

	it('is 64 for a wrong command line, with the reason on standard error only', async () => {
		for (const args of [[], ['frobnicate'], ['validate', '--wat'], ['validate', 'a', 'b']]) {
			const { code, stdout, stderr } = await run(args)
			expect(code).toBe(64)
			expect(stdout).toBe('')
			expect(stderr).toHaveLength(1)
		}
	})

	it('checks the current folder when no path is given', async () => {
		const dir = goodPlugin(set, 'cmd-cwd')
		const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
		const { code } = await run(['validate'])
		spy.mockRestore()
		expect(code).toBe(0)
	})
})

describe('--json', () => {
	it('prints the one report on standard output and nothing else', async () => {
		const dir = caseDir('skill-name-mismatch')
		const { code, stdout } = await run(['validate', dir, '--json'])
		expect(code).toBe(1)
		expect(stdout.endsWith('\n')).toBe(true)
		const parsed = JSON.parse(stdout)
		expect(parsed).toEqual(JSON.parse(JSON.stringify(await validatePluginFolder(dir))))
		expect(parsed.version).toBe(1)
		expect(parsed.status).toBe('errors')
		expect(parsed.plugin).toEqual({ name: 'ledger', version: '1.0.0' })
	})

	it('also prints the report when the folder cannot be read', async () => {
		const { code, stdout } = await run(['validate', '--json', join(set.base, 'nowhere')])
		expect(code).toBe(66)
		const parsed = JSON.parse(stdout)
		expect(parsed).toMatchObject({ version: 1, status: 'unreadable', parts: [], problems: [] })
		expect(parsed.readError).toMatch(/does not exist/)
	})

	it('puts the same exit status on every status', async () => {
		for (const [name, expected] of [
			['only-a-skill', 0],
			['skill-unknown-key', 10],
			['skill-binary', 1],
		] as const) {
			expect((await run(['validate', caseDir(name), '--json'])).code).toBe(expected)
		}
	})
})

describe('the global --format json', () => {
	it('prints the same report as --json', async () => {
		const dir = caseDir('skill-unknown-key')
		const viaFlag = await run(['validate', dir, '--json'])
		const viaFormat = await run(['validate', dir], 'json')
		expect(viaFormat.stdout).toBe(viaFlag.stdout)
		expect(viaFormat.code).toBe(10)
	})
})

describe('the text report', () => {
	it('strips terminal control codes a plugin put in its own text', async () => {
		const dir = set.plugin('cmd-escape', {
			'plugin.json': JSON.stringify({
				name: 'ledger',
				version: '1.0.0',
				description: 'd',
				instructions: 'i',
				'\u001b[31mred': true,
			}),
		})
		const text = renderPluginReport(await validatePluginFolder(dir))
		expect(text).not.toContain('\u001b')
	})
})
