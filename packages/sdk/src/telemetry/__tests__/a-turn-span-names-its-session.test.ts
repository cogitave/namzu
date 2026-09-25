import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { drainQuery } from '../../runtime/query/index.js'
import { InMemorySessionLog } from '../../store/session-log/memory.js'
import { fixtureId } from '../../test-support/ids.js'
import { testToolset } from '../../test-support/toolset.js'
import { defineTool } from '../../tools/defineTool.js'
import type { SessionId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import { agentTurnSpanName } from '../attributes.js'

/**
 * A turn's root span says which conversation it belongs to.
 *
 * The OTel GenAI convention names that `gen_ai.conversation.id`, and in namzu
 * the conversation is the session. Beside it the span carries the turn
 * (`namzu.turn.id`) and, on a child session's turn, the session that
 * delegated it (`namzu.session.parent_id`). With those three a trace backend
 * can group a whole conversation, find one turn in it, and walk a delegation
 * tree, all by query.
 *
 * The recorder captures attributes however they are set: in `startSpan`'s
 * options, or later through `setAttribute(s)`.
 */

interface Recorded {
	name: string
	attributes: Record<string, unknown>
}

const spans: Recorded[] = []

vi.mock('../runtime-accessors.js', () => {
	const span = (rec: Recorded) => ({
		setAttributes: (a: Record<string, unknown>) => Object.assign(rec.attributes, a),
		setAttribute: (k: string, v: unknown) => {
			rec.attributes[k] = v
		},
		setStatus: () => undefined,
		recordException: () => undefined,
		addEvent: () => undefined,
		end: () => undefined,
		spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
		isRecording: () => true,
		updateName: () => undefined,
	})
	return {
		getActiveSpanContext: () => undefined,
		getTracer: () => ({
			startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
				const rec: Recorded = { name, attributes: { ...(options?.attributes ?? {}) } }
				spans.push(rec)
				return span(rec)
			},
			startActiveSpan: (
				name: string,
				options: { attributes?: Record<string, unknown> } | undefined,
				_context: unknown,
				fn: (s: unknown) => unknown,
			) => {
				const rec: Recorded = { name, attributes: { ...(options?.attributes ?? {}) } }
				spans.push(rec)
				return fn(span(rec))
			},
		}),
		getMeter: () => ({
			createCounter: () => ({ add: () => undefined }),
			createHistogram: () => ({ record: () => undefined }),
		}),
	}
})

let workdirs: string[] = []

beforeEach(() => {
	spans.length = 0
})

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

const AGENT = 'Turn Span Agent'

async function turnOf(
	sessionId: SessionId,
	child?: { parentSessionId: SessionId },
): Promise<Recorded | undefined> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-turnspan-'))
	workdirs.push(dir)
	await drainQuery({
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		toolsets: [],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			maxResponseTokens: 256,
		},
		agentId: 'agent_turnspan',
		agentName: AGENT,
		workingDirectory: dir,
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		topicId: fixtureId.topic('turnspan'),
		projectId: fixtureId.project('turnspan'),
		tenantId: fixtureId.tenant('turnspan'),
		messages: [createUserMessage('go')],
		...(child !== undefined && {
			parentSessionId: child.parentSessionId,
			parentTurnId: fixtureId.turn('parent'),
			depth: 1,
		}),
	})
	return spans.find((span) => span.name === agentTurnSpanName(AGENT))
}

describe('the root span of a turn', () => {
	it('is named for the turn, not a turn', () => {
		expect(agentTurnSpanName('Coder')).toBe('namzu.agent.turn Coder')
	})

	it('carries the session as the conversation, and the turn', async () => {
		const sessionId = fixtureId.session('turnspan')
		const root = await turnOf(sessionId)

		expect(root).toBeDefined()
		expect(root?.attributes['gen_ai.conversation.id']).toBe(sessionId)
		expect(typeof root?.attributes['namzu.turn.id']).toBe('string')
		expect(root?.attributes).not.toHaveProperty('namzu.run.id')
		// A root session's turn has no parent to name.
		expect(root?.attributes).not.toHaveProperty('namzu.session.parent_id')
	})

	it('names the delegating session on a child session’s turn', async () => {
		const parent = fixtureId.session('turnspan-parent')
		const root = await turnOf(fixtureId.session('turnspan-child'), { parentSessionId: parent })

		expect(root?.attributes['gen_ai.conversation.id']).toBe(fixtureId.session('turnspan-child'))
		expect(root?.attributes['namzu.session.parent_id']).toBe(parent)
		expect(root?.attributes).not.toHaveProperty('namzu.run.parent_id')
	})
})

describe('every span of a turn', () => {
	it('names the conversation and the turn: root, iteration, chat and tool', async () => {
		const sessionId = fixtureId.session('turnspan-all')
		const dir = await mkdtemp(join(tmpdir(), 'namzu-turnspan-'))
		workdirs.push(dir)
		const tools = testToolset(
			defineTool({
				name: 'echo',
				description: 'echo',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: 'ok' }),
			}),
		)
		const turn = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'call_1', name: 'echo', args: {} }], finishReason: 'tool_calls' },
					{ text: 'done' },
				],
			}),
			toolsets: [tools],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_turnspan',
			agentName: AGENT,
			workingDirectory: dir,
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			topicId: fixtureId.topic('turnspan'),
			projectId: fixtureId.project('turnspan'),
			tenantId: fixtureId.tenant('turnspan'),
			messages: [createUserMessage('go')],
		})

		const kinds = new Set(spans.map((span) => span.name.split(' ')[0]))
		expect(kinds).toEqual(
			new Set(['namzu.agent.turn', 'namzu.agent.iteration', 'chat', 'namzu.tool.execute']),
		)
		for (const span of spans) {
			expect(span.attributes['gen_ai.conversation.id'], span.name).toBe(sessionId)
			expect(span.attributes['namzu.turn.id'], span.name).toBe(turn.id)
		}
	})
})
