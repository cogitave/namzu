// Current-code invariants asserted (2026-07-12, ses_015 Phase A):
// - A post-success abort accounts usage + fires token_usage_updated but pushes
//   NO assistant message and executes NO tools; the run ends 'cancelled' and its
//   history is repaired (dangling tool calls healed) in place.
// - finishReason 'length' WITH tool calls sanitizes invalid JSON arguments to
//   '{}', pushes one synthesized not-executed tool result per call (never
//   executing the tools), completes the iteration through the normal tail, and
//   continues; WITHOUT tool calls it warns and ends the turn.
// - A context_overflow provider error is recovered by reducing history and
//   reissuing within the same iteration; when the reducer cannot shrink, the
//   run fails and the history is left untouched (candidate-first no-commit).
// These tests drive the real query() loop with hand-rolled fake providers.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { ProviderRequestError } from '../../../../provider/errors.js'
import { ToolRegistry } from '../../../../registry/tool/execute.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../../../types/ids/index.js'
import {
	type AssistantMessage,
	type Message,
	type ToolMessage,
	createAssistantMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../../types/provider/index.js'
import type { AgentRunConfig, Run, RunEvent } from '../../../../types/run/index.js'
import { drainQuery } from '../../index.js'

interface FakeProvider extends LLMProvider {
	calls: number
}

function makeProvider(
	chat: (params: ChatCompletionParams, call: number) => Promise<ChatCompletionResponse>,
): FakeProvider {
	const provider: FakeProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			const index = provider.calls
			provider.calls += 1
			return chat(params, index)
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

const USAGE = { promptTokens: 5, completionTokens: 5, totalTokens: 10 }

function stopResponse(content: string): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content },
		finishReason: 'stop',
		usage: USAGE,
	} as ChatCompletionResponse
}

function toolResponse(
	id: string,
	args: string,
	finishReason: ChatCompletionResponse['finishReason'] = 'tool_calls',
): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id, type: 'function', function: { name: 'foo', arguments: args } }],
		},
		finishReason,
		usage: USAGE,
	} as ChatCompletionResponse
}

function lengthResponseNoTools(content: string): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content },
		finishReason: 'length',
		usage: USAGE,
	} as ChatCompletionResponse
}

const dirs: string[] = []

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-ses015-'))
	dirs.push(dir)
	return dir
}

async function runQuery(opts: {
	provider: LLMProvider
	messages: Message[]
	signal?: AbortSignal
	runConfig?: Partial<AgentRunConfig>
}): Promise<{ run: Run; events: RunEvent[] }> {
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: new ToolRegistry(),
			runConfig: {
				model: 'm',
				tokenBudget: 1_000_000,
				timeoutMs: 600_000,
				maxIterations: 50,
				temperature: 0.3,
				...opts.runConfig,
			},
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: tmp(),
			messages: opts.messages,
			signal: opts.signal,
			sessionId: 'ses_test' as SessionId,
			threadId: 'thr_test' as ThreadId,
			projectId: 'prj_test' as ProjectId,
			tenantId: 'tnt_test' as TenantId,
		},
		(e) => {
			events.push(e)
		},
	)
	return { run, events }
}

afterEach(() => {
	dirs.length = 0
})

describe('iteration loop — post-success abort', () => {
	it('accounts usage, skips the assistant push, and cancels', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => {
			ctrl.abort()
			return toolResponse('c1', '{}')
		})

		const { run, events } = await runQuery({
			provider,
			messages: [createUserMessage('hello')],
			signal: ctrl.signal,
		})

		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(provider.calls).toBe(1)
		expect(run.messages.some((m) => m.role === 'assistant')).toBe(false)
		expect(events.some((e) => e.type === 'token_usage_updated')).toBe(true)
		expect(events.some((e) => e.type === 'llm_response')).toBe(false)
	})

	it('repairs a dangling tool call in the run history on cancellation', async () => {
		const ctrl = new AbortController()
		const provider = makeProvider(async () => {
			ctrl.abort()
			return stopResponse('ignored')
		})
		const dangling: AssistantMessage = createAssistantMessage(null, [
			{ id: 'call_x', type: 'function', function: { name: 'foo', arguments: '{}' } },
		])

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('hi'), dangling],
			signal: ctrl.signal,
		})

		expect(run.status).toBe('cancelled')
		const toolMsg = run.messages.find(
			(m): m is ToolMessage => m.role === 'tool' && (m as ToolMessage).toolCallId === 'call_x',
		)
		expect(toolMsg).toBeDefined()
		expect(toolMsg?.content).toContain('Tool result missing')
		expect(findDanglingMessages(run.messages).isValid).toBe(true)
	})
})

describe('iteration loop — finishReason length', () => {
	it('sanitizes truncated tool args, synthesizes not-executed results, and continues', async () => {
		const provider = makeProvider(async (_p, call) => {
			if (call === 0) return toolResponse('c1', '{"a":', 'length') // invalid JSON args
			return stopResponse('done')
		})

		const { run, events } = await runQuery({
			provider,
			messages: [createUserMessage('go')],
		})

		expect(provider.calls).toBe(2)
		expect(run.status).toBe('completed')

		const assistantWithTool = run.messages.find(
			(m): m is AssistantMessage => m.role === 'assistant' && !!(m as AssistantMessage).toolCalls,
		)
		expect(assistantWithTool?.toolCalls?.[0]?.function.arguments).toBe('{}')

		const toolMsg = run.messages.find(
			(m): m is ToolMessage => m.role === 'tool' && (m as ToolMessage).toolCallId === 'c1',
		)
		expect(toolMsg?.content).toContain('Tool not executed')

		const completedWithTools = events.filter(
			(e): e is Extract<RunEvent, { type: 'iteration_completed' }> =>
				e.type === 'iteration_completed',
		)
		expect(completedWithTools.some((e) => e.hasToolCalls === true)).toBe(true)
		expect(events.some((e) => e.type === 'tool_executing')).toBe(false)
	})

	it('warns and ends the turn when truncated with no tool calls', async () => {
		const provider = makeProvider(async () => lengthResponseNoTools('partial answer'))
		const { run } = await runQuery({ provider, messages: [createUserMessage('go')] })

		expect(provider.calls).toBe(1)
		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('end_turn')
	})
})

describe('iteration loop — context overflow recovery', () => {
	it('reduces history and reissues within the same iteration', async () => {
		const provider = makeProvider(async (_p, call) => {
			if (call === 0) throw new ProviderRequestError('overflow', { kind: 'context_overflow' })
			return stopResponse('recovered')
		})
		const seeded: Message[] = [
			createUserMessage('u1 with a long body of text to have something worth trimming'),
			createAssistantMessage('a1 with a long body of text to have something worth trimming'),
			createUserMessage('u2 with a long body of text to have something worth trimming'),
			createAssistantMessage('a2 with a long body of text to have something worth trimming'),
			createUserMessage('u3 with a long body of text to have something worth trimming'),
		]

		const { run } = await runQuery({ provider, messages: seeded })

		expect(provider.calls).toBe(2)
		expect(run.status).toBe('completed')
		// Oldest messages were trimmed by the reduction.
		expect(run.messages.some((m) => m.content?.includes('u1 with a long body'))).toBe(false)
	})

	it('fails without mutating history when overflow cannot be reduced', async () => {
		const provider = makeProvider(async () => {
			throw new ProviderRequestError('overflow', { kind: 'context_overflow' })
		})

		const { run } = await runQuery({
			provider,
			messages: [createUserMessage('only one message in history')],
		})

		expect(provider.calls).toBe(1)
		expect(run.status).toBe('failed')
		expect(run.messages.some((m) => m.content?.includes('only one message'))).toBe(true)
	})
})
