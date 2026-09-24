/**
 * `runScript`: the same `execHostShell` spawn the `bash` tool uses, given a
 * scheduled job's own script body directly (no tool call, no model).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostCommandShell } from '@namzu/sdk'
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

	it('refuses a dialect the host no longer resolves to, rather than silently switching shells', async () => {
		const other = host.dialect === 'bash' ? 'sh' : 'bash'
		const result = await runScript('echo hi', other, { cwd, env: process.env, timeoutMs: 5_000 })
		expect(result.dialectMismatch).toEqual({ expected: other, actual: host.dialect })
		expect(result.exitCode).toBeNull()
	})
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
