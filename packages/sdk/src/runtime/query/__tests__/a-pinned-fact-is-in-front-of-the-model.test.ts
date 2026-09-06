import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Message } from '../../../types/message/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import {
	WORKING_MEMORY_HEADER,
	isWorkingMemoryMessage,
} from '../iteration/phases/working-memory.js'

/**
 * A pin exists to be seen. After a tool pins a fact, the next request the
 * model receives carries it in the working-memory slot — not only after
 * a compaction pass, and not only in a summary.
 */

registerMock()

describe('a fact a tool pinned', () => {
	it('is in the next model request, in the working-memory slot', async () => {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'probe',
				description: 'probes',
				inputSchema: z.object({}),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({
					success: true,
					output: 'ACTION1 moved the piece up',
					workingState: [{ key: 'controls', text: 'ACTION1 = up' }],
				}),
			}),
		)
		const call: MockTurn = {
			toolCalls: [{ id: 'c1', name: 'probe', args: {} }],
			finishReason: 'tool_calls',
		}
		const requests: string[][] = []
		const manager = {
			executeHooks: async (
				event: PluginHookEvent,
				ctx: Omit<PluginHookContext, 'pluginId' | 'event'>,
			) => {
				if (event === 'pre_llm_call' && ctx.request) {
					requests.push(
						ctx.request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
					)
				}
				return []
			},
		} as unknown as PluginLifecycleManager
		await drainQuery({
			provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
			tools,
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'probe it' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			compactionConfig: CompactionConfigSchema.parse({}),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			pluginManager: manager,
		})
		expect(requests.length).toBeGreaterThanOrEqual(2)
		const second = requests[1]?.join('\n') ?? ''
		expect(second).toContain('## Pinned by tools')
		expect(second).toContain('**controls**: ACTION1 = up _(probe)_')
		expect(requests[0]?.join('\n')).not.toContain('Pinned by tools')
	})
})

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function pinnedSlots(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === 'system' && isWorkingMemoryMessage(message.content)
			? [message.content ?? '']
			: [],
	)
}

it('replaces then removes the last pin after checkpoint restoration and compaction', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-pin-lifecycle-'))
	dirs.push(dir)
	const tools = new ToolRegistry()
	tools.register({
		name: 'set_pin',
		description: 'Update the current region',
		inputSchema: z.object({ text: z.string() }),
		execute: async ({ text }) => ({
			success: true,
			output: `Observed region. ${'detail '.repeat(800)}`,
			workingState: [{ key: 'region', text }],
		}),
	})
	const checkpointStore = new InMemoryCheckpointStore()
	const scope = {
		runId: generateRunId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
	const params = {
		...scope,
		tools,
		checkpointStore,
		agentId: 'pin-lifecycle',
		agentName: 'Pin lifecycle',
		workingDirectory: dir,
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 8 },
		compactionConfig: CompactionConfigSchema.parse({
			strategy: 'structured',
			llmVerification: false,
			clearToolResults: false,
			keepRecentMessages: 2,
			contextWindowTokens: 100_000,
		}),
	}
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'set_pin', args: { text: 'REGION_OLD' } }] },
			{ toolCalls: [{ name: 'set_pin', args: { text: 'REGION_NEW' } }] },
			{ text: 'Current state recorded.' },
		],
	})
	await drainQuery({
		...params,
		provider,
		runStore: new InMemoryRunStore(),
		messages: [
			createUserMessage(`Earlier investigation: ${'background '.repeat(800)}`),
			createAssistantMessage('The investigation is recorded.'),
			createUserMessage('Check the deployment region'),
		],
	})
	expect(pinnedSlots(provider.requests[1]?.messages ?? []).join('')).toContain('REGION_OLD')
	const updated = pinnedSlots(provider.requests[2]?.messages ?? []).join('')
	expect(updated).toContain('REGION_NEW')
	expect(updated).not.toContain('REGION_OLD')
	const checkpoint = (await checkpointStore.listCheckpoints(scope)).at(-1)
	expect(checkpoint?.workingState?.pins?.[0]?.text).toBe('REGION_NEW')
	if (!checkpoint) throw new Error('The pin update was not checkpointed')

	// Round-trip JSON into a fresh store: the ownership needed for deletion
	// cannot depend on the first query's object identities or closures.
	const restoredStore = new InMemoryCheckpointStore()
	await restoredStore.writeCheckpoint(scope, JSON.parse(JSON.stringify(checkpoint)))
	const resumed = new MockLLMProvider({
		turns: [
			{ error: { message: 'context_length_exceeded: force a compacted resume', status: 400 } },
			{ toolCalls: [{ name: 'set_pin', args: { text: '' } }] },
			{ text: 'Pin removed.' },
		],
	})
	const events: RunEvent[] = []
	await drainQuery(
		{
			...params,
			provider: resumed,
			checkpointStore: restoredStore,
			runStore: new InMemoryRunStore(),
			messages: [],
			resumeFromCheckpoint: checkpoint.id,
		},
		(event) => {
			events.push(event)
		},
	)

	expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
	expect(pinnedSlots(resumed.requests[1]?.messages ?? []).join('')).toContain('REGION_NEW')
	expect(pinnedSlots(resumed.requests.at(-1)?.messages ?? [])).toEqual([])
	const deletionCheckpoint = (await restoredStore.listCheckpoints(scope)).at(-1)
	expect(deletionCheckpoint?.workingState?.pins).toEqual([])
	if (!deletionCheckpoint) throw new Error('The pin deletion was not checkpointed')
	// The checkpoint is taken before the next refresh. It still carries the
	// previous slot but no pins, so deletion must also work on a fresh resume.
	expect(pinnedSlots(deletionCheckpoint.messages).join('')).toContain('REGION_NEW')
	const afterDeletionStore = new InMemoryCheckpointStore()
	await afterDeletionStore.writeCheckpoint(scope, JSON.parse(JSON.stringify(deletionCheckpoint)))
	const afterDeletion = new MockLLMProvider({ turns: [{ text: 'Resumed without pins.' }] })
	await drainQuery({
		...params,
		provider: afterDeletion,
		checkpointStore: afterDeletionStore,
		runStore: new InMemoryRunStore(),
		messages: [],
		resumeFromCheckpoint: deletionCheckpoint.id,
	})
	expect(pinnedSlots(afterDeletion.requests[0]?.messages ?? [])).toEqual([])
})

it('preserves an opaque inherited host ledger when no live provider or tool pins exist', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-host-ledger-'))
	dirs.push(dir)
	const ledger = `${WORKING_MEMORY_HEADER}\n\nHOST_OWNED_ARTIFACT_LEDGER`
	const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runStore: new InMemoryRunStore(),
		agentId: 'opaque-ledger',
		agentName: 'Opaque ledger',
		workingDirectory: dir,
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 2 },
		compactionConfig: CompactionConfigSchema.parse({ llmVerification: false }),
		messages: [createSystemMessage(ledger), createUserMessage('Continue')],
	})
	expect(pinnedSlots(provider.requests[0]?.messages ?? [])).toEqual([ledger])
})
