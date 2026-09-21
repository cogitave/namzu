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
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { Message } from '../../../types/message/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { PluginHookContext, PluginHookEvent } from '../../../types/plugin/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { restoreCheckpointContext } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'
import { heldCheckpointStore, memorySession, turnScope } from './support/session.js'
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
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
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

/**
 * The slot as a REQUEST carries it: request-only context after the history,
 * never a system message a driver would hoist ahead of the conversation.
 * Asserting the absence from the system run here means every request these
 * tests read also proves the placement.
 */
function pinnedSlots(messages: readonly Message[]): string[] {
	expect(
		messages.some(
			(message) => message.role === 'system' && isWorkingMemoryMessage(message.content),
		),
	).toBe(false)
	// Labelled like every other step-context message; the slot follows the
	// label line verbatim.
	const label = 'Current step context (runtime-generated; not a new user request):\n'
	return messages.flatMap((message) => {
		if (
			message.role !== 'user' ||
			message.source?.type !== 'runtime-context' ||
			message.source.kind !== 'step-context' ||
			typeof message.content !== 'string' ||
			!message.content.startsWith(label)
		)
			return []
		const slot = message.content.slice(label.length)
		return isWorkingMemoryMessage(slot) ? [slot] : []
	})
}

/** The slot as the RUN's history keeps it: in the leading system run. */
function historySlots(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === 'system' && isWorkingMemoryMessage(message.content)
			? [message.content ?? '']
			: [],
	)
}

/** Pause at the `nth` cadence checkpoint this handler is asked about, continue at every other. */
function pauseAtCheckpoint(nth: number) {
	let seen = 0
	return async (request: HITLDecisionRequest) => {
		if (request.type !== 'iteration_checkpoint') return { action: 'continue' } as const
		seen++
		return seen === nth
			? ({ action: 'pause', reason: 'look at the pins' } as const)
			: ({ action: 'continue' } as const)
	}
}

it('replaces then removes the last pin across a resume from a checkpoint and a compaction', async () => {
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
	const session = memorySession()
	const turnId = generateTurnId()
	const params = {
		...session,
		turnId,
		tools,
		agentId: 'pin-lifecycle',
		agentName: 'Pin lifecycle',
		workingDirectory: dir,
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 8 },
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
		],
	})
	// The turn pauses at the checkpoint after the pin was replaced, so a
	// later process can resume it from there.
	await drainQuery({
		...params,
		provider,
		resumeHandler: pauseAtCheckpoint(2),
		messages: [
			createUserMessage(`Earlier investigation: ${'background '.repeat(800)}`),
			createAssistantMessage('The investigation is recorded.'),
			createUserMessage('Check the deployment region'),
		],
	})
	expect(pinnedSlots(provider.requests[1]?.messages ?? []).join('')).toContain('REGION_OLD')
	const scope = turnScope(session.sessionId, turnId)
	const store = await heldCheckpointStore(session.sessionLog)
	const checkpoint = (await store.list(scope)).at(-1)
	expect(checkpoint?.workingState?.pins?.[0]?.text).toBe('REGION_NEW')
	if (!checkpoint) throw new Error('The pin update was not checkpointed')

	const resumeScope = { ...scope, topicId: session.topicId }
	const resumed = new MockLLMProvider({
		turns: [
			{ error: { message: 'context_length_exceeded: force a compacted resume', status: 400 } },
			{ toolCalls: [{ name: 'set_pin', args: { text: '' } }] },
		],
	})
	const events: SessionEvent[] = []
	await resumeSession({
		...params,
		scope: resumeScope,
		checkpointStore: store,
		provider: resumed,
		pendingDecision: { action: 'continue' },
		resumeHandler: pauseAtCheckpoint(1),
		listener: (event) => {
			events.push(event)
		},
	})

	expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
	expect(pinnedSlots(resumed.requests[1]?.messages ?? []).join('')).toContain('REGION_NEW')
	const deletionCheckpoint = (await store.list(scope)).at(-1)
	expect(deletionCheckpoint?.workingState?.pins).toEqual([])
	if (!deletionCheckpoint) throw new Error('The pin deletion was not checkpointed')
	// The checkpoint is taken before the next refresh. Its context still
	// carries the previous slot but no pins, so deletion must also work on a
	// fresh resume.
	const context = await restoreCheckpointContext(session.sessionLog, deletionCheckpoint)
	expect(historySlots(context.messages).join('')).toContain('REGION_NEW')
	const afterDeletion = new MockLLMProvider({ turns: [{ text: 'Resumed without pins.' }] })
	await resumeSession({
		...params,
		scope: resumeScope,
		checkpointStore: store,
		provider: afterDeletion,
		pendingDecision: { action: 'continue' },
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
		...memorySession(),
		agentId: 'opaque-ledger',
		agentName: 'Opaque ledger',
		workingDirectory: dir,
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 2 },
		compactionConfig: CompactionConfigSchema.parse({ llmVerification: false }),
		messages: [createSystemMessage(ledger), createUserMessage('Continue')],
	})
	expect(pinnedSlots(provider.requests[0]?.messages ?? [])).toEqual([ledger])
})
