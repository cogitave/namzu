import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { LocalExecutionContext } from './local.js'

// `command`/`args` on executeCommand() come from whatever tool call invokes it, so they
// must be treated as untrusted. A single arg that smuggles a shell separator + a second
// command proves whether the child process was actually handed a shell.
function injectionArg(canaryPath: string): string {
	return process.platform === 'win32'
		? `& echo x> ${canaryPath} & rem`
		: `; echo x > ${canaryPath} #`
}

describe('LocalExecutionContext.executeCommand', () => {
	let dir: string
	let canary: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-local-exec-'))
		canary = join(dir, 'canary.txt')
	})

	afterEach(() => {
		removeTempDir(dir)
	})

	it('does not let a shell-metacharacter arg run a second command by default', async () => {
		const ctx = new LocalExecutionContext({ id: 'test', cwd: dir })
		await ctx.initialize()

		await ctx.executeCommand('node', ['--version', injectionArg(canary)])

		expect(existsSync(canary)).toBe(false)
	})

	it('still runs through a shell when explicitly requested', async () => {
		const ctx = new LocalExecutionContext({ id: 'test', cwd: dir })
		await ctx.initialize()

		await ctx.executeCommand('node', ['--version', injectionArg(canary)], { shell: true })

		expect(existsSync(canary)).toBe(true)
	})
})
