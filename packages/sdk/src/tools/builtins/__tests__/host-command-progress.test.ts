import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

const { startSpawn, stopTree } = vi.hoisted(() => ({ startSpawn: vi.fn(), stopTree: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return {
		...actual,
		spawn: startSpawn,
	}
})

vi.mock('../../../process/kill-tree.js', () => ({ killTree: stopTree }))

afterEach(() => {
	startSpawn.mockReset()
	stopTree.mockReset()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

/** Keep the child pending until the test has inspected its live feedback. */
function command() {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const child = Object.assign(new EventEmitter(), { stdout, stderr })
	startSpawn.mockReturnValue(child)
	return {
		stdout,
		stderr,
		finish: (code: number | null = 0, signal: string | null = null) => {
			stdout.end()
			stderr.end()
			child.emit('close', code, signal)
		},
	}
}

function context(report: ToolContext['report']): ToolContext {
	return { workingDirectory: '/workspace', report } as ToolContext
}

describe('a foreground command on the host', () => {
	it('reports both streams before completion and keeps fragmented lines separate', async () => {
		const child = command()
		const report = vi.fn()
		const pending = BashTool.execute({ command: 'build', timeout: 1000 }, context(report))
		try {
			child.stdout.write('compil')
			child.stderr.write('warning: unused import\n')
			child.stdout.write('ing module one\n')

			expect(report.mock.calls.map(([message]) => message)).toEqual([
				'compil',
				'warning: unused import',
				'compiling module one',
			])
		} finally {
			child.finish()
		}
		const result = await pending
		expect(result.output).toContain('STDOUT:\ncompiling module one')
		expect(result.output).toContain('STDERR:\nwarning: unused import')
		const count = report.mock.calls.length
		child.stdout.emit('data', Buffer.from('late output'))
		expect(report).toHaveBeenCalledTimes(count)
	})

	it('bounds newline-free output and decodes UTF-8 split across chunks', async () => {
		const child = command()
		const report = vi.fn()
		const pending = BashTool.execute({ command: 'build', timeout: 1000 }, context(report))
		try {
			child.stdout.write('x'.repeat(100_000))
			expect(report).toHaveBeenCalled()
			expect(report.mock.lastCall?.[0].length).toBeLessThanOrEqual(160)
			child.stdout.write('\n')
			const unicode = Buffer.from('completed 😀')
			child.stdout.write(unicode.subarray(0, unicode.length - 2))
			child.stdout.write(unicode.subarray(unicode.length - 2))
			expect(report).toHaveBeenLastCalledWith('completed 😀')
			expect(report.mock.calls.every(([message]) => !message.includes('�'))).toBe(true)
		} finally {
			child.finish()
		}
		expect((await pending).output).toBe(`STDOUT:\n${'x'.repeat(100_000)}\ncompleted 😀`)
	})

	it('does not turn a failed progress observer into a command failure', async () => {
		const child = command()
		const pending = BashTool.execute(
			{ command: 'build', timeout: 1000 },
			context(() => {
				throw new Error('display closed')
			}),
		)
		try {
			expect(() => child.stdout.write('still working\n')).not.toThrow()
		} finally {
			child.finish()
		}
		expect((await pending).success).toBe(true)
	})

	it('keeps the per-stream output cap as a failure instead of silently truncating success', async () => {
		vi.stubEnv('NAMZU_BASH_MAX_BUFFER_BYTES', '8')
		vi.resetModules()
		const { BashTool: boundedBash } = await import('../bash.js')
		const child = command()
		const pending = boundedBash.execute({ command: 'build', timeout: 1000 }, context(undefined))
		child.stdout.write('0123456789')
		child.stderr.write('failure')
		child.finish(null, 'SIGTERM')
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.error).toContain('stdout maxBuffer length exceeded')
		expect(result.output).toContain('STDOUT:\n01234567\n\nSTDERR:\nfailure')
		expect(result.output).not.toContain('0123456789')
		expect(result.data).toMatchObject({ timedOut: false })
		expect(stopTree.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
	})

	it('keeps only complete UTF-8 characters at an output limit', async () => {
		vi.stubEnv('NAMZU_BASH_MAX_BUFFER_BYTES', '8')
		vi.resetModules()
		const { BashTool: boundedBash } = await import('../bash.js')
		const child = command()
		const pending = boundedBash.execute({ command: 'build', timeout: 1000 }, context(undefined))
		child.stdout.write('123456😀')
		child.finish(null, 'SIGTERM')
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.output).toContain('STDOUT:\n123456')
		expect(result.output).not.toContain('�')
		expect(result.output).not.toContain('😀')
	})

	it('reports clipping during timeout grace without replacing the timeout cause', async () => {
		vi.stubEnv('NAMZU_BASH_MAX_BUFFER_BYTES', '8')
		vi.resetModules()
		const { BashTool: boundedBash } = await import('../bash.js')
		vi.useFakeTimers()
		const child = command()
		const pending = boundedBash.execute({ command: 'build', timeout: 1000 }, context(undefined))
		child.stdout.write('before')
		await vi.advanceTimersByTimeAsync(1000)
		child.stdout.write(' and after the deadline')
		child.stderr.write('cleanup error')
		child.finish(null, 'SIGTERM')
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.error).toContain('timed out after 1000ms')
		expect(result.data).toMatchObject({
			timedOut: true,
			stdoutTruncated: true,
			stderrTruncated: true,
		})
		expect(result.output).toContain('STDOUT:\nbefore a')
		expect(result.output).toContain('STDERR:\ncleanup ')
		expect(result.output).toContain('stdout and stderr were truncated')
		expect(stopTree.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
	})
})
