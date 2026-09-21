import { describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { RUN_CODE_TOOL_NAME, buildRunCodeTool } from '../run-code.js'

/**
 * A program the model wrote, reaching no further than the run.
 *
 * Twenty tool calls to filter a list is twenty model turns at full context
 * size. The same work is one loop. That argument only holds if the loop
 * cannot reach further than the twenty calls could have — so what is tested
 * here is the boundary, not the convenience.
 *
 * Process-level, because the program runs in a real worker thread and a
 * mocked one would prove only that the mock was called.
 */

const tool = buildRunCodeTool({ timeoutMs: 5_000 })

function contextWith(
	over: Partial<ToolContext> = {},
	dispatched: { calls: { name: string; input: unknown }[] } = { calls: [] },
): ToolContext {
	return {
		runId: 'run_code' as RunId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		dispatchTool: async (name, input): Promise<ToolResult> => {
			dispatched.calls.push({ name, input })
			return { success: true, output: `${name} ran` }
		},
		...over,
	}
}

describe('a program calls the run’s own tools', () => {
	it('reaches a tool and gets its output', async () => {
		const dispatched = { calls: [] as { name: string; input: unknown }[] }
		const result = await tool.execute(
			{ code: 'return await call("read", { path: "a.txt" })', tools: ['read'] },
			contextWith({}, dispatched),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('read ran')
		expect(dispatched.calls).toEqual([{ name: 'read', input: { path: 'a.txt' } }])
	})

	it('loops, which is the entire point', async () => {
		const dispatched = { calls: [] as { name: string; input: unknown }[] }
		await tool.execute(
			{
				code: 'for (const p of ["a", "b", "c"]) await call("read", { path: p }); return "done"',
				tools: ['read'],
			},
			contextWith({}, dispatched),
		)

		expect(dispatched.calls.map((c) => (c.input as { path: string }).path)).toEqual(['a', 'b', 'c'])
	})

	it('carries a tool failure into the program as a rejection', async () => {
		const result = await tool.execute(
			{
				code: 'try { await call("write", {}) } catch (e) { return "caught: " + e.message }',
				tools: ['write'],
			},
			contextWith({
				dispatchTool: async () => ({ success: false, output: '', error: 'permission denied' }),
			}),
		)

		expect(result.output).toContain('caught: permission denied')
	})
})

describe('the program cannot widen its own grant', () => {
	it('is refused a tool the TURN did not allow, even when it asked for it', async () => {
		// `tools` is model-authored. A program that listed every tool it
		// wished for would otherwise widen its own grant, which is the
		// privilege escalation this design exists to prevent.
		const dispatched = { calls: [] as { name: string; input: unknown }[] }
		const result = await tool.execute(
			{
				code: 'try { await call("bash", {}) } catch (e) { return e.message }',
				tools: ['read', 'bash'],
			},
			contextWith({ allowedTools: ['read'] }, dispatched),
		)

		expect(dispatched.calls).toEqual([])
		expect(String(result.output)).toMatch(/not granted/)
	})

	it('says which names it withheld, and what the turn allows', async () => {
		// So the model can correct itself in the same turn rather than
		// spending another one guessing.
		const result = await tool.execute(
			{ code: 'return 1', tools: ['read', 'bash', 'write'] },
			contextWith({ allowedTools: ['read'] }),
		)

		expect(result.output).toContain('bash, write')
		expect(result.output).toContain('read')
	})

	it('grants everything it asked for when the turn is unrestricted', async () => {
		const dispatched = { calls: [] as { name: string; input: unknown }[] }
		await tool.execute(
			{ code: 'await call("anything", {}); return 1', tools: ['anything'] },
			contextWith({}, dispatched),
		)

		expect(dispatched.calls.map((c) => c.name)).toEqual(['anything'])
	})

	it('refuses a tool it did not list, even when the turn allows it', async () => {
		// The program's own list is a ceiling as well as a request: a program
		// that declared two tools and reached for a third has done something
		// its author did not describe.
		const dispatched = { calls: [] as { name: string; input: unknown }[] }
		await tool.execute(
			{ code: 'try { await call("write", {}) } catch {}; return 1', tools: ['read'] },
			contextWith({ allowedTools: ['read', 'write'] }, dispatched),
		)

		expect(dispatched.calls).toEqual([])
	})
})

describe('the program has nothing else', () => {
	it('cannot require, read the process, or fetch', async () => {
		const result = await tool.execute(
			{ code: 'return [typeof require, typeof process, typeof fetch].join(",")', tools: [] },
			contextWith(),
		)

		expect(result.output).toContain('undefined,undefined,undefined')
	})

	it('says so when the run offers no dispatch at all', async () => {
		const result = await tool.execute(
			{ code: 'return 1', tools: [] },
			contextWith({ dispatchTool: undefined }),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/no way to dispatch/)
	})
})

describe('a program that misbehaves is a failed tool call, not a stuck run', () => {
	it('is stopped at the timeout, keeping what it printed', async () => {
		// A program that printed its progress and then hung has told the
		// model where it got to; discarding that leaves it retrying from the
		// start.
		const bounded = buildRunCodeTool({ timeoutMs: 200 })

		const result = await bounded.execute(
			{ code: 'print("reached step 1"); while (true) {}', tools: [] },
			contextWith(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/longer than 200ms/)
		expect(result.output).toContain('reached step 1')
	})

	it('reports a throw with its message', async () => {
		const result = await tool.execute(
			{ code: 'throw new Error("bad input")', tools: [] },
			contextWith(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toBe('bad input')
	})

	it('says when output was cut', async () => {
		const chatty = buildRunCodeTool({ timeoutMs: 5_000, maxOutputBytes: 100 })

		const result = await chatty.execute(
			{ code: 'for (let i = 0; i < 200; i++) print("x".repeat(40)); return 1', tools: [] },
			contextWith(),
		)

		expect(result.output).toContain('cut here')
	})
})

describe('what the tool declares about itself', () => {
	it('is neither read-only nor non-destructive', async () => {
		// Its effects are the union of the tools it calls, which is not
		// knowable from the input — and `readOnly: true` would let a
		// read-only preset auto-approve a program whose whole purpose is
		// calling something else.
		expect(tool.name).toBe(RUN_CODE_TOOL_NAME)
		expect(tool.isReadOnly?.({ code: '', tools: [] })).toBe(false)
		expect(tool.isDestructive?.({ code: '', tools: [] })).toBe(true)
	})
})
