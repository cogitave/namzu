import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

const { startExec } = vi.hoisted(() => ({ startExec: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return {
		...actual,
		exec: Object.assign(vi.fn(), {
			[Symbol.for('nodejs.util.promisify.custom')]: startExec,
		}),
	}
})

afterEach(() => startExec.mockReset())

/** Keep the child pending until the test has inspected its live feedback. */
function command() {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	let finish!: (output: { stdout: string; stderr: string }) => void
	const result = new Promise<{ stdout: string; stderr: string }>((resolve) => {
		finish = resolve
	})
	startExec.mockReturnValue(Object.assign(result, { child: { stdout, stderr } }))
	return { stdout, stderr, finish }
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
			child.finish({ stdout: 'compiling module one\n', stderr: 'warning: unused import\n' })
		}
		const result = await pending
		expect(result.output).toContain('STDOUT:\ncompiling module one')
		expect(result.output).toContain('STDERR:\nwarning: unused import')
		const count = report.mock.calls.length
		child.stdout.write('late output')
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
			child.finish({ stdout: 'full output', stderr: '' })
		}
		expect((await pending).output).toBe('STDOUT:\nfull output')
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
			child.finish({ stdout: 'done', stderr: '' })
		}
		expect((await pending).success).toBe(true)
	})
})
