import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { smokeTestInstalled } from './apply.js'
import { type StartCheckDeps, runStartCheck } from './start-check.js'

function deps(over: Partial<StartCheckDeps> = {}): StartCheckDeps & { readonly written: string[] } {
	const written: string[] = []
	return {
		loadSession: async () => undefined,
		ptyInstalled: () => true,
		loadPty: async () => undefined,
		write: (text) => written.push(text),
		written,
		...over,
	}
}

describe('what a new copy must be able to load', () => {
	it('says ok when the session parts and the terminal-session module load', async () => {
		const d = deps()
		expect(await runStartCheck(d)).toBe(0)
		expect(d.written).toEqual(['ok\n'])
	})

	it('fails when the parts a session starts from cannot be loaded', async () => {
		const d = deps({
			loadSession: async () => {
				throw new Error("Cannot find module './chunks/tui-AAAA.js'")
			},
		})
		expect(await runStartCheck(d)).toBe(1)
		expect(d.written.join('')).toContain('tui-AAAA')
		expect(d.written.join('')).not.toContain('ok')
	})

	it('fails when the terminal-session module is installed but its native part will not load', async () => {
		const d = deps({
			loadPty: async () => {
				throw new Error('The module was compiled against a different Node.js version')
			},
		})
		expect(await runStartCheck(d)).toBe(1)
		expect(d.written.join('')).toContain('different Node.js version')
	})

	it('does not ask for a terminal-session module that was never installed', async () => {
		const d = deps({
			ptyInstalled: () => false,
			loadPty: async () => {
				throw new Error('must not be asked')
			},
		})
		expect(await runStartCheck(d)).toBe(0)
	})
})

describe('starting an installed copy', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-smoke-'))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	/** A package whose launcher answers `--version` and, when `onStartCheck` says so, `--start-check`. */
	function copy(version: string, onStartCheck: 'ok' | 'fail' | 'unknown'): string {
		const root = join(dir, `${version}-${onStartCheck}`)
		mkdirSync(join(root, 'dist'), { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: '@namzu/cli', version, bin: { namzu: 'dist/bin.js' } }),
		)
		writeFileSync(
			join(root, 'dist', 'bin.js'),
			[
				'const arg = process.argv[2]',
				`if (arg === '--version') { console.log('${version}'); process.exit(0) }`,
				onStartCheck === 'ok' &&
					`if (arg === '--start-check') { console.log('ok'); process.exit(0) }`,
				onStartCheck === 'fail' &&
					`if (arg === '--start-check') { console.log('start check failed: missing module'); process.exit(1) }`,
				// An older copy knows no such flag and starts a session, or says nothing useful, for it.
				`console.log('${version}')`,
			]
				.filter(Boolean)
				.join('\n'),
		)
		return root
	}

	it('accepts a copy that answers with its version and can start a session', async () => {
		expect(await smokeTestInstalled(copy('2.0.0', 'ok'), '2.0.0')).toBe(true)
	})

	it('refuses a copy that names its version but cannot load what a session needs', async () => {
		const root = copy('2.0.0', 'fail')
		expect(await smokeTestInstalled(root, '2.0.0')).toBe(false)
		expect(await smokeTestInstalled(root, '2.0.0', 'session')).toBe(false)
	})

	it('refuses a copy that does not answer the start check at all', async () => {
		expect(await smokeTestInstalled(copy('2.0.0', 'unknown'), '2.0.0')).toBe(false)
	})

	it('refuses a copy that names another version', async () => {
		expect(await smokeTestInstalled(copy('1.0.0', 'ok'), '2.0.0')).toBe(false)
	})

	it('asks only for the version when checking a copy that is being put back', async () => {
		// Versions from before the start check existed are never asked for it.
		expect(await smokeTestInstalled(copy('1.0.0', 'unknown'), '1.0.0', 'version')).toBe(true)
	})

	it('refuses a folder with no readable package', async () => {
		expect(await smokeTestInstalled(join(dir, 'missing'), '1.0.0')).toBe(false)
	})
})
