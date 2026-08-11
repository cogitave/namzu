import { describe, expect, it, vi } from 'vitest'

import type { Sandbox, SandboxExecOptions } from '../../../types/sandbox/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'

/**
 * Every container worker streams its output a chunk at a time, and every
 * backend concatenated those chunks and returned the string when the
 * process exited. `ToolContext.report` — the channel that exists precisely
 * to answer "is it still working?" — had no caller anywhere in the tree.
 *
 * So a command that ran for eight minutes said nothing for eight minutes,
 * over a transport that had been reporting the whole time.
 *
 * These tests are about the wire between those two halves. They assert
 * that output reaches `report` BEFORE the command settles, because
 * reporting it afterwards is indistinguishable from not reporting it.
 */

/** A sandbox that emits the given chunks, then finishes. */
function streamingSandbox(chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>): {
	sandbox: Sandbox
	settle: () => void
} {
	let release: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})

	const sandbox = {
		async exec(_cmd: string, _args: string[], options?: SandboxExecOptions) {
			for (const chunk of chunks) options?.onOutput?.(chunk)
			// Nothing has settled yet: anything asserted after this await
			// would prove only that the output arrived eventually.
			await gate
			return {
				stdout: chunks
					.filter((c) => c.stream === 'stdout')
					.map((c) => c.data)
					.join(''),
				stderr: '',
				exitCode: 0,
				timedOut: false,
				durationMs: 1,
			}
		},
	} as unknown as Sandbox

	return { sandbox, settle: () => release?.() }
}

function contextWith(sandbox: Sandbox, report?: ToolContext['report']): ToolContext {
	return {
		runId: 'run_1',
		workingDirectory: '/workspace',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		sandbox,
		...(report ? { report } : {}),
	} as unknown as ToolContext
}

describe('a command running in a sandbox', () => {
	it('reports output while it is still running, not after it ends', async () => {
		const report = vi.fn()
		const { sandbox, settle } = streamingSandbox([
			{ stream: 'stdout', data: 'compiling module one\n' },
			{ stream: 'stdout', data: 'compiling module two\n' },
		])

		const pending = BashTool.execute(
			{ command: 'build', timeout: 1000 },
			contextWith(sandbox, report),
		)
		await Promise.resolve()

		// The assertion that matters. The command has NOT finished here.
		expect(report).toHaveBeenCalledWith('compiling module one')
		expect(report).toHaveBeenCalledWith('compiling module two')

		settle()
		await pending
	})

	it('sends one line rather than the whole chunk', async () => {
		// A progress slot renders one line and replaces it. Sending a chunk
		// sends a wall of text into a space that shows the first line of it.
		const report = vi.fn()
		const { sandbox, settle } = streamingSandbox([
			{ stream: 'stdout', data: 'first\nsecond\nthird\n' },
		])

		const pending = BashTool.execute(
			{ command: 'build', timeout: 1000 },
			contextWith(sandbox, report),
		)
		await Promise.resolve()

		expect(report).toHaveBeenCalledTimes(1)
		expect(report).toHaveBeenCalledWith('third')

		settle()
		await pending
	})

	it('says nothing for a chunk that is only whitespace', async () => {
		// Progress that says nothing still repaints the slot, so a build
		// emitting blank lines would flicker while conveying nothing.
		const report = vi.fn()
		const { sandbox, settle } = streamingSandbox([{ stream: 'stdout', data: '\n\n   \n' }])

		const pending = BashTool.execute(
			{ command: 'build', timeout: 1000 },
			contextWith(sandbox, report),
		)
		await Promise.resolve()

		expect(report).not.toHaveBeenCalled()

		settle()
		await pending
	})

	it('still returns the complete output, which is what the model is given', async () => {
		// Progress is ephemeral and excluded from the durable transcript.
		// If it ever became the tool's answer, the model would be handed a
		// status line instead of the command's output.
		const { sandbox, settle } = streamingSandbox([
			{ stream: 'stdout', data: 'first\n' },
			{ stream: 'stdout', data: 'second\n' },
		])

		const pending = BashTool.execute(
			{ command: 'build', timeout: 1000 },
			contextWith(sandbox, vi.fn()),
		)
		settle()
		const result = await pending

		expect(result.output).toContain('first')
		expect(result.output).toContain('second')
	})

	it('runs unchanged when the host supplies no progress channel', async () => {
		// `report` is optional on `ToolContext`. A host that never wired it
		// must not get a crash out of a tool trying to use it.
		const { sandbox, settle } = streamingSandbox([{ stream: 'stdout', data: 'output\n' }])

		const pending = BashTool.execute({ command: 'build', timeout: 1000 }, contextWith(sandbox))
		settle()
		const result = await pending

		expect(result.success).toBe(true)
		expect(result.output).toContain('output')
	})
})
