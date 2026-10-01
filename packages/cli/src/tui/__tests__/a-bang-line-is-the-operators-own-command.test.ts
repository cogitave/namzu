import { execHostShell } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	SHELL_ESCAPE_MAX_OUTPUT_CHARS,
	describeShellEscape,
	describeShellEscapeForModel,
	runShellEscape,
	shellEscapeCommand,
} from '../shell-escape.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const original = await importOriginal<typeof import('@namzu/sdk')>()
	return { ...original, execHostShell: vi.fn(original.execHostShell) }
})
afterEach(() => vi.mocked(execHostShell).mockClear())

describe('a `!` line', () => {
	it('is a command only when something follows the bang', () => {
		expect(shellEscapeCommand('!ls -la')).toBe('ls -la')
		expect(shellEscapeCommand('!  ')).toBeNull()
		expect(shellEscapeCommand('hello!')).toBeNull()
	})

	it('runs on the host, captures both streams, and reports the exit', async () => {
		const command =
			process.platform === 'win32'
				? 'echo out & echo err 1>&2 & exit /b 3'
				: 'printf out; printf err >&2; exit 3'
		const result = await runShellEscape(command, { cwd: process.cwd() })
		expect(result.output).toContain('out')
		expect(result.output).toContain('err')
		expect(result.exitCode).toBe(3)
		expect(describeShellEscape('printf out', result)).toBe('! printf out · exit 3')
		if (process.platform !== 'win32') {
			expect(result.output).toBe('outerr')
			expect(describeShellEscapeForModel('printf out', result)).toBe(
				'$ printf out\nouterr\n(exit 3)',
			)
		}
	})

	it('uses the platform shell on Windows and retains /bin/sh on POSIX', async () => {
		vi.mocked(execHostShell).mockResolvedValueOnce({ stdout: '', stderr: '' })
		await runShellEscape('echo ready', { cwd: process.cwd() })
		expect(vi.mocked(execHostShell).mock.calls[0]?.[1].shell).toEqual(
			process.platform === 'win32'
				? { path: undefined, dialect: 'cmd', source: 'platform' }
				: { path: '/bin/sh', dialect: 'sh', source: 'sh' },
		)
	})

	it('preserves shared-runner deadline cancellation and decoded progress', async () => {
		const controller = new AbortController()
		vi.mocked(execHostShell).mockImplementationOnce(async (_command, options) => {
			expect(options.timeout).toBe(150)
			expect(options.signal).toBe(controller.signal)
			options.onOutput?.({ stream: 'stdout', data: 'Türkçe 🧪' })
			throw Object.assign(new Error('timed out'), { code: null, timedOut: true })
		})
		const result = await runShellEscape('waiting-command', {
			cwd: process.cwd(),
			timeoutMs: 150,
			signal: controller.signal,
		})
		expect(result).toMatchObject({ timedOut: true, exitCode: null, output: 'Türkçe 🧪' })
		expect(describeShellEscape('waiting-command', result)).toContain('killed after')
	})

	it('bounds decoded transcript output and reports underlying byte truncation', async () => {
		vi.mocked(execHostShell).mockImplementationOnce(async (_command, options) => {
			options.onOutput?.({ stream: 'stdout', data: 'x'.repeat(SHELL_ESCAPE_MAX_OUTPUT_CHARS + 1) })
			throw Object.assign(new Error('buffer full'), { stdoutTruncated: true })
		})
		const result = await runShellEscape('verbose-command', { cwd: process.cwd() })
		expect(result.output.length).toBe(SHELL_ESCAPE_MAX_OUTPUT_CHARS)
		expect(result.truncated).toBe(true)
	})

	it('does not launch a pre-aborted command', async () => {
		const controller = new AbortController()
		controller.abort()
		const result = await runShellEscape('echo should-not-run', {
			cwd: process.cwd(),
			signal: controller.signal,
		})
		expect(result).toMatchObject({ output: '', exitCode: null, timedOut: false })
	})

	it('shows a spawn failure instead of an empty transcript', async () => {
		vi.mocked(execHostShell).mockRejectedValueOnce(new Error('spawn interpreter ENOENT'))
		const result = await runShellEscape('echo ready', { cwd: process.cwd() })
		expect(result.output).toBe('spawn interpreter ENOENT')
	})
})
