import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DiskCheckpointStore } from '../../../store/run/checkpoint-disk.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { type AssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { type RunStateScope, loadRunState } from '../run-state.js'

/**
 * The whole point of #14, end to end: a run parks on a tool approval in
 * ONE `query()` call, that call returns, and a SECOND `query()` — standing
 * in for a different process — honors the approval a human gave in
 * between.
 *
 * Before this, the second call repaired the unanswered `tool_use` blocks
 * away and let the model re-decide, so "yes, delete that row" degraded
 * into "ask the model again and hope it asks for the same thing".
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-resume-'))
	dirs.push(dir)
	return dir
}

/** Records every call so a test can prove a tool did — or did not — run. */
function deleteRowTool(calls: string[]): ToolDefinition<{ id: number }> {
	return {
		name: 'delete_row',
		description: 'Delete a row',
		inputSchema: z.object({ id: z.number() }),
		isDestructive: () => true,
		execute: ({ id }) => {
			calls.push(`delete:${id}`)
			return Promise.resolve({ success: true, output: `deleted ${id}` })
		},
	}
}

interface Harness {
	dir: string
	scope: RunStateScope
	store: DiskCheckpointStore
	calls: string[]
	tools: ToolRegistry
}

async function harness(): Promise<Harness> {
	const dir = await workdir()
	const calls: string[] = []
	const tools = new ToolRegistry()
	tools.register(deleteRowTool(calls) as unknown as ToolDefinition)
	return {
		dir,
		calls,
		tools,
		store: new DiskCheckpointStore({ baseDir: join(dir, 'runs') }),
		scope: {
			tenantId: 'tnt_r' as TenantId,
			projectId: 'prj_r' as ProjectId,
			sessionId: 'ses_r' as SessionId,
			topicId: 'top_r' as TopicId,
			runId: 'run_r' as RunId,
		},
	}
}

function baseParams(h: Harness, provider: MockLLMProvider, resumeHandler: ResumeHandler) {
	return {
		provider,
		tools: h.tools,
		resumeHandler,
		checkpointStore: h.store,
		runId: h.scope.runId,
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_r',
		agentName: 'Resumable',
		workingDirectory: h.dir,
		sessionId: h.scope.sessionId,
		topicId: h.scope.topicId,
		projectId: h.scope.projectId,
		tenantId: h.scope.tenantId,
	}
}

/** Answers the first review by pausing, which ends the run still parked. */
const pauseOnReview: ResumeHandler = (request) =>
	Promise.resolve(
		request.type === 'tool_review'
			? ({ action: 'pause', reason: 'waiting for a human' } as HITLResumeDecision)
			: ({ action: 'continue' } as HITLResumeDecision),
	)

describe('an approval survives a process boundary', () => {
	it('parks durably, then a second run applies the recorded decision', async () => {
		const h = await harness()

		// --- process 1: run until it parks on the destructive call ---
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 42 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 42')],
		})
		expect(parked.stopReason).toBe('paused')
		expect(h.calls).toEqual([])

		// --- the handoff: durable state is all process 2 gets ---
		const state = await loadRunState(new DiskCheckpointStore({ baseDir: join(h.dir, 'runs') }), {
			...h.scope,
			runId: parked.id,
		})
		expect(state?.pending?.request.type).toBe('tool_review')
		const recalled =
			state?.pending?.request.type === 'tool_review' ? state.pending.request.toolCalls : []
		expect(recalled.map((tc) => tc.name)).toEqual(['delete_row'])
		expect(recalled[0]?.isDestructive).toBe(true)

		// Native replay state makes deletion/reconstruction observable. The
		// resume must carry this exact signed assistant turn forward; a generic
		// history repair cannot replace it with a synthetic result first.
		const checkpoint = await findPendingCheckpoint(h.store, { ...h.scope, runId: parked.id })
		if (!checkpoint) throw new Error('expected the durable park')
		const parkedAssistant = checkpoint.messages.find(
			(message): message is AssistantMessage => message.role === 'assistant',
		)
		if (!parkedAssistant) throw new Error('expected the parked assistant turn')
		const enrichedAssistant: AssistantMessage = {
			...parkedAssistant,
			reasoning: [{ type: 'thinking', text: 'signed thought', signature: 'signature-1' }],
			source: {
				type: 'model',
				providerId: 'mock',
				model: 'mock-model',
				chainIndex: 0,
				replayState: { version: 1, opaque: 'resume-exactly' },
			},
		}
		await h.store.writeCheckpoint(
			{ ...h.scope, runId: parked.id },
			{
				...checkpoint,
				messages: checkpoint.messages.map((message) =>
					message === parkedAssistant ? enrichedAssistant : message,
				),
			},
		)

		// --- process 2: the human said yes ---
		const second = new MockLLMProvider({ turns: [{ text: 'row 42 is gone' }] })
		const resumeEvents: RunEvent[] = []
		const resumed = await drainQuery(
			{
				...baseParams(h, second, pauseOnReview),
				messages: [],
				resumeFromCheckpoint: state?.checkpointId,
				pendingDecision: { action: 'approve_tools' },
			},
			(event) => {
				resumeEvents.push(event)
			},
		)

		// The approved call ran — without the model being asked to re-decide.
		expect(h.calls).toEqual(['delete:42'])
		expect(resumed.result).toBe('row 42 is gone')
		// And the model saw the tool result, not a repaired-away history.
		const sent = second.requests[0]?.messages ?? []
		const callId = enrichedAssistant.toolCalls?.[0]?.id
		const assistantMatches = sent.filter(
			(message) =>
				message.role === 'assistant' && message.toolCalls?.some((call) => call.id === callId),
		)
		const resultMatches = sent.filter(
			(message) => message.role === 'tool' && message.toolCallId === callId,
		)
		expect(assistantMatches).toEqual([enrichedAssistant])
		expect(resultMatches).toHaveLength(1)
		expect(resultMatches[0]?.content).toContain('deleted 42')
		const resumedAssistantIndex = sent.findIndex((message) => message === assistantMatches[0])
		expect(sent.indexOf(resultMatches[0]!)).toBe(resumedAssistantIndex + 1)
		expect(JSON.stringify(assistantMatches[0])).toContain('resume-exactly')
		expect(
			resumed.messages.filter(
				(message) =>
					message.role === 'assistant' && message.toolCalls?.some((call) => call.id === callId),
			),
		).toEqual([enrichedAssistant])
		expect(resumeEvents.some((event) => event.type === 'message_history_repaired')).toBe(false)
	})

	it('a rejection collected out-of-band steers the model instead of executing', async () => {
		const h = await harness()

		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 7 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 7')],
		})

		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })
		const second = new MockLLMProvider({ turns: [{ text: 'understood, leaving it alone' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			pendingDecision: { action: 'reject_tools', feedback: 'too risky' },
		})

		expect(h.calls).toEqual([])
		// The refusal rides inside the tool_result, which is what lets a
		// rejection steer rather than merely stop.
		const toolMsg = (second.requests[0]?.messages ?? []).find((m) => m.role === 'tool')
		expect(JSON.stringify(toolMsg)).toContain('too risky')
	})

	it('ignores a decision whose tool calls no longer match — consent is not transferable', async () => {
		const h = await harness()
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 1 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 1')],
		})

		// Tamper with the recorded request so it describes a different batch.
		const cp = await findPendingCheckpoint(h.store, { ...h.scope, runId: parked.id })
		if (!cp?.pending || cp.pending.request.type !== 'tool_review') throw new Error('no park')
		await h.store.writeCheckpoint(
			{ ...h.scope, runId: parked.id },
			{
				...cp,
				pending: {
					...cp.pending,
					request: {
						...cp.pending.request,
						toolCalls: [{ ...cp.pending.request.toolCalls[0]!, id: 'call_other' }],
					},
				},
			},
		)

		const second = new MockLLMProvider({ turns: [{ text: 'nothing to do' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: cp.id,
			pendingDecision: { action: 'approve_tools' },
		})

		// Falls back to repair-and-re-decide rather than executing a batch
		// nobody approved.
		expect(h.calls).toEqual([])
	})

	it('refuses duplicate call ids in a durable review instead of applying one approval twice', async () => {
		const h = await harness()
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 1 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 1')],
		})
		const cp = await findPendingCheckpoint(h.store, { ...h.scope, runId: parked.id })
		if (!cp?.pending || cp.pending.request.type !== 'tool_review') throw new Error('no park')
		const assistant = cp.messages.find(
			(message): message is AssistantMessage => message.role === 'assistant',
		)
		const original = assistant?.toolCalls?.[0]
		if (!assistant || !original) throw new Error('no reviewed call')
		const duplicateAssistant: AssistantMessage = {
			...assistant,
			toolCalls: [
				original,
				{
					...original,
					function: { ...original.function, arguments: JSON.stringify({ id: 2 }) },
				},
			],
		}
		await h.store.writeCheckpoint(
			{ ...h.scope, runId: parked.id },
			{
				...cp,
				messages: cp.messages.map((message) =>
					message === assistant ? duplicateAssistant : message,
				),
			},
		)

		const second = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const resumed = await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: cp.id,
			pendingDecision: { action: 'approve_tools' },
		})
		expect(resumed.status).toBe('failed')
		expect(resumed.lastError).toMatch(new RegExp(`repeats tool-call id '${original.id}'`, 'i'))
		expect(h.calls).toEqual([])
		expect(second.requests).toHaveLength(0)
	})

	it('a decision that does not describe a batch falls back to the repair path', async () => {
		const h = await harness()
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 3 } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			messages: [createUserMessage('delete row 3')],
		})
		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })

		const second = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			// `continue` says nothing about what to do with pending calls.
			pendingDecision: { action: 'continue' },
		})

		expect(h.calls).toEqual([])
	})

	it('preserves a mixed-batch gate denial across a process boundary', async () => {
		const h = await harness()
		const executions: string[] = []
		const makeTools = () => {
			const tools = new ToolRegistry()
			tools.register(deleteRowTool(executions) as unknown as ToolDefinition)
			tools.register({
				name: 'shell',
				description: 'schema-transforming shell fixture',
				inputSchema: z
					.object({ command: z.string() })
					.transform(() => ({ command: 'git push origin main' })),
				modelInputSchema: {
					type: 'object',
					properties: { command: { type: 'string' } },
					required: ['command'],
				},
				isDestructive: () => true,
				execute: ({ command }: { command: string }) => {
					executions.push(command)
					return Promise.resolve({ success: true, output: 'ran shell' })
				},
			} as ToolDefinition)
			return tools
		}
		const authorizationGate: AuthorizationGateConfig = {
			enabled: true,
			rules: [
				{ type: 'custom_pattern', pattern: 'git push', target: 'args', decision: 'deny' },
				{ type: 'allow_by_name', toolNames: ['delete_row', 'shell'] },
			],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		}
		const first = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ id: 'safe_call', name: 'delete_row', args: { id: 9 } },
						{ id: 'denied_call', name: 'shell', args: { command: 'status' } },
					],
				},
			],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			tools: makeTools(),
			authorizationGate,
			messages: [createUserMessage('run both')],
		})
		expect(parked.stopReason).toBe('paused')
		expect(executions).toEqual([])

		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })
		if (state?.pending?.request.type !== 'tool_review') throw new Error('expected tool review')
		expect(state.pending.request.toolCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'safe_call',
					authorization: expect.objectContaining({ decision: 'allow' }),
				}),
				expect.objectContaining({
					id: 'denied_call',
					input: { command: 'git push origin main' },
					authorization: expect.objectContaining({ decision: 'deny' }),
				}),
			]),
		)

		const second = new MockLLMProvider({ turns: [{ text: 'settled' }] })
		const currentGate: AuthorizationGateConfig = {
			...authorizationGate,
			// A later policy may allow this shape, but that cannot retroactively
			// turn the human's mixed-batch approval into consent for the call the
			// original process explicitly withheld from review.
			rules: [{ type: 'allow_by_name', toolNames: ['delete_row', 'shell'] }],
		}
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			tools: makeTools(),
			authorizationGate: currentGate,
			messages: [],
			resumeFromCheckpoint: state.checkpointId,
			pendingDecision: { action: 'approve_tools' },
		})

		expect(executions).toEqual(['delete:9'])
		const toolResults = (second.requests[0]?.messages ?? []).filter(
			(message) => message.role === 'tool',
		)
		expect(toolResults).toHaveLength(2)
		expect(JSON.stringify(toolResults)).toMatch(/authorization gate/i)
	})

	it('treats a null-prototype schema result as the same JSON value after disk resume', async () => {
		const h = await harness()
		const executions: string[] = []
		const makeTools = () => {
			const tools = new ToolRegistry()
			tools.register({
				name: 'canonicalize',
				description: 'null-prototype normalization fixture',
				inputSchema: z
					.object({ value: z.string() })
					.transform(({ value }) =>
						Object.assign(Object.create(null) as Record<string, unknown>, { value }),
					),
				isDestructive: () => true,
				execute: (input: { value: string }) => {
					executions.push(input.value)
					return Promise.resolve({ success: true, output: input.value })
				},
			} as ToolDefinition)
			return tools
		}
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'canonicalize', args: { value: 'x' } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			tools: makeTools(),
			messages: [createUserMessage('normalize x')],
		})
		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })
		expect(state?.pending?.request.type).toBe('tool_review')

		const second = new MockLLMProvider({ turns: [{ text: 'done' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			tools: makeTools(),
			messages: [],
			resumeFromCheckpoint: state?.checkpointId,
			pendingDecision: { action: 'approve_tools' },
		})

		expect(executions).toEqual(['x'])
		expect(JSON.stringify(second.requests[0]?.messages)).not.toMatch(
			/changed after its durable review/i,
		)
	})

	it('refuses a durable approval when schema normalization changed after review', async () => {
		const h = await harness()
		const executions: string[] = []
		const makeTools = (version: string) => {
			const tools = new ToolRegistry()
			tools.register({
				name: 'normalize',
				description: 'versioned normalization fixture',
				inputSchema: z
					.object({ value: z.string() })
					.transform(({ value }) => ({ value: `${version}:${value}` })),
				modelInputSchema: {
					type: 'object',
					properties: { value: { type: 'string' } },
					required: ['value'],
				},
				isDestructive: () => true,
				execute: ({ value }: { value: string }) => {
					executions.push(value)
					return Promise.resolve({ success: true, output: value })
				},
			} as ToolDefinition)
			return tools
		}
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'normalize_call', name: 'normalize', args: { value: 'x' } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			tools: makeTools('v1'),
			messages: [createUserMessage('normalize')],
		})
		const state = await loadRunState(h.store, { ...h.scope, runId: parked.id })
		if (state?.pending?.request.type !== 'tool_review') throw new Error('expected tool review')
		expect(state.pending.request.toolCalls[0]?.input).toEqual({ value: 'v1:x' })

		const second = new MockLLMProvider({ turns: [{ text: 'not run' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			tools: makeTools('v2'),
			messages: [],
			resumeFromCheckpoint: state.checkpointId,
			pendingDecision: { action: 'approve_tools' },
		})

		expect(executions).toEqual([])
		expect(JSON.stringify(second.requests[0]?.messages)).toMatch(
			/changed after its durable review/i,
		)
	})
})

describe('park recording stays off the hot path', () => {
	it('a handler that answers instantly never writes a park', async () => {
		const h = await harness()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'delete_row', args: { id: 5 } }] }, { text: 'done' }],
		})
		const instant = vi.fn<ResumeHandler>(() =>
			Promise.resolve({ action: 'approve_tools' } as HITLResumeDecision),
		)

		const run = await drainQuery({
			...baseParams(h, provider, instant),
			messages: [createUserMessage('delete row 5')],
		})

		expect(h.calls).toEqual(['delete:5'])
		expect(instant).toHaveBeenCalled()
		// The iteration gate runs every iteration; recording each park
		// unconditionally would triple a long run's checkpoint writes to
		// describe a park that never happened.
		expect(await findPendingCheckpoint(h.store, { ...h.scope, runId: run.id })).toBeNull()
	})
})
