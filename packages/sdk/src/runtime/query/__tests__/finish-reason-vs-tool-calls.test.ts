import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The turn ended on `finishReason === 'stop'` before it looked at whether
 * the model had asked for tools. Endpoints on the function-calling wire shape —
 * gateways and local servers especially — routinely report `stop` on the
 * same response that carries a populated `tool_calls`, and three of this
 * repo's drivers passed that value through untouched.
 *
 * The damage was total and silent: every requested call skipped, an
 * assistant turn left carrying tool_use blocks nothing ever answered, and
 * the run settling as though it had finished the work.
 *
 * The existing suite could not see it, because the scripted mock reports
 * `tool_calls` whenever it emits one — which is what an honest provider
 * does, and therefore never the case that breaks.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs.splice(0))
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-finish-'))
	dirs.push(dir)
	return dir
}

const USAGE = {
	promptTokens: 1,
	completionTokens: 1,
	totalTokens: 2,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Asks for a tool, then claims the turn is over. */
function provider(reported: 'stop' | 'tool_calls'): LLMProvider {
	let turn = 0
	return {
		id: 'scripted',
		name: 'scripted',
		capabilities: {
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
		},
		async *chatStream(): AsyncIterable<StreamChunk> {
			turn++
			if (turn === 1) {
				yield {
					id: 'c1',
					delta: {
						toolCalls: [
							{
								index: 0,
								id: 'call_1',
								type: 'function',
								function: { name: 'echo', arguments: '{"text":"hi"}' },
							},
						],
						toolCallEnd: { index: 0, id: 'call_1' },
					},
				}
				// The lie under test.
				yield { id: 'c1', delta: {}, finishReason: reported, usage: USAGE }
				return
			}
			yield { id: 'c2', delta: { content: 'done' } }
			yield { id: 'c2', delta: {}, finishReason: 'stop', usage: USAGE }
		},
		async listModels() {
			return []
		},
		async healthCheck() {
			return true
		},
	}
}

async function run(reported: 'stop' | 'tool_calls') {
	const tools = new ToolRegistry()
	let calls = 0
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => {
			calls++
			return { success: true, output: 'ok' }
		},
	})

	const result = await drainQuery({
		provider: provider(reported),
		tools,
		messages: [createUserMessage('echo hi')],
		runConfig: {
			model: 'scripted-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_test',
		agentName: 'Test Agent',
		workingDirectory: await mkWorkdir(),
		sessionId: '6f08e9b2-1df4-4853-820e-e554e5e4426d' as SessionId,
		topicId: '2757402c-55c1-45a1-a52d-fb47e62b0260' as TopicId,
		projectId: 'd07527a2-fe96-4210-a70e-1ce94ede1307' as ProjectId,
		tenantId: '50c9c406-2c41-4010-a245-04d5a263b3d9' as TenantId,
	})

	return { result, calls }
}

describe('a provider that says stop while asking for a tool', () => {
	it('runs the tool anyway', async () => {
		// The calls are the fact and the reason is the summary; when they
		// disagree the calls win.
		expect((await run('stop')).calls).toBe(1)
	})

	it('leaves no tool call unanswered', async () => {
		const { result } = await run('stop')
		const requested = result.messages
			.filter((m) => m.role === 'assistant')
			.flatMap((m) => (m as { toolCalls?: { id: string }[] }).toolCalls ?? [])
			.map((c) => c.id)
		const answered = result.messages
			.filter((m) => m.role === 'tool')
			.map((m) => (m as unknown as { toolCallId: string }).toolCallId)

		// An assistant turn carrying a call nothing answered is a malformed
		// conversation, and the next request is rejected for it.
		expect(requested.length).toBeGreaterThan(0)
		for (const id of requested) expect(answered).toContain(id)
	})

	it('behaves exactly as it does for an honest provider', async () => {
		const dishonest = await run('stop')
		const honest = await run('tool_calls')
		expect(dishonest.calls).toBe(honest.calls)
		expect(dishonest.result.messages.filter((m) => m.role === 'tool')).toHaveLength(
			honest.result.messages.filter((m) => m.role === 'tool').length,
		)
	})

	it('still ends the turn when there are no tool calls', async () => {
		const tools = new ToolRegistry()
		const result = await drainQuery({
			provider: {
				id: 'plain',
				name: 'plain',
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsFunctionCalling: true,
				},
				async *chatStream(): AsyncIterable<StreamChunk> {
					yield { id: 'c', delta: { content: 'just an answer' } }
					yield { id: 'c', delta: {}, finishReason: 'stop', usage: USAGE }
				},
				async listModels() {
					return []
				},
				async healthCheck() {
					return true
				},
			},
			tools,
			messages: [createUserMessage('hi')],
			runConfig: {
				model: 'plain-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			workingDirectory: await mkWorkdir(),
			sessionId: '9e3c06c3-4635-4f90-b85d-a7b798a5088f' as SessionId,
			topicId: '55f0ba4c-b446-48ed-b7e5-cfc412bd9b25' as TopicId,
			projectId: '734b1691-cf5b-47fe-b45f-c7600c97891a' as ProjectId,
			tenantId: 'd65925ba-2100-45b0-8139-afb40f1f1fbc' as TenantId,
		})

		// The ordinary path must not have moved.
		expect(result.status).toBe('completed')
		expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(0)
	})
})
