import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { type ToolReviewPrompt, createReviewHandler } from '../review-policy.js'

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

/** Everything the model was shown on request `index`, flattened to text. */
function seenBy(requests: readonly ChatCompletionParams[], index: number): string {
	const request = requests[index]
	if (!request) throw new Error(`no request #${index}`)
	return request.messages
		.map((message) =>
			typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
		)
		.join('\n---\n')
}

describe('a pre_tool_use hook answering with JSON', () => {
	it('rewrites the call with updatedInput, and the tool runs on what the hook wrote', async () => {
		const { executions, turn } = await run({
			hooks: {
				pre_tool_use: [
					{
						matcher: 'note',
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								updatedInput: { text: 'rewritten by the hook' },
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'what the model said' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(turn.status).toBe('completed')
		expect(executions).toEqual([{ tool: 'note', input: { text: 'rewritten by the hook' } }])
	})

	it('validates a rewrite like a model-supplied input: a bad one never reaches the tool', async () => {
		const { executions, provider } = await run({
			hooks: {
				pre_tool_use: [
					{
						matcher: 'note',
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								updatedInput: { text: 42 },
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'fine' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toEqual([])
		expect(seenBy(provider.requests, 1)).toMatch(/text/i)
	})

	it('refuses with permissionDecision deny, and the model reads the reason', async () => {
		const { executions, provider } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'deny',
								permissionDecisionReason: 'notes are frozen until Friday',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'understood' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toEqual([])
		expect(seenBy(provider.requests, 1)).toContain('notes are frozen until Friday')
	})

	it('refuses with exit 2, the stderr being what the model reads', async () => {
		const { executions, provider } = await run({
			hooks: {
				pre_tool_use: [{ command: script('echo "no writes today" >&2\nexit 2\n') }],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'understood' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toEqual([])
		expect(seenBy(provider.requests, 1)).toContain('no writes today')
	})

	it('hands additionalContext to the model beside the call’s result', async () => {
		const { executions, provider } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								additionalContext: 'the migration lock is held by Dana',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toHaveLength(1)
		const shown = seenBy(provider.requests, 1)
		expect(shown).toContain('note ran')
		expect(shown).toContain('[Hook note]')
		expect(shown).toContain('the migration lock is held by Dana')
	})

	it('continue:false refuses the call and ends the turn without another model call', async () => {
		const { turn, provider, executions } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							continue: false,
							stopReason: 'change freeze',
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'never asked' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toEqual([])
		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('stop_condition')
		expect(turn.lastError).toContain('change freeze')
	})
})

describe('a hook’s permission answer, against the kernel’s own rules', () => {
	const registry = (tools: readonly ToolDefinition[]) => ({
		get: (name: string) => tools.find((tool) => tool.name === name),
		sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
	})
	const allow = {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'allow',
		},
	}
	const withPrompt = (tools: readonly ToolDefinition[]) => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		return {
			prompt,
			resumeHandler: createReviewHandler({
				mode: 'prompt',
				prompt,
				registry: registry(tools),
			}),
		}
	}

	it('allow stands in for the person on an ordinary write', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const { executions } = await run({
			harness,
			hooks: { pre_tool_use: [{ matcher: 'note', command: printJson(allow) }] },
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(executions).toHaveLength(1)
		expect(prompt).not.toHaveBeenCalled()
	})

	it('without the hook the same write asks', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		await run({
			harness,
			hooks: {},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('allow cannot cover a call the tool declares destructive', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		await run({
			harness,
			hooks: { pre_tool_use: [{ command: printJson(allow) }] },
			turns: [toolCall('wipe', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('allow cannot cover a call the tool always asks about', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		await run({
			harness,
			hooks: { pre_tool_use: [{ command: printJson(allow) }] },
			turns: [toolCall('vault', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('allow cannot cover a call an explicit review rule sent to a person', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const manager = new PluginLifecycleManager({
			pluginRegistry: {} as never,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
		})
		attachShellHooks(manager, { pre_tool_use: [{ command: printJson(allow) }] }, { cwd: scratch })
		const provider = new MockLLMProvider({
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
		})
		await drainQuery({
			provider,
			toolsets: [testToolset(...harness.tools)],
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: scratch,
			turnConfig: {
				model: 'mock',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 4,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
			resumeHandler,
			authorizationGate: {
				enabled: true,
				rules: [
					{
						type: 'custom_pattern',
						pattern: '^note$',
						target: 'name',
						decision: 'review',
					},
				],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('a rule’s deny still refuses, whatever the hook says', async () => {
		const harness = makeTools()
		const { resumeHandler } = withPrompt(harness.tools)
		const manager = new PluginLifecycleManager({
			pluginRegistry: {} as never,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: logger(),
		})
		attachShellHooks(manager, { pre_tool_use: [{ command: printJson(allow) }] }, { cwd: scratch })
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			}),
			toolsets: [testToolset(...harness.tools)],
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: scratch,
			turnConfig: {
				model: 'mock',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 4,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
			resumeHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'deny_by_name', toolNames: ['note'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})
		expect(harness.executions).toEqual([])
	})

	it('deny from one hook wins over allow from another', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const { executions } = await run({
			harness,
			hooks: {
				pre_tool_use: [
					{ command: printJson(allow) },
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'deny',
								permissionDecisionReason: 'no',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(executions).toEqual([])
		expect(prompt).not.toHaveBeenCalled()
	})

	it('ask sends even a read-only call to a person', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const { executions } = await run({
			harness,
			hooks: {
				pre_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'ask',
							},
						}),
					},
				],
			},
			turns: [toolCall('peek', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(executions).toHaveLength(1)
	})

	it('ask beats allow from another hook', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		await run({
			harness,
			hooks: {
				pre_tool_use: [
					{ command: printJson(allow) },
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PreToolUse',
								permissionDecision: 'ask',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('a permission_request hook can approve a call that was about to be asked', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const { executions } = await run({
			harness,
			hooks: {
				permission_request: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PermissionRequest',
								decision: { behavior: 'allow' },
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(executions).toHaveLength(1)
		expect(prompt).not.toHaveBeenCalled()
	})

	it('a permission_request hook can refuse, and the model reads why', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		const { executions, provider } = await run({
			harness,
			hooks: {
				permission_request: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PermissionRequest',
								decision: {
									behavior: 'deny',
									message: 'ask the on-call first',
								},
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(executions).toEqual([])
		expect(prompt).not.toHaveBeenCalled()
		expect(seenBy(provider.requests, 1)).toContain('ask the on-call first')
	})

	it('a permission_request allow still cannot cover a destructive call', async () => {
		const harness = makeTools()
		const { prompt, resumeHandler } = withPrompt(harness.tools)
		await run({
			harness,
			hooks: {
				permission_request: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PermissionRequest',
								decision: { behavior: 'allow' },
							},
						}),
					},
				],
			},
			turns: [toolCall('wipe', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('permission_request is not asked about a read nobody would be asked about', async () => {
		const harness = makeTools()
		const { resumeHandler } = withPrompt(harness.tools)
		const marker = join(scratch, 'permission-request-ran')
		await run({
			harness,
			hooks: { permission_request: [{ command: script(`touch ${marker}\n`) }] },
			turns: [toolCall('peek', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		const { existsSync } = await import('node:fs')
		expect(existsSync(marker)).toBe(false)
	})
})

describe('after a tool has run', () => {
	it('post_tool_use additionalContext reaches the model’s next request', async () => {
		const { provider } = await run({
			hooks: {
				post_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PostToolUse',
								additionalContext: 'lint reports 2 warnings in that file',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
		})
		expect(seenBy(provider.requests, 1)).toContain('lint reports 2 warnings in that file')
	})

	it('post_tool_use exit 2 shows the stderr to the model with that result', async () => {
		const { provider, executions } = await run({
			hooks: {
				post_tool_use: [{ command: script('echo "tests now fail" >&2\nexit 2\n') }],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
		})
		expect(executions).toHaveLength(1)
		expect(seenBy(provider.requests, 1)).toContain('tests now fail')
	})

	it('post_tool_use_failure fires for a failed call and not for a good one', async () => {
		const marker = join(scratch, 'failure-ran')
		await run({
			hooks: {
				post_tool_use_failure: [
					{
						command: script(`cat > ${marker}\nexit 0\n`),
						statusMessage: 'Noting failure',
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
		})
		const { existsSync, readFileSync } = await import('node:fs')
		expect(existsSync(marker), 'a successful call is not a failure').toBe(false)

		await run({
			hooks: {
				post_tool_use_failure: [
					{
						command: script(`cat > ${marker}\nexit 0\n`),
						statusMessage: 'Noting failure',
					},
				],
			},
			turns: [toolCall('flaky', { text: 'x' }), { text: 'done' }],
		})
		expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
			event: 'post_tool_use_failure',
			tool_name: 'flaky',
			error: 'it broke',
		})
	})

	it('post_tool_use_failure additionalContext is shown with the failure', async () => {
		const { provider } = await run({
			hooks: {
				post_tool_use_failure: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PostToolUseFailure',
								additionalContext: 'flaky is known to fail on Mondays',
							},
						}),
					},
				],
			},
			turns: [toolCall('flaky', { text: 'x' }), { text: 'done' }],
		})
		expect(seenBy(provider.requests, 1)).toContain('flaky is known to fail on Mondays')
	})

	it('continue:false after a tool stops the turn once the call is answered', async () => {
		const { provider, turn, executions } = await run({
			hooks: {
				post_tool_use: [
					{
						command: printJson({
							continue: false,
							stopReason: 'enough for today',
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'never asked' }],
		})
		expect(executions).toHaveLength(1)
		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('stop_condition')
		expect(turn.lastError).toContain('enough for today')
	})
})

describe('a turn_end hook refusing to let the turn end', () => {
	const counter = (name: string) => join(scratch, name)

	it('exit 2 feeds stderr back, the model keeps working, and the turn then ends', async () => {
		const flag = counter('stop-flag-1')
		const { turn, provider } = await run({
			hooks: {
				// Refuses until it has refused once.
				turn_end: [
					{
						command: script(
							`if [ -e ${flag} ]; then exit 0; fi\ntouch ${flag}\necho "you have not run the tests" >&2\nexit 2\n`,
						),
					},
				],
			},
			turns: [{ text: 'all done' }, { text: 'tests run, now done' }],
		})
		expect(turn.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(seenBy(provider.requests, 1)).toContain('you have not run the tests')
		expect(turn.stopReason).toBe('end_turn')
	})

	it('tells the hook, on the second ask, that it already kept the turn going', async () => {
		const seen = counter('stop-seen-1')
		await run({
			hooks: {
				turn_end: [
					{
						command: script(
							`cat >> ${seen}\necho >> ${seen}\nif grep -q '"stop_hook_active":true' ${seen}; then exit 0; fi\necho again >&2\nexit 2\n`,
						),
					},
				],
			},
			turns: [{ text: 'one' }, { text: 'two' }],
		})
		const { readFileSync } = await import('node:fs')
		const lines = readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean)
		expect(JSON.parse(lines[0] ?? '{}').stop_hook_active).toBeUndefined()
		expect(JSON.parse(lines[1] ?? '{}').stop_hook_active).toBe(true)
	})

	it('decision:block with a reason does the same as exit 2', async () => {
		const flag = counter('stop-flag-2')
		const body = JSON.stringify({
			decision: 'block',
			reason: 'finish the changelog',
		})
		const { provider } = await run({
			hooks: {
				turn_end: [
					{
						command: script(
							`if [ -e ${flag} ]; then exit 0; fi\ntouch ${flag}\ncat <<'EOF'\n${body}\nEOF\n`,
						),
					},
				],
			},
			turns: [{ text: 'all done' }, { text: 'changelog done' }],
		})
		expect(seenBy(provider.requests, 1)).toContain('finish the changelog')
	})

	it('subagent_stop exit 2 keeps a delegated child working, and only a child', async () => {
		const flag = counter('stop-flag-3')
		const hooks: ShellHooksConfig = {
			subagent_stop: [
				{
					command: script(
						`if [ -e ${flag} ]; then exit 0; fi\ntouch ${flag}\necho "child: add the tests" >&2\nexit 2\n`,
					),
				},
			],
		}
		const child = await run({
			hooks,
			turns: [{ text: 'child done' }, { text: 'child tests added' }],
			parentSessionId: generateSessionId(),
		})
		expect(child.provider.requests).toHaveLength(2)
		expect(seenBy(child.provider.requests, 1)).toContain('child: add the tests')

		const root = await run({ hooks, turns: [{ text: 'done' }] })
		expect(root.provider.requests).toHaveLength(1)
	})

	it('fires turn_end once when nothing objects', async () => {
		const seen = counter('stop-seen-2')
		const { turn } = await run({
			hooks: {
				turn_end: [{ command: script(`cat >> ${seen}\necho >> ${seen}\n`) }],
			},
			turns: [{ text: 'done' }],
		})
		const { readFileSync } = await import('node:fs')
		expect(turn.status).toBe('completed')
		expect(readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1)
	})

	it('continue:false stops the turn where it is instead of keeping it going', async () => {
		const { turn, provider } = await run({
			hooks: {
				turn_end: [
					{
						command: printJson({
							continue: false,
							stopReason: 'budget',
							decision: 'block',
							reason: 'more',
						}),
					},
				],
			},
			turns: [{ text: 'all done' }, { text: 'never asked' }],
		})
		expect(provider.requests).toHaveLength(1)
		expect(turn.stopReason).toBe('stop_condition')
	})

	it('a hook that always refuses is stopped by the turn’s own iteration limit', async () => {
		const { turn, provider } = await run({
			hooks: { turn_end: [{ command: script('echo more >&2\nexit 2\n') }] },
			turns: [{ text: 'again' }],
			maxIterations: 3,
		})
		expect(provider.requests.length).toBeLessThanOrEqual(3)
		expect(turn.stopReason).toBe('max_iterations')
	})
})

describe('a prompt hook answering with JSON', () => {
	it('decision:block ends the turn naming the reason', async () => {
		const { turn } = await run({
			hooks: {
				user_prompt_submit: [{ command: printJson({ decision: 'block', reason: 'out of hours' }) }],
			},
			turns: [{ text: 'never asked' }],
		})
		expect(turn.status).toBe('failed')
		expect(turn.lastError ?? '').toContain('out of hours')
	})

	it('additionalContext joins what the model is told for the turn', async () => {
		const { provider } = await run({
			hooks: {
				user_prompt_submit: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'UserPromptSubmit',
								additionalContext: 'the current branch is release/9',
							},
						}),
					},
				],
			},
			turns: [{ text: 'ok' }],
		})
		const system = provider.requests[0]?.messages
			.map((m) => (typeof m.content === 'string' ? m.content : ''))
			.join('\n')
		expect(system).toContain('the current branch is release/9')
	})
})

describe('hook options in a real turn', () => {
	it('`if` keeps the process from spawning for a call it does not name', async () => {
		const marker = join(scratch, 'if-ran')
		await run({
			hooks: {
				pre_tool_use: [{ command: script(`touch ${marker}\n`), if: 'Bash(git push *)' }],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const { existsSync } = await import('node:fs')
		expect(existsSync(marker)).toBe(false)
	})

	it('`once` runs a hook on the first matching call only', async () => {
		const log = join(scratch, 'once-log')
		await run({
			hooks: {
				pre_tool_use: [{ command: script(`echo hit >> ${log}\n`), once: true }],
			},
			turns: [
				{
					toolCalls: [
						{ id: 'a', name: 'note', args: { text: '1' } },
						{ id: 'b', name: 'note', args: { text: '2' } },
					],
				},
				{ text: 'done' },
			],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const { readFileSync } = await import('node:fs')
		expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['hit'])
	})

	it('a regular-expression matcher selects tools by pattern', async () => {
		const log = join(scratch, 'regex-log')
		await run({
			hooks: {
				pre_tool_use: [
					{
						command: script(`cat >> ${log}\necho >> ${log}\n`),
						matcher: '^(note|wipe)$',
					},
				],
			},
			turns: [
				{
					toolCalls: [
						{ id: 'a', name: 'note', args: { text: '1' } },
						{ id: 'b', name: 'peek', args: { text: '2' } },
					],
				},
				{ text: 'done' },
			],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const { readFileSync } = await import('node:fs')
		const names = readFileSync(log, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line).tool_name)
		expect(names).toEqual(['note'])
	})

	it('emits the hook’s statusMessage with the executing event', async () => {
		const { events } = await run({
			hooks: {
				post_tool_use: [{ command: 'exit 0', statusMessage: 'Formatting the file' }],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'plugin_hook_executing',
				hookEvent: 'post_tool_use',
				statusMessage: 'Formatting the file',
			}),
		)
	})
})

describe('matching hooks run in parallel and their answers combine', () => {
	const pre = (output: object) =>
		printJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } })
	const reviewing = (tools: readonly ToolDefinition[]) => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		return {
			prompt,
			resumeHandler: createReviewHandler({
				mode: 'prompt',
				prompt,
				registry: {
					get: (name: string) => tools.find((tool) => tool.name === name),
					sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
				},
			}),
		}
	}

	it('starts them together: the first cannot finish until the second has run', async () => {
		const gate = join(scratch, 'parallel-gate')
		const { executions } = await run({
			hooks: {
				pre_tool_use: [
					// Waits for the file the second hook writes. Run one after the other,
					// it would wait for ever and the test would hit Vitest's own timeout.
					{ command: script(`until [ -e ${gate} ]; do sleep 0.05; done\nexit 0\n`) },
					{ command: script(`touch ${gate}\nexit 0\n`) },
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(executions).toHaveLength(1)
	})

	it('a refusal stands whichever hook gives it, and the others still ran', async () => {
		const ran = join(scratch, 'siblings-ran')
		const harness = makeTools()
		const { prompt, resumeHandler } = reviewing(harness.tools)
		const { executions } = await run({
			harness,
			hooks: {
				pre_tool_use: [
					{
						command: script(
							`echo allow-hook >> ${ran}\ncat <<'EOF'\n${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })}\nEOF\n`,
						),
					},
					{
						command: script(
							`echo deny-hook >> ${ran}\ncat <<'EOF'\n${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })}\nEOF\n`,
						),
					},
					{ command: script(`echo third-hook >> ${ran}\nexit 0\n`) },
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler,
		})
		const { readFileSync } = await import('node:fs')
		expect(executions).toEqual([])
		expect(prompt).not.toHaveBeenCalled()
		expect(readFileSync(ran, 'utf8').trim().split('\n').sort()).toEqual([
			'allow-hook',
			'deny-hook',
			'third-hook',
		])
	})

	it('ask outranks allow whichever comes first, and allow alone approves', async () => {
		for (const order of [
			['allow', 'ask'],
			['ask', 'allow'],
		] as const) {
			const harness = makeTools()
			const { prompt, resumeHandler } = reviewing(harness.tools)
			await run({
				harness,
				hooks: {
					pre_tool_use: order.map((permissionDecision) => ({
						command: pre({ permissionDecision }),
					})),
				},
				turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
				resumeHandler,
			})
			expect(prompt, order.join(' then ')).toHaveBeenCalledTimes(1)
		}
	})

	it('of several rewrites the last in order wins, and each hook saw the original input', async () => {
		// One file per hook: the two run in parallel, and a shared file interleaved their
		// `cat >>` and `echo >>` appends into one unparseable line.
		const seen = [join(scratch, 'rewrite-seen-1'), join(scratch, 'rewrite-seen-2')]
		const { executions } = await run({
			hooks: {
				pre_tool_use: [
					{
						command: script(
							`cat >> ${seen[0]}\necho >> ${seen[0]}\ncat <<'EOF'\n${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { text: 'first rewrite' } } })}\nEOF\n`,
						),
					},
					{
						command: script(
							`cat >> ${seen[1]}\necho >> ${seen[1]}\ncat <<'EOF'\n${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { text: 'second rewrite' } } })}\nEOF\n`,
						),
					},
				],
			},
			turns: [toolCall('note', { text: 'original' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const { readFileSync } = await import('node:fs')
		expect(executions).toEqual([{ tool: 'note', input: { text: 'second rewrite' } }])
		const inputs = seen.map((file) => JSON.parse(readFileSync(file, 'utf8').trim()).tool_input)
		expect(inputs).toEqual([{ text: 'original' }, { text: 'original' }])
	})

	it('joins the additionalContext of every hook', async () => {
		const { provider } = await run({
			hooks: {
				post_tool_use: [
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PostToolUse',
								additionalContext: 'from the linter',
							},
						}),
					},
					{
						command: printJson({
							hookSpecificOutput: {
								hookEventName: 'PostToolUse',
								additionalContext: 'from the audit log',
							},
						}),
					},
				],
			},
			turns: [toolCall('note', { text: 'x' }), { text: 'done' }],
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const shown = seenBy(provider.requests, 1)
		expect(shown).toContain('from the linter')
		expect(shown).toContain('from the audit log')
	})
})
