import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { buildCompactionMessage } from '../../../compaction/summary.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import {
	type Message,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import { drainQuery } from '../index.js'
import { WORKING_MEMORY_HEADER } from '../iteration/phases/working-memory.js'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const config = {
	strategy: 'structured' as const,
	triggerThreshold: 0.7,
	resetThreshold: 0.4,
	keepRecentMessages: 2,
	clearToolResults: true,
	recordShedHistory: true,
	keepRecentToolResults: 3,
	minToolResultCharsToClear: 1_000,
	maxToolResults: 30,
	maxListSize: 25,
	keepFirstEntries: 3,
	llmVerification: false,
	llmVerificationMaxTokens: 2_048,
	richStateThreshold: 15,
	convoTextBudget: 12_000,
	maxSentencesPerTurn: 5,
	maxCharsPerNote: 500,
	maxCharsPerRequirement: 300,
	maxCharsPerTask: 400,
}

/** Records failed requests too, then accepts once compaction made room. */
class OverflowOnceProvider extends MockLLMProvider {
	readonly prompts: ChatCompletionParams['messages'][] = []
	private overflowed = false

	constructor() {
		super({ turns: [{ text: 'answered after compaction' }] })
	}

	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.prompts.push(structuredClone(params.messages))
		if (!this.overflowed) {
			this.overflowed = true
			throw Object.assign(new Error('context_length_exceeded: planted overflow'), { status: 400 })
		}
		yield* super.chatStream(params)
	}
}

async function workingDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-state-bearing-history-'))
	dirs.push(dir)
	return dir
}

function textOf(messages: readonly Message[]): string {
	return messages
		.map((message) => (typeof message.content === 'string' ? message.content : ''))
		.join('\n')
}

describe('state-bearing history reaches a fresh run', () => {
	it('keeps a prior compaction summary through overflow relief and the verified snapshot', async () => {
		const provider = new OverflowOnceProvider()
		const store = new InMemoryRunStore()
		const oldFact = 'ONLY_THE_PRIOR_COMPACTION_KNOWS_THIS_FACT'
		const stalePrompt = 'STALE_SYSTEM_PROMPT_MUST_NOT_RETURN'
		const messages = [
			buildCompactionMessage(oldFact),
			createSystemMessage(stalePrompt),
			...Array.from({ length: 12 }, (_, index) =>
				createUserMessage(`newer turn ${index}: ${'context '.repeat(400)}`),
			),
		]

		const result = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			runStore: store,
			retry: false,
			compactionConfig: config,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_state_history',
			agentName: 'State History',
			messages,
			workingDirectory: await workingDirectory(),
			sessionId: fixtureId.session('state_history'),
			topicId: fixtureId.topic('state_history'),
			projectId: fixtureId.project('state_history'),
			tenantId: fixtureId.tenant('state_history'),
		})

		expect(provider.prompts).toHaveLength(2)
		expect(textOf(provider.prompts[0] ?? [])).toContain(oldFact)
		expect(textOf(provider.prompts[1] ?? [])).toContain(oldFact)
		expect(textOf(provider.prompts[0] ?? [])).not.toContain(stalePrompt)
		expect(result.result).toBe('answered after compaction')

		const snapshot = await store.readMessages()
		const events = await store.readEvents()
		expect(snapshot.kind).toBe('available')
		if (snapshot.kind !== 'available') return
		expect(snapshot.throughEventSeq).toBe(events.at(-1)?.seq)
		expect(textOf(snapshot.messages)).toContain(oldFact)
		expect(
			snapshot.messages.find(
				(message) => typeof message.content === 'string' && message.content.includes(oldFact),
			)?.retain,
		).toBe(true)
	})

	it('restores the produced-artifact ledger but not an arbitrary old system prompt', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const ledgerFact = 'ARTIFACT_LEDGER_FACT_REACHES_PROVIDER'
		const stalePrompt = 'OLD_STATIC_PROMPT_DOES_NOT_REACH_PROVIDER'

		await drainQuery({
			provider,
			tools: new ToolRegistry(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
			},
			agentId: 'agent_working_memory_history',
			agentName: 'Working Memory History',
			messages: [
				createSystemMessage(`${WORKING_MEMORY_HEADER}\n\n${ledgerFact}`),
				createSystemMessage(stalePrompt),
				createUserMessage('continue'),
			],
			workingDirectory: await workingDirectory(),
			sessionId: fixtureId.session('working_memory_history'),
			topicId: fixtureId.topic('working_memory_history'),
			projectId: fixtureId.project('working_memory_history'),
			tenantId: fixtureId.tenant('working_memory_history'),
		})

		const sent = textOf(provider.requests[0]?.messages ?? [])
		expect(sent).toContain(ledgerFact)
		expect(sent).not.toContain(stalePrompt)
	})
})
