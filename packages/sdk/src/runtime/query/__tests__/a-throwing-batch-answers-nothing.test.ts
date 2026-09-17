import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { PluginRegistry } from '../../../registry/plugin/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import type { PluginId } from '../../../types/ids/index.js'
import type { AssistantMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { resolveLogger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'
import { drainQuery } from '../index.js'

/**
 * `executeBatch` answers every `tool_use` — for every path that RETURNS.
 *
 * The docblock on it claimed the guarantee held "by construction", because
 * there is one place that turns a batch into messages and it covers all of
 * them. That is true of the hole-filling loop and false of the code around
 * it: the loop runs only if `Promise.all([...parallel, serial])` resolves,
 * and `serial = serial.then(run)` means one per-call rejection skips every
 * LATER serial call and rejects the batch. Nothing is answered on that path
 * — no messages are produced at all — and the run fails, leaving a
 * transcript whose assistant turn has unanswered `tool_use` blocks for a
 * resume to repair.
 *
 * These cases pin that, because it is the thing a future refactor would
 * otherwise guess at. Two reachable routes are driven:
 *
 *  - `executeBatch` called with calls it must run itself, where
 *    `executeSingle` reaches the pre-tool hook and the hook's own run event
 *    is a store write that fails;
 *  - a real run, where the call throws on its retry admission — the
 *    admission `executeSingle` takes from inside the batch, so the batch's
 *    `Promise.all` is what rejects.
 */

registerMock()

const TOOL_CALL_IDS = ['call_a', 'call_b', 'call_c']
const HOOK_EVENT = 'plugin_hook_executing'
const REFUSAL = 'the transcript refused the hook record'

/**
 * A transcript write that refuses a call's RETRY admission.
 *
 * `initialize` and `batch` are admitted before the batch starts; a `retry`
 * is admitted by `executeSingle`, from inside it. `ToolCallBudget.admit`
 * latches that failure and rethrows, and the executor rethrows it on a
 * non-aborting run — the per-call throw this file is about.
 */
class RefusingRunStore extends InMemoryRunStore {
	readonly refusedRetries: string[] = []

	override async appendEvent(event: RunEvent): Promise<void> {
		if (event.type === 'tool_calls_admitted' && event.kind === 'retry') {
			this.refusedRetries.push(event.kind)
			throw new Error(REFUSAL)
		}
		return await super.appendEvent(event)
	}
}

function toolsThatRecord(executions: string[]): ToolRegistry {
	const tools = new ToolRegistry()
	// No `isConcurrencySafe`, so every call is scheduled onto the serial
	// chain — which is where one rejection skips the ones behind it.
	tools.register({
		name: 'note',
		description: 'records that it ran',
		inputSchema: z.object({ tag: z.string() }),
		execute: async ({ tag }: { tag: string }) => {
			executions.push(tag)
			return { success: true, output: tag }
		},
	})
	return tools
}

function pluginThatObserves(tools: ToolRegistry): PluginLifecycleManager {
	const manager = new PluginLifecycleManager({
		pluginRegistry: new PluginRegistry(),
		toolRegistry: tools,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: resolveLogger(undefined),
	})
	manager.registerHook('batch_observer' as PluginId, {
		event: 'pre_tool_use',
		handler: async () => ({ action: 'continue' }),
	})
	return manager
}

function responseWithCalls(): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: TOOL_CALL_IDS.map((id) => ({
				id,
				type: 'function',
				function: { name: 'note', arguments: JSON.stringify({ tag: id }) },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

describe('a batch whose per-call work throws', () => {
	it('answers nothing, and the calls behind the throwing one never run', async () => {
		const executions: string[] = []
		const tools = toolsThatRecord(executions)
		const events: RunEvent[] = []
		const runId = generateRunId()
		const executor = new ToolExecutor(
			{
				tools,
				pluginManager: pluginThatObserves(tools),
				runId,
				workingDirectory: process.cwd(),
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(runId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
			async (event) => {
				events.push(event)
				// The transcript write behind a pre-tool hook. It fails for the
				// FIRST call, which is the throw; if the batch survived that, the
				// two behind it would run and be recorded.
				if (event.type === HOOK_EVENT) throw new Error(REFUSAL)
			},
			resolveLogger(undefined),
		)

		const outcome = await executor.executeBatch(responseWithCalls()).then(
			() => ({ kind: 'returned' as const, error: undefined }),
			(error: unknown) => ({ kind: 'rejected' as const, error }),
		)

		expect(outcome.kind).toBe('rejected')
		expect(outcome.error).toBeInstanceOf(Error)
		// The first call threw before its tool ran, and `serial` carried the
		// rejection: the second and third were never scheduled at all.
		expect(executions).toEqual([])
		// Which is the whole point — nothing answered them, so no
		// `tool_completed` was emitted for any of the three.
		expect(events.filter((event) => event.type === 'tool_completed')).toEqual([])
	})
})

describe('a run whose tool batch throws', () => {
	it('fails, and leaves the assistant turn unanswered for a resume to repair', async () => {
		const executions: string[] = []
		// Fails once and is retryable, so the call reaches its retry admission
		// — the one admission that happens INSIDE the batch, per call.
		const tools = new ToolRegistry()
		tools.register({
			name: 'flaky',
			description: 'fails once, then succeeds',
			inputSchema: z.object({ tag: z.string() }),
			maxRetries: 1,
			execute: async ({ tag }: { tag: string }) => {
				executions.push(tag)
				return executions.filter((seen) => seen === tag).length === 1
					? { success: false, output: '', error: 'transient', retryable: true }
					: { success: true, output: tag }
			},
		})
		const runStore = new RefusingRunStore()

		const run: Run = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: TOOL_CALL_IDS.map((id) => ({
							id,
							name: 'flaky',
							args: { tag: id },
						})),
					},
					{ text: 'done' },
				],
			}),
			tools,
			runStore,
			checkpointStore: new InMemoryCheckpointStore(),
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			maxToolCalls: 50,
			runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 3 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		})

		// The route was actually walked: the batch was admitted, and the retry
		// behind it was refused.
		expect(runStore.refusedRetries).toEqual(['retry'])

		// What the run does next: it fails, rather than answering the batch.
		expect(run.status).toBe('failed')

		// And the hole is visible in the transcript. The assistant turn asked
		// for three calls and nothing answered them, which is the malformed
		// state a resume exists to repair.
		const assistant = run.messages.find(
			(message): message is AssistantMessage =>
				message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
		)
		expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(TOOL_CALL_IDS)
		expect(run.messages.filter((message) => message.role === 'tool')).toEqual([])
		// Only the call that threw got as far as running. The two behind it
		// were never scheduled, which is the poisoning of the serial chain
		// seen from the outside.
		expect(executions).toEqual(['call_a'])
	})
})
