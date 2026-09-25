/**
 * `runScript`: the same `execHostShell` spawn the `bash` tool uses, given a
 * scheduled job's own script body directly (no tool call, no model).
 */

import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostCommandShell, installedCommandShellForDialect } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capOutput, runScript } from '../run-script.js'

let cwd: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-run-script-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const host = hostCommandShell()

describe('runScript', () => {
	it('captures stdout/stderr and exits 0 on success', async () => {
		const result = await runScript('echo out; echo err 1>&2', host.dialect, {
			cwd,
			env: process.env,
			timeoutMs: 5_000,
		})
		expect(result.exitCode).toBe(0)
		expect(result.stdout.trim()).toBe('out')
		expect(result.stderr.trim()).toBe('err')
		expect(result.timedOut).toBe(false)
	})

	it('reports a non-zero exit code', async () => {
		const result = await runScript('exit 3', host.dialect, {
			cwd,
			env: process.env,
			timeoutMs: 5_000,
		})
		expect(result.exitCode).toBe(3)
	})

	it('times out a script that runs past its own clock', async () => {
		const result = await runScript('sleep 5', host.dialect, {
			cwd,
			env: process.env,
			timeoutMs: 200,
		})
		expect(result.timedOut).toBe(true)
	}, 10_000)

	it('runs in the given working directory', async () => {
		const result = await runScript('pwd', host.dialect, { cwd, env: process.env, timeoutMs: 5_000 })
		expect(result.stdout.trim()).toBe(cwd)
	})

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('sh'))(
		'runs the requested sh even if the live bash tool selected bash',
		async () => {
			const selected = installedCommandShellForDialect('sh')
			const result = await runScript('printf "%s" "$0"', 'sh', {
				cwd,
				env: process.env,
				timeoutMs: 5_000,
			})
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toBe(selected?.path)
		},
	)

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('bash'))(
		'refuses a requested interpreter removed after confirmation',
		async () => {
			const executable = installedCommandShellForDialect('bash')?.path as string
			const custom = join(cwd, 'bash')
			const previous = process.env.NAMZU_BASH_SHELL
			symlinkSync(executable, custom)
			try {
				process.env.NAMZU_BASH_SHELL = custom
				expect(installedCommandShellForDialect('bash')?.path).toBe(custom)
				unlinkSync(custom)
				const result = await runScript('echo should-not-run', 'bash', {
					cwd,
					env: process.env,
					timeoutMs: 5_000,
				})
				expect(result.shellUnavailable).toBe('bash')
				expect(result.exitCode).toBeNull()
			} finally {
				if (previous === undefined) Reflect.deleteProperty(process.env, 'NAMZU_BASH_SHELL')
				else process.env.NAMZU_BASH_SHELL = previous
			}
		},
	)

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('bash'))(
		'reports the selected executable removed before spawn even if another bash exists',
		async () => {
			const executable = installedCommandShellForDialect('bash')?.path as string
			const custom = join(cwd, 'bash')
			symlinkSync(executable, custom)
			unlinkSync(custom)
			const result = await runScript('echo should-not-run', 'bash', {
				cwd,
				env: process.env,
				timeoutMs: 5_000,
				resolvedShell: { path: custom, dialect: 'bash', source: 'override' },
			})
			expect(result.shellUnavailable).toBe('bash')
			expect(result.exitCode).toBeNull()
		},
	)

	it.skipIf(process.platform === 'win32' || !installedCommandShellForDialect('bash'))(
		'does not blame the interpreter when the working directory is missing',
		async () => {
			const result = await runScript('echo should-not-run', 'bash', {
				cwd: join(cwd, 'missing'),
				env: process.env,
				timeoutMs: 5_000,
			})
			expect(result.shellUnavailable).toBeUndefined()
			expect(result.exitCode).toBeNull()
		},
	)
})

describe('capOutput', () => {
	it('leaves short output untouched', () => {
		expect(capOutput('hi')).toBe('hi')
	})

	it('cuts long output with an explicit marker, never silently', () => {
		const long = 'x'.repeat(20_000)
		const capped = capOutput(long, 100)
		expect(capped.length).toBeLessThan(long.length)
		expect(capped.endsWith('...(truncated)')).toBe(true)
		expect(capped.startsWith('x'.repeat(100))).toBe(true)
	})
})
