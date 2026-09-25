import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLResumeDecision, ResumeHandler } from '../../../types/hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { type AssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { type TurnStateScope, loadTurnState } from '../turn-state.js'
import { type RecordDraft, heldCheckpointStore, rewriteSession } from './support/session.js'

/**
 * The whole point of #14, end to end: a turn parks on a tool approval in
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
	scope: TurnStateScope
	/** The session's log. A second process opens another instance over the same bytes. */
	log: InMemorySessionLog
	calls: string[]
	tools: Toolset
}

/** The log as a second process opens it: the same bytes, lease and spills, a new instance. */
function reopen(log: InMemorySessionLog): InMemorySessionLog {
	return new InMemorySessionLog({
		sessionId: log.sessionId,
		medium: log.medium,
		leases: log.leaseStore,
		spills: log.spillStore,
	})
}

/** What process 2 reads before it resumes: the turn's state, from the log and its checkpoints. */
async function stateOf(h: Harness, turnId: TurnStateScope['turnId']) {
	const log = reopen(h.log)
	return loadTurnState(log, await heldCheckpointStore(log), { ...h.scope, turnId })
}

async function harness(): Promise<Harness> {
	const dir = await workdir()
	const calls: string[] = []
	const tools = testToolset(deleteRowTool(calls) as unknown as ToolDefinition)
	const sessionId = '4867992e-5fe0-44ac-8ad3-84768354abe1' as SessionId
	return {
		dir,
		calls,
		tools,
		log: new InMemorySessionLog({ sessionId }),
		scope: {
			tenantId: '945ca78a-e487-433d-a206-e2b9c64485c9' as TenantId,
			projectId: 'f4feb4a0-1fe7-447e-a5bb-29988d224bb0' as ProjectId,
			sessionId,
			topicId: '62a3b800-6711-4be4-9574-b8821f466408' as TopicId,
			turnId: 'b69a1e4f-bc7c-4031-9fd8-93be940b8ff6' as TurnId,
		},
	}
}

function baseParams(h: Harness, provider: MockLLMProvider, resumeHandler: ResumeHandler) {
	return {
		provider,
		toolsets: [h.tools],
		resumeHandler,
		sessionLog: reopen(h.log),
		turnId: h.scope.turnId,
		turnConfig: {
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

/** Answers the first review by pausing, which ends the turn still parked. */
const pauseOnReview: ResumeHandler = (request) =>
	Promise.resolve(
		request.type === 'tool_review'
			? ({ action: 'pause', reason: 'waiting for a human' } as HITLResumeDecision)
			: ({ action: 'continue' } as HITLResumeDecision),
	)

describe('an approval survives a process boundary', () => {
	it('parks durably, then a second turn applies the recorded decision', async () => {
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
		const state = await stateOf(h, parked.id)
		expect(state?.pending?.request.type).toBe('tool_review')
		const recalled =
			state?.pending?.request.type === 'tool_review' ? state.pending.request.toolCalls : []
		expect(recalled.map((tc) => tc.name)).toEqual(['delete_row'])
		expect(recalled[0]?.isDestructive).toBe(true)

		// Native replay state makes deletion/reconstruction observable. The
		// resume must carry this exact signed assistant turn forward; a generic
		// history repair cannot replace it with a synthetic result first.
		const checkpoint = await findPendingCheckpoint(h.log, { turnId: parked.id })
		if (!checkpoint) throw new Error('expected the durable park')
		const parkedAssistant = (await readFoldedHistory(h.log))
			.map((entry) => entry.message)
			.find((message): message is AssistantMessage => message.role === 'assistant')
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
		// The log records the enriched turn: what a provider with replay state
		// would have produced.
		h.log = await rewriteSession(h.log, [{ ...h.scope, turnId: parked.id }], (draft) =>
			draft.type === 'message' && draft.role === 'assistant'
				? ({ ...draft, content: enrichedAssistant } as RecordDraft)
				: draft,
		)

		// --- process 2: the human said yes ---
		const second = new MockLLMProvider({ turns: [{ text: 'row 42 is gone' }] })
		const resumeEvents: SessionEvent[] = []
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

		const state = await stateOf(h, parked.id)
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
		const cp = await findPendingCheckpoint(h.log, { turnId: parked.id })
		if (!cp || cp.pending.request.type !== 'tool_review') throw new Error('no park')
		h.log = await rewriteSession(h.log, [{ ...h.scope, turnId: parked.id }], (draft) => {
			if (draft.type !== 'decision_requested') return draft
			const request = draft.request as unknown as { toolCalls: Record<string, unknown>[] }
			return {
				...draft,
				request: {
					...request,
					toolCalls: [{ ...request.toolCalls[0], id: 'call_other' }],
				},
			} as RecordDraft
		})

		const second = new MockLLMProvider({ turns: [{ text: 'nothing to do' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: cp.checkpointId,
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
		const cp = await findPendingCheckpoint(h.log, { turnId: parked.id })
		if (!cp || cp.pending.request.type !== 'tool_review') throw new Error('no park')
		const assistant = (await readFoldedHistory(h.log))
			.map((entry) => entry.message)
			.find((message): message is AssistantMessage => message.role === 'assistant')
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
		h.log = await rewriteSession(h.log, [{ ...h.scope, turnId: parked.id }], (draft) =>
			draft.type === 'message' && draft.role === 'assistant'
				? ({ ...draft, content: duplicateAssistant } as RecordDraft)
				: draft,
		)

		const second = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const resumed = await drainQuery({
			...baseParams(h, second, pauseOnReview),
			messages: [],
			resumeFromCheckpoint: cp.checkpointId,
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
		const state = await stateOf(h, parked.id)

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
			const definitions: ToolDefinition[] = []
			definitions.push(deleteRowTool(executions) as unknown as ToolDefinition)
			definitions.push({
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
			return testToolset(...definitions)
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
			toolsets: [makeTools()],
			authorizationGate,
			messages: [createUserMessage('run both')],
		})
		expect(parked.stopReason).toBe('paused')
		expect(executions).toEqual([])

		const state = await stateOf(h, parked.id)
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
			toolsets: [makeTools()],
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
			const definitions: ToolDefinition[] = []
			definitions.push({
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
			return testToolset(...definitions)
		}
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'canonicalize', args: { value: 'x' } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			toolsets: [makeTools()],
			messages: [createUserMessage('normalize x')],
		})
		const state = await stateOf(h, parked.id)
		expect(state?.pending?.request.type).toBe('tool_review')

		const second = new MockLLMProvider({ turns: [{ text: 'done' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			toolsets: [makeTools()],
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
			const definitions: ToolDefinition[] = []
			definitions.push({
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
			return testToolset(...definitions)
		}
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'normalize_call', name: 'normalize', args: { value: 'x' } }] }],
		})
		const parked = await drainQuery({
			...baseParams(h, first, pauseOnReview),
			toolsets: [makeTools('v1')],
			messages: [createUserMessage('normalize')],
		})
		const state = await stateOf(h, parked.id)
		if (state?.pending?.request.type !== 'tool_review') throw new Error('expected tool review')
		expect(state.pending.request.toolCalls[0]?.input).toEqual({ value: 'v1:x' })

		const second = new MockLLMProvider({ turns: [{ text: 'not run' }] })
		await drainQuery({
			...baseParams(h, second, pauseOnReview),
			toolsets: [makeTools('v2')],
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
		// unconditionally would triple a long turn's checkpoint writes to
		// describe a park that never happened.
		expect(await findPendingCheckpoint(h.log, { turnId: run.id })).toBeNull()
	})
})
