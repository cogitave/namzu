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
import type { MockTurn } from '../../../types/provider/index.js'
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

describe('post_tool_batch', () => {
	it('fires once per step with every call and its outcome, after the calls settled', async () => {
		const seen = recorder('batch-1')
		const { executions } = await run({
			hooks: { post_tool_batch: [{ command: seen.command }] },
			turns: [
				{
					toolCalls: [
						{ id: 'c1', name: 'peek', args: { text: 'a' } },
						{ id: 'c2', name: 'flaky', args: { text: 'b' } },
					],
				},
				{ text: 'done' },
			],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions.map((e) => e.tool).sort()).toEqual(['flaky', 'peek'])
		const events = seen.read()
		expect(events).toHaveLength(1)
		expect(events[0]?.hook_event_name).toBe('PostToolBatch')
		const calls = events[0]?.tool_calls as Record<string, unknown>[]
		expect(calls.map((c) => [c.tool_use_id, c.tool_name, c.is_error])).toEqual([
			['c1', 'peek', false],
			['c2', 'flaky', true],
		])
		expect(calls[0]?.tool_input).toEqual({ text: 'a' })
		expect(calls[0]?.tool_response).toContain('peek ran')
	})

	it('does not fire for a step with no tool calls', async () => {
		const seen = recorder('batch-2')
		await run({ hooks: { post_tool_batch: [{ command: seen.command }] }, turns: [{ text: 'hi' }] })
		expect(seen.read()).toEqual([])
	})

	it('continue:false stops the turn before the next model request', async () => {
		const { provider, turn } = await run({
			hooks: {
				post_tool_batch: [
					{ command: printJson({ continue: false, stopReason: 'batch is enough' }) },
				],
			},
			turns: [toolCall('peek', { text: 'x' }), { text: 'never asked' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('stop_condition')
		expect(turn.lastError).toContain('batch is enough')
	})
})

describe('permission_denied', () => {
	const denyingRun = async (hooks: ShellHooksConfig, resumeHandler?: ResumeHandler) => {
		const harness = makeTools()
		const manager = new PluginLifecycleManager({
			pluginRegistry: {} as never,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
		})
		attachShellHooks(manager, hooks, { cwd: scratch })
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			}),
			toolsets: [testToolset(...harness.tools)],
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: scratch,
			turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
			resumeHandler: resumeHandler ?? (async () => ({ action: 'approve_tools' })),
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'deny_by_name', toolNames: ['note'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})
		return harness
	}

	it('fires for a call a rule refused, with the tool, its input and the reason', async () => {
		const seen = recorder('denied-1')
		const harness = await denyingRun({ permission_denied: [{ command: seen.command }] })
		expect(harness.executions).toEqual([])
		const events = seen.read()
		expect(events).toHaveLength(1)
		expect(events[0]?.hook_event_name).toBe('PermissionDenied')
		expect(events[0]?.tool_name).toBe('note')
		expect(events[0]?.tool_input).toEqual({ text: 'x' })
		expect(typeof events[0]?.reason).toBe('string')
		expect((events[0]?.reason as string).length).toBeGreaterThan(0)
	})

	it('does not fire for a call a hook refused before it was asked about', async () => {
		const seen = recorder('denied-2')
		await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
						}),
					},
				],
				permission_denied: [{ command: seen.command }],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(seen.read()).toEqual([])
	})

	it('does not fire when a person said No', async () => {
		const seen = recorder('denied-3')
		await run({
			hooks: { permission_denied: [{ command: seen.command }] },
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({
				action: 'reject_tools',
				feedback: 'not now',
				declined: { kind: 'declined' } as never,
			}),
		})
		expect(seen.read()).toEqual([])
	})
})

describe('subagent_start', () => {
	it('fires for a delegated child with its parent ids, and not for a root turn', async () => {
		const seen = recorder('start-1')
		const parent = generateSessionId()
		await run({
			hooks: { subagent_start: [{ command: seen.command }] },
			turns: [{ text: 'child done' }],
			parentSessionId: parent,
		})
		const events = seen.read()
		expect(events).toHaveLength(1)
		expect(events[0]?.hook_event_name).toBe('SubagentStart')
		expect(events[0]?.parent_session_id).toBe(String(parent))

		await run({ hooks: { subagent_start: [{ command: seen.command }] }, turns: [{ text: 'x' }] })
		expect(seen.read()).toHaveLength(1)
	})
})

describe('turn_failure', () => {
	it('fires once with the failure message when the model call fails', async () => {
		const seen = recorder('failure-1')
		const { turn } = await run({
			hooks: { turn_failure: [{ command: seen.command }] },
			turns: [{ error: { message: 'the model fell over' } }],
		})
		expect(turn.status).toBe('failed')
		const events = seen.read()
		expect(events).toHaveLength(1)
		expect(events[0]?.hook_event_name).toBe('StopFailure')
		expect(events[0]?.error).toContain('the model fell over')
	})

	it('does not fire for a turn that completed', async () => {
		const seen = recorder('failure-2')
		await run({ hooks: { turn_failure: [{ command: seen.command }] }, turns: [{ text: 'fine' }] })
		expect(seen.read()).toEqual([])
	})

	it('does not fire for a delegated child', async () => {
		const seen = recorder('failure-3')
		await run({
			hooks: { turn_failure: [{ command: seen.command }] },
			turns: [{ error: { message: 'child fell over' } }],
			parentSessionId: generateSessionId(),
		})
		expect(seen.read()).toEqual([])
	})
})
