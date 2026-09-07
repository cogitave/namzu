import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { estimateMessagesTokens } from '../../../compaction/token-estimate.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { drainQuery } from '../index.js'

registerMock()
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function setup(base: string, selected: string, turns = 1) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-selected-context-'))
	dirs.push(workingDirectory)
	const lookups: string[] = []
	const preparationWindows: number[] = []
	let preparations = 0
	const provider = new MockLLMProvider({
		nextTurn: (request, index) => {
			// The first request must already fit, without using a provider rejection
			// as the way to discover the selected model's smaller window.
			expect(estimateMessagesTokens(request.messages)).toBeLessThan(
				selected === 'narrow' ? 6_000 : 200_000,
			)
			return index + 1 < turns
				? {
						toolCalls: [{ name: 'noop', args: {} }],
						usage: { promptTokens: 50, completionTokens: 10 },
					}
				: { text: 'done', usage: { promptTokens: 50, completionTokens: 10 } }
		},
	})
	Object.assign(provider, {
		resolveContextWindow: async (model: string) => {
			lookups.push(model)
			return model === 'narrow' ? 6_000 : 200_000
		},
	})
	const tools = new ToolRegistry()
	tools.register({
		name: 'noop',
		description: 'No effects',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	})
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			projectId: fixtureId.project('selected-context'),
			sessionId: fixtureId.session('selected-context'),
			topicId: fixtureId.topic('selected-context'),
			tenantId: fixtureId.tenant('selected-context'),
			provider,
			tools,
			workingDirectory,
			runStore: new InMemoryRunStore(),
			agentId: 'context-audit',
			agentName: 'Context audit',
			runConfig: { model: base, timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 4 },
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'structured',
				llmVerification: false,
				clearToolResults: false,
				keepRecentMessages: 2,
			}),
			messages: [
				createUserMessage('Repair the queue and retain the constraints.'),
				createAssistantMessage(`OLD_BULK_MARKER ${'background '.repeat(4_000)}`),
				createUserMessage('Now verify the current outcome.'),
				createAssistantMessage('Ready to verify.'),
			],
			prepareStep: [
				() => {
					preparations++
					return { model: selected }
				},
				({ contextBudget }) => {
					preparationWindows.push(contextBudget?.windowTokens ?? 0)
					return undefined
				},
			],
		},
		(event) => {
			events.push(event)
		},
	)
	return { run, provider, events, lookups, preparationWindows, preparations }
}

it('compacts before sending to a smaller selected model and reports its provider window', async () => {
	const { run, provider, events, lookups, preparationWindows, preparations } = await setup(
		'wide',
		'narrow',
	)
	expect(run.status).toBe('completed')
	expect(provider.requests).toHaveLength(1)
	expect(preparations).toBe(1)
	expect(lookups).toEqual(['wide', 'narrow'])
	expect(preparationWindows).toEqual([6_000])
	expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
	const usage = events.filter((event) => event.type === 'token_usage_updated')
	expect(usage.length).toBeGreaterThan(0)
	for (const event of usage) {
		if (event.type !== 'token_usage_updated') continue
		expect(event.contextWindowTokens).toBe(6_000)
		expect(event.windowSource).toBe('provider')
	}
})

it('caches selected model metadata across steps without replaying preparation', async () => {
	const { run, provider, lookups, preparationWindows, preparations } = await setup(
		'wide',
		'narrow',
		2,
	)
	expect(run.status).toBe('completed')
	expect(provider.requests).toHaveLength(2)
	expect(preparations).toBe(2)
	expect(lookups).toEqual(['wide', 'narrow'])
	expect(preparationWindows).toEqual([6_000, 6_000])
})
