import { describe, expect, it } from 'vitest'

import {
	type ShellHookEntry,
	type ShellHookOutcome,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'

const entry: ShellHookEntry = { command: 'x' }
const blocking: ShellHookEntry = { command: 'x', onFailure: 'block' }
const answer = (value: unknown, exitCode = 0): ShellHookOutcome => ({
	exitCode,
	timedOut: false,
	stdout: typeof value === 'string' ? value : JSON.stringify(value),
	stderr: '',
})
const post = (updated: Record<string, unknown>) =>
	answer({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...updated } })

describe('the payload of a tool event', () => {
	const base = { event: 'pre_tool_use' as const, cwd: '/p', sessionId: 's' }

	it('carries tool_use_id when the call has one, and not otherwise', () => {
		const withId = JSON.parse(shellHookPayload({ ...base, toolName: 'bash', toolCallId: 'call_1' }))
		expect(withId.tool_use_id).toBe('call_1')
		expect(JSON.parse(shellHookPayload({ ...base, toolName: 'bash' })).tool_use_id).toBeUndefined()
	})

	it('adds file_path beside path for a file tool, and never removes path', () => {
		for (const tool of ['read', 'write', 'edit', 'grep', 'glob', 'ls', 'view_image', 'lsp']) {
			const sent = JSON.parse(
				shellHookPayload({ ...base, toolName: tool, toolInput: { path: 'a/b.ts', x: 1 } }),
			)
			expect(sent.tool_input).toEqual({ path: 'a/b.ts', x: 1, file_path: 'a/b.ts' })
		}
	})

	it('leaves other tools, and a file tool with no path, as they are', () => {
		const same = (toolName: string, toolInput: unknown) =>
			JSON.parse(shellHookPayload({ ...base, toolName, toolInput })).tool_input
		expect(same('bash', { command: 'ls', path: 'x' })).toEqual({ command: 'ls', path: 'x' })
		expect(same('mcp__s__t', { path: 'x' })).toEqual({ path: 'x' })
		expect(same('grep', { pattern: 'a' })).toEqual({ pattern: 'a' })
	})

	it('adds it inside post_tool_batch calls too', () => {
		const sent = JSON.parse(
			shellHookPayload({
				...base,
				event: 'post_tool_batch',
				toolCalls: [
					{
						toolCallId: 'c',
						toolName: 'read',
						toolInput: { path: 'a' },
						output: '',
						isError: false,
					},
				],
			}),
		)
		expect(sent.tool_calls[0].tool_input).toEqual({ path: 'a', file_path: 'a' })
	})
})

describe('a rewritten input with the echoed file_path', () => {
	const rewrite = (updatedInput: Record<string, unknown>, toolName = 'read') =>
		shellHookVerdict(
			'pre_tool_use',
			entry,
			answer({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }),
			undefined,
			{ toolName, toolInput: { path: '/a', limit: 5 } },
		)

	it('drops the echo when neither key changed', () => {
		expect(rewrite({ path: '/a', file_path: '/a', limit: 9 })).toMatchObject({
			action: 'modify',
			input: { path: '/a', limit: 9 },
		})
	})
	it('takes a changed file_path as the new path', () => {
		expect(rewrite({ path: '/a', file_path: '/b', limit: 5 })).toMatchObject({
			input: { path: '/b', limit: 5 },
		})
		expect(rewrite({ file_path: '/b' })).toMatchObject({ input: { path: '/b' } })
	})
	it('takes a changed path as the new path', () => {
		expect(rewrite({ path: '/b', file_path: '/a' })).toMatchObject({ input: { path: '/b' } })
	})
	it('accepts both changed to the same value', () => {
		expect(rewrite({ path: '/b', file_path: '/b' })).toMatchObject({ input: { path: '/b' } })
	})
	it('reads both changed to different values as an unreadable answer', () => {
		expect(rewrite({ path: '/b', file_path: '/c' })).toEqual({ action: 'continue' })
		expect(
			shellHookVerdict(
				'pre_tool_use',
				blocking,
				answer({
					hookSpecificOutput: {
						hookEventName: 'PreToolUse',
						updatedInput: { path: '/b', file_path: '/c' },
					},
				}),
				undefined,
				{ toolName: 'read', toolInput: { path: '/a' } },
			),
		).toMatchObject({ action: 'skip' })
	})
	it('does not touch a tool that is not a file tool', () => {
		expect(rewrite({ path: '/a', file_path: '/z' }, 'mcp__s__t')).toMatchObject({
			input: { path: '/a', file_path: '/z' },
		})
	})
})

describe('a replacement of any type', () => {
	const text = (updated: unknown, call = { toolName: 'bash' }, extra = {}) =>
		shellHookVerdict(
			'post_tool_use',
			entry,
			post({ updatedToolOutput: updated, ...extra }),
			undefined,
			call,
		)

	it('reads a string as it is, an empty one included', () => {
		expect(text('a')).toMatchObject({ action: 'replace', output: 'a', disclose: true })
		expect(text('')).toMatchObject({ action: 'replace', output: '' })
	})
	it('reads the result shape as that', () => {
		expect(text({ output: 'x' })).toMatchObject({ output: 'x' })
		expect(text({ success: true, output: 'x' })).toMatchObject({ output: 'x' })
		expect(text({ success: false, output: 'x', error: 'boom' })).toMatchObject({
			output: 'x\n\nError: boom',
		})
		expect(text({ success: false, output: '', error: 'boom' })).toMatchObject({
			output: 'Error: boom',
		})
	})
	it('shows anything else as its JSON text', () => {
		expect(text({ a: 1 })).toMatchObject({ output: '{"a":1}' })
		expect(text({ output: 5 })).toMatchObject({ output: '{"output":5}' })
		expect(text({ output: 'x', success: 'yes' })).toMatchObject({
			output: '{"output":"x","success":"yes"}',
		})
		expect(text([1, 'a'])).toMatchObject({ output: '[1,"a"]' })
		expect(text(0)).toMatchObject({ output: '0' })
		expect(text(false)).toMatchObject({ output: 'false' })
	})
	it('takes null as no replacement', () => {
		expect(text(null)).toEqual({ action: 'continue' })
	})
	it('keeps the size limit, marking a cut', () => {
		const out = text('y'.repeat(40_000)) as { output: string }
		expect(out.output.endsWith('\n[truncated]')).toBe(true)
		expect(out.output.length).toBe(32_000 + '\n[truncated]'.length)
		const json = text({ big: 'y'.repeat(40_000) }) as { output: string }
		expect(json.output.endsWith('\n[truncated]')).toBe(true)
	})
	it('reads updatedMCPToolOutput for a tool-server tool only, and updatedToolOutput wins', () => {
		const server = { toolName: 'mcp__srv__t' }
		const ask = (call: { toolName: string }, fields: Record<string, unknown>) =>
			shellHookVerdict('post_tool_use', entry, post(fields), undefined, call)
		expect(ask(server, { updatedMCPToolOutput: { a: 1 } })).toMatchObject({ output: '{"a":1}' })
		expect(ask(server, { updatedMCPToolOutput: 'm', updatedToolOutput: 'g' })).toMatchObject({
			output: 'g',
		})
		expect(ask(server, { updatedMCPToolOutput: 'm', updatedToolOutput: null })).toMatchObject({
			output: 'm',
		})
		expect(ask({ toolName: 'bash' }, { updatedMCPToolOutput: 'm' })).toEqual({
			action: 'continue',
		})
	})
	it('reads it on post_tool_use_failure, and not on other events', () => {
		expect(
			shellHookVerdict(
				'post_tool_use_failure',
				entry,
				answer({
					hookSpecificOutput: { hookEventName: 'PostToolUseFailure', updatedToolOutput: { a: 1 } },
				}),
			),
		).toMatchObject({ action: 'replace', output: '{"a":1}' })
		expect(
			shellHookVerdict(
				'post_tool_batch',
				entry,
				answer({
					hookSpecificOutput: { hookEventName: 'PostToolBatch', updatedToolOutput: 'x' },
				}),
			),
		).toEqual({ action: 'continue' })
	})
})

describe('a hook that asked for a replacement and the original is shown', () => {
	// Every way that remains, and what onFailure: block does for it.
	const unreadable: [string, ShellHookOutcome][] = [
		['bad JSON', answer('{"hookSpecificOutput": ')],
		['another field of the wrong type', post({ updatedToolOutput: 'x', additionalContext: 5 })],
		[
			'a decision it cannot read',
			answer({
				decision: 'maybe',
				hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'x' },
			}),
		],
		[
			'the wrong event name',
			answer({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedToolOutput: 'x' } }),
		],
		[
			'an answer over the size limit',
			{ exitCode: 0, timedOut: false, stdout: '{"a":"', stderr: '', stdoutTruncated: true },
		],
		['a timeout', { exitCode: null, timedOut: true, stdout: '', stderr: '' }],
		['an exit code of 1', answer('', 1)],
		[
			'a hook that could not start',
			{ exitCode: null, timedOut: false, stdout: '', stderr: '', spawnError: 'ENOENT' },
		],
	]
	for (const [name, outcome] of unreadable) {
		it(`${name}: shown with continue, withheld with block`, () => {
			expect(shellHookVerdict('post_tool_use', entry, outcome)).toEqual({ action: 'continue' })
			expect(shellHookVerdict('post_tool_use', blocking, outcome)).toMatchObject({
				action: 'replace',
				disclose: true,
			})
			expect(shellHookVerdict('post_tool_use_failure', blocking, outcome)).toMatchObject({
				action: 'replace',
			})
		})
	}

	it('an async hook decides nothing, and a prompt hook does not read onFailure', () => {
		const asyncBlocking: ShellHookEntry = { command: 'x', async: true, onFailure: 'block' }
		expect(shellHookVerdict('post_tool_use', asyncBlocking, answer('', 1))).toEqual({
			action: 'continue',
		})
	})
})
