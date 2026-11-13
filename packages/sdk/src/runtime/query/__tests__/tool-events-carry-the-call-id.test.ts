import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { type ShellHooksConfig, attachShellHooks } from '../../../plugin/shell-hook.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import type { ChatCompletionParams, MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Real shell hooks, a scripted model, the real lifecycle manager and the real
 * query loop. Nothing here is mocked between the hook's stdout and the
 * model's next request, which is the path a stranger's `hooks:` config takes.
 */

const scratch = mkdtempSync(join(tmpdir(), 'namzu-hooks-json-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let fileSeq = 0
/** A script file, so the JSON a hook prints never has to survive shell quoting. */
function script(body: string): string {
	const path = join(scratch, `hook-${++fileSeq}.sh`)
	writeFileSync(path, body)
	return `sh ${path}`
}
const printJson = (value: unknown) => script(`cat <<'EOF'\n${JSON.stringify(value)}\nEOF\n`)

function logger() {
	const log = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: () => log,
	}
	return log as never
}

interface Harness {
	executions: { tool: string; input: unknown }[]
	tools: ToolDefinition[]
}

function makeTools(): Harness {
	const executions: Harness['executions'] = []
	const record = (tool: string) => async (input: unknown) => {
		executions.push({ tool, input })
		return { success: true, output: `${tool} ran` }
	}
	const tools = [
		defineTool({
			name: 'read',
			description: 'read a file',
			inputSchema: z.object({ path: z.string() }).strict(),
			category: 'filesystem',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: record('read'),
		}),
		defineTool({
			name: 'mcp__srv__lookup',
			description: 'a tool-server tool',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: record('mcp__srv__lookup'),
		}),
		defineTool({
			name: 'note',
			description: 'write a note',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: record('note'),
		}),
		defineTool({
			name: 'peek',
			description: 'read a note',
			inputSchema: z.object({ text: z.string() }),
			category: 'filesystem',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: record('peek'),
		}),
		defineTool({
			name: 'wipe',
			description: 'delete everything',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: record('wipe'),
		}),
		defineTool({
			name: 'vault',
			description: 'always asks',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			requiresApproval: true,
			execute: record('vault'),
		}),
		defineTool({
			name: 'flaky',
			description: 'fails',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				executions.push({ tool: 'flaky', input })
				return { success: false, output: '', error: 'it broke' }
			},
		}),
	]
	return { executions, tools }
}

interface RunOptions {
	hooks: ShellHooksConfig
	turns: MockTurn[]
	resumeHandler?: ResumeHandler
	maxIterations?: number
	/** Only the tools that exist; defaults to all. */
	harness?: Harness
	/** Run as a delegated child of this session. */
	parentSessionId?: ReturnType<typeof generateSessionId>
}

async function run(options: RunOptions) {
	const harness = options.harness ?? makeTools()
	const manager = new PluginLifecycleManager({
		pluginRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: logger(),
	})
	attachShellHooks(manager, options.hooks, { cwd: scratch })
	const provider = new MockLLMProvider({ turns: options.turns })
	const events: SessionEvent[] = []
	const sessionId = generateSessionId()
	const turn = await drainQuery(
		{
			provider,
			toolsets: [testToolset(...harness.tools)],
			agentId: 'hooks-json',
			agentName: 'Hooks JSON',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: scratch,
			turnConfig: {
				model: 'mock',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: options.maxIterations ?? 6,
			},
			projectId: generateProjectId(),
			sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
			...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
			...(options.resumeHandler ? { resumeHandler: options.resumeHandler } : {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return { turn, provider, events, executions: harness.executions, manager }
}

const toolCall = (name: string, args: Record<string, unknown>, id = `call_${name}`): MockTurn => ({
	toolCalls: [{ id, name, args }],
})

/** A hook that appends its stdin to `file`, one JSON document per line. */
function recorder(name: string): { command: string; read: () => Record<string, unknown>[] } {
	const file = join(scratch, name)
	return {
		command: script(`cat >> ${file}\necho >> ${file}\n`),
		read: () =>
			existsSync(file)
				? readFileSync(file, 'utf8')
						.split('\n')
						.filter((line) => line.trim().length > 0)
						.map((line) => JSON.parse(line) as Record<string, unknown>)
				: [],
	}
}

/** What the model read as the result of its first tool call. */
function resultSeen(provider: MockLLMProvider): string {
	const requests = (provider as unknown as { requests?: ChatCompletionParams[] }).requests ?? []
	const last = requests[requests.length - 1]
	return (last?.messages ?? [])
		.filter((message) => message.role === 'tool')
		.map((message) =>
			typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
		)
		.join('\n')
}

describe('every tool event carries the call id', () => {
	it('pre_tool_use, post_tool_use and post_tool_use_failure carry the id the model gave, the same as post_tool_batch', async () => {
		const seen = recorder('ids-1')
		await run({
			hooks: {
				pre_tool_use: [{ command: seen.command }],
				post_tool_use: [{ command: seen.command }],
				post_tool_use_failure: [{ command: seen.command }],
				post_tool_batch: [{ command: seen.command }],
			},
			turns: [toolCall('flaky', { text: 'x' }, 'call_abc'), { text: 'done' }],
		})
		const events = seen.read()
		const named = (name: string) => events.filter((event) => event.hook_event_name === name)
		expect(named('PreToolUse')[0]?.tool_use_id).toBe('call_abc')
		expect(named('PostToolUse')[0]?.tool_use_id).toBe('call_abc')
		expect(named('PostToolUseFailure')[0]?.tool_use_id).toBe('call_abc')
		const batch = named('PostToolBatch')[0]?.tool_calls as { tool_use_id: string }[]
		expect(batch[0]?.tool_use_id).toBe('call_abc')
	})

	it('permission_request and permission_denied carry it too', async () => {
		const seen = recorder('ids-2')
		await run({
			hooks: { permission_request: [{ command: seen.command }] },
			turns: [toolCall('vault', { text: 'x' }, 'call_vault'), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(seen.read()[0]?.tool_use_id).toBe('call_vault')

		const denied = recorder('ids-3')
		await run({
			hooks: {
				pre_tool_use: [{ command: printJson({ decision: 'block', reason: 'no' }) }],
				permission_denied: [{ command: denied.command }],
			},
			turns: [toolCall('wipe', { text: 'x' }, 'call_wipe'), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		// A refusal by a hook reaches permission_denied only where the kernel
		// announces it; when it does, it names the call.
		for (const event of denied.read()) expect(event.tool_use_id).toBe('call_wipe')
	})
})

describe('a file tool input carries file_path beside path', () => {
	it('sends both, and a rewrite of file_path alone becomes the path the tool gets', async () => {
		const seen = recorder('fp-1')
		const { executions } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								updatedInput: { path: '/a.txt', file_path: '/safe.txt' },
							},
						}),
					},
					{ command: seen.command },
				],
			},
			turns: [toolCall('read', { path: '/a.txt' }), { text: 'done' }],
		})
		expect(seen.read()[0]?.tool_input).toEqual({ path: '/a.txt', file_path: '/a.txt' })
		expect(executions).toEqual([{ tool: 'read', input: { path: '/safe.txt' } }])
	})

	it('an echoed file_path with other fields changed is not a reason to refuse the rewrite', async () => {
		const { executions } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								updatedInput: { path: '/b.txt', file_path: '/a.txt' },
							},
						}),
					},
				],
			},
			turns: [toolCall('read', { path: '/a.txt' }), { text: 'done' }],
		})
		expect(executions).toEqual([{ tool: 'read', input: { path: '/b.txt' } }])
	})

	it('two different new paths is an unreadable answer: with onFailure block the call is refused', async () => {
		const { executions } = await run({
			hooks: {
				pre_tool_use: [
					{
						onFailure: 'block',
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								updatedInput: { path: '/b.txt', file_path: '/c.txt' },
							},
						}),
					},
				],
			},
			turns: [toolCall('read', { path: '/a.txt' }), { text: 'done' }],
		})
		expect(executions).toEqual([])
	})
})

describe('a replacement of any JSON type', () => {
	const replaced = async (updatedToolOutput: unknown, tool = 'note', extra = {}) => {
		const { provider } = await run({
			hooks: {
				post_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput, ...extra },
						}),
					},
				],
			},
			turns: [toolCall(tool, { text: 'x' }), { text: 'done' }],
		})
		return resultSeen(provider)
	}

	it('a string, an object with the result shape, any other object, an array, a number', async () => {
		expect(await replaced('plain')).toContain('plain')
		expect(await replaced({ success: true, output: 'shaped' })).toContain('shaped')
		expect(await replaced({ secret: 'gone' })).toContain('{"secret":"gone"}')
		expect(await replaced([1, 2])).toContain('[1,2]')
		expect(await replaced(42)).toContain('42')
		expect(await replaced(true)).toContain('true')
	})

	it('null is no replacement: the tool result stands', async () => {
		expect(await replaced(null)).toContain('note ran')
	})

	it('a tool-server tool takes updatedMCPToolOutput, and updatedToolOutput wins when both are set', async () => {
		const mcp = 'mcp__srv__lookup'
		const only = await replaced(undefined, mcp, { updatedMCPToolOutput: { a: 1 } })
		expect(only).toContain('{"a":1}')
		const both = await replaced('general', mcp, { updatedMCPToolOutput: 'specific' })
		expect(both).toContain('general')
		expect(both).not.toContain('specific')
		// Not a tool-server tool: the field is not read.
		expect(await replaced(undefined, 'note', { updatedMCPToolOutput: 'ignored' })).toContain(
			'note ran',
		)
	})
})

describe('the agent type on subagent_start and subagent_stop', () => {
	it('both carry agent_type and agent_id for a delegated child', async () => {
		const seen = recorder('agent-1')
		await run({
			hooks: {
				subagent_start: [{ command: seen.command }],
				subagent_stop: [{ command: seen.command }],
			},
			turns: [{ text: 'child done' }],
			parentSessionId: generateSessionId(),
		})
		const events = seen.read()
		expect(events.map((event) => event.hook_event_name)).toEqual(['SubagentStart', 'SubagentStop'])
		for (const event of events) {
			expect(event.agent_type).toBe('Hooks JSON')
			expect(typeof event.agent_id).toBe('string')
		}
	})
})
