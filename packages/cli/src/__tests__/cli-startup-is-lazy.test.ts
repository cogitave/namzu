import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

/**
 * `namzu --version` and `namzu --help` must not load `@namzu/sdk`: commander
 * answers them before any command runs, and compiling the SDK first cost
 * about 400 ms to print one line. The SDK module is replaced by one that
 * records the import and throws, so a static import anywhere on the path
 * fails the test at the line that caused it.
 */

afterEach(() => {
	vi.restoreAllMocks()
	vi.doUnmock('@namzu/sdk')
	vi.resetModules()
})

async function runWithoutSdk(argv: string[]) {
	vi.resetModules()
	const loads: string[] = []
	vi.doMock('@namzu/sdk', () => {
		loads.push('@namzu/sdk')
		throw new Error('the SDK was loaded')
	})
	let out = ''
	vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
		out += String(chunk)
		return true
	}) as typeof process.stdout.write)
	const { runCli } = await import('../cli.js')
	const code = await runCli({ argv: ['node', 'namzu', ...argv] })
	return { code, out, loads }
}

describe('the command shell', () => {
	it('prints the version without loading the SDK', async () => {
		const { code, out, loads } = await runWithoutSdk(['--version'])

		expect(code).toBe(0)
		expect(out).toMatch(/^\d+\.\d+\.\d+/)
		expect(loads).toEqual([])
	})

	it('prints the root help, with every command, without loading the SDK', async () => {
		const { code, out, loads } = await runWithoutSdk(['--help'])

		expect(code).toBe(0)
		for (const name of ['exec|e', 'acp', 'worktree', 'resume', 'providers-json'])
			expect(out).toContain(name)
		expect(out).toContain('--permission-mode <mode>')
		expect(out.replace(/\s+/g, ' ')).toContain(
			'(choices: "prompt", "accept-edits", "plan", "bypass", "auto", "strict")',
		)
		expect(loads).toEqual([])
	})
})

describe('a command behind the lazy definitions', () => {
	it('still runs: its module is loaded when it is asked for', async () => {
		vi.resetModules()
		const home = mkdtempSync(join(tmpdir(), 'namzu-lazy-'))
		vi.stubEnv('NAMZU_HOME', home)
		let written = ''
		const grab = ((chunk: string | Uint8Array) => {
			written += String(chunk)
			return true
		}) as typeof process.stdout.write
		vi.spyOn(process.stdout, 'write').mockImplementation(grab)
		vi.spyOn(process.stderr, 'write').mockImplementation(grab)
		try {
			const { runCli } = await import('../cli.js')

			expect(await runCli({ argv: ['node', 'namzu', 'serve'] })).toBe(0)
			expect(written).toContain('namzu needs no central server')
		} finally {
			vi.unstubAllEnvs()
			removeTempDir(home)
		}
	})

	it('reports an unknown command as a usage error, as before', async () => {
		const { code } = await runWithoutSdk(['no-such-command'])

		expect(code).toBe(64)
	})
})
