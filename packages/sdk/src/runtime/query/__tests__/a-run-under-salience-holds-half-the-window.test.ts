import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { query } from '../index.js'

/**
 * Under `strategy: 'salience'` the context is held near half the window,
 * by evicting the least salient messages, long before the summary
 * trigger — and the summary path is not paid for on the way.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const dump = (i: number): MockTurn => ({
	toolCalls: [{ id: `d${i}`, name: 'dump', args: { which: i } }],
	finishReason: 'tool_calls',
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'dump',
			description: 'returns a lot',
			inputSchema: z.object({ which: z.number() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ which }) => ({
				success: true,
				output: `dump ${which}: ${'filler text '.repeat(400)}`,
			}),
		}),
	)
	return registry
}

describe('a run under the salience strategy', () => {
	it('clears low-salience results at the soft target and never summarises below the trigger', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-salience-'))
		dirs.push(workingDirectory)
		const events: RunEvent[] = []
		const turns = Array.from({ length: 8 }, (_, i) => dump(i))
		for await (const event of query({
			provider: new MockLLMProvider({ turns: [...turns, { text: 'done' }] }),
			tools: tools(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 500_000, maxIterations: 12 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('dump everything, then tell me about dump 7')],
			workingDirectory,
			sessionId: 'ses_s' as SessionId,
			topicId: 'top_s' as TopicId,
			projectId: 'prj_s' as ProjectId,
			tenantId: 'tnt_s' as TenantId,
			resumeHandler: async () => ({ action: 'continue' }),
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'salience',
				contextWindowTokens: 8_000,
				keepRecentMessages: 2,
				llmVerification: false,
			}),
		})) {
			events.push(event)
		}
		const cleared = events.filter((e) => e.type === 'compaction_tool_results_cleared')
		expect(cleared.length).toBeGreaterThan(0)
		// Held near half the window: after the first pass, no request went out
		// with the context above the summary trigger.
		const contexts = events.flatMap((e) =>
			e.type === 'token_usage_updated' && e.contextTokens !== undefined ? [e.contextTokens] : [],
		)
		expect(Math.max(...contexts)).toBeLessThan(8_000 * 0.7)
		expect(events.some((e) => e.type === 'compaction_completed')).toBe(false)
		expect(events.some((e) => e.type === 'run_completed')).toBe(true)
	})
})
