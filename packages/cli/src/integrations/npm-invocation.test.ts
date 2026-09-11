import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { runNpmUpgrade } from '../commands/upgrade.js'
import * as npmInvocation from './npm-invocation.js'
import { runSetupCommand } from './providers/setup.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots) removeTempDir(root)
	roots.length = 0
})

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu npm & %PATH% !-'))
	roots.push(root)
	const npmCli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
	mkdirSync(dirname(npmCli), { recursive: true })
	writeFileSync(npmCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
	return { root, npmCli, nodeExecutable: join(root, 'node.exe') }
}

describe('npm invocation on native Windows', () => {
	it('runs bundled npm as JavaScript with literal paths and arguments', () => {
		const { root, nodeExecutable, npmCli } = fixture()
		const args = ['install', '--prefix', join(root, 'a&b%PATH%!'), '@namzu/cli@1.2.3']
		const invocation = npmInvocation.resolveNpmInvocation('npm.cmd', args, 'win32', nodeExecutable)
		expect(invocation.executable).toBe(nodeExecutable)
		expect(invocation.args[0]).toBe(npmCli)
		// Execute only the synthetic script with the real host Node. A shell
		// would expand or split these arguments on one of the supported systems.
		const child = spawnSync(process.execPath, [...invocation.args], {
			encoding: 'utf8',
			shell: false,
		})
		expect(child.status).toBe(0)
		expect(JSON.parse(child.stdout)).toEqual(args)
	})

	it('reports an unavailable bundle instead of interpreting an ambient npm wrapper', () => {
		const { root } = fixture()
		expect(() =>
			npmInvocation.resolveNpmInvocation(
				'npm',
				['--version'],
				'win32',
				join(root, 'missing', 'node.exe'),
			),
		).toThrow(/npm's JavaScript entry point is unavailable.*Repair that Node installation/)
	})

	it('keeps POSIX npm and unrelated Windows commands on their original argv path', () => {
		const args = ['--version']
		expect(npmInvocation.resolveNpmInvocation('npm', args, 'linux', '/unused/node')).toEqual({
			executable: 'npm',
			args,
		})
		expect(npmInvocation.resolveNpmInvocation('claude', args, 'win32', 'unused')).toEqual({
			executable: 'claude',
			args,
		})
	})

	it('routes setup installation through the resolver and retains its output', async () => {
		const { root, npmCli } = fixture()
		const args = ['install', '--global', '@anthropic-ai/claude-code']
		const resolve = vi.spyOn(npmInvocation, 'resolveNpmInvocation').mockReturnValue({
			executable: process.execPath,
			args: [npmCli, ...args],
		})
		const result = await runSetupCommand('npm', args, {
			cwd: root,
			signal: new AbortController().signal,
			timeoutMs: 3000,
		})
		expect(resolve).toHaveBeenCalledWith('npm', args)
		expect(result.code).toBe(0)
		expect(JSON.parse(result.output)).toEqual(args)
	})

	it('routes upgrade through the same resolver without changing its exact prefix', async () => {
		const { root, npmCli } = fixture()
		const args = ['install', '--global', '--prefix', root, '@namzu/cli@1.2.3']
		const resolve = vi.spyOn(npmInvocation, 'resolveNpmInvocation').mockReturnValue({
			executable: process.execPath,
			args: [npmCli, ...args],
		})
		let output = ''
		const code = await runNpmUpgrade({
			executable: 'npm.cmd',
			args,
			prefix: root,
			onOutput: (text) => {
				output += text
			},
		})
		expect(resolve).toHaveBeenCalledWith('npm.cmd', args)
		expect(code).toBe(0)
		expect(JSON.parse(output)).toEqual(args)
	})
})
