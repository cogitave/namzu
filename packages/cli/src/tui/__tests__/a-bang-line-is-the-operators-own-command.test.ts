import { describe, expect, it } from 'vitest'

import {
	describeShellEscape,
	describeShellEscapeForModel,
	runShellEscape,
	shellEscapeCommand,
} from '../shell-escape.js'

describe('a `!` line', () => {
	it('is a command only when something follows the bang', () => {
		expect(shellEscapeCommand('!ls -la')).toBe('ls -la')
		expect(shellEscapeCommand('!  ')).toBeNull()
		expect(shellEscapeCommand('hello!')).toBeNull()
	})

	it('runs on the host, captures both streams, and reports the exit', async () => {
		const result = await runShellEscape('printf out; printf err >&2; exit 3', {
			cwd: process.cwd(),
		})
		expect(result.output).toBe('outerr')
		expect(result.exitCode).toBe(3)
		expect(describeShellEscape('printf out', result)).toBe('! printf out · exit 3')
		expect(describeShellEscapeForModel('printf out', result)).toBe('$ printf out\nouterr\n(exit 3)')
	})

	it('kills a command that outlives the cap, with what it started', async () => {
		const startedAt = Date.now()
		const result = await runShellEscape('sleep 5 & wait', { cwd: process.cwd(), timeoutMs: 150 })
		expect(result.timedOut).toBe(true)
		expect(Date.now() - startedAt).toBeLessThan(3_000)
		expect(describeShellEscape('sleep 5 & wait', result)).toContain('killed after')
	})
})
