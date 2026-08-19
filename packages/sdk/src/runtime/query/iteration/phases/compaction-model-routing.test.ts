import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import type { TaskRouterConfig } from '../../../../types/router/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * The compaction summary is the only model call a run makes that nobody
 * asked for, and it was hardwired to the primary model. `taskRouter` had been
 * accepted, schema-validated and threaded through four types since it was
 * added, with `resolveTaskModel` exported and never called — so a host who
 * pointed compaction at a cheap model kept paying the expensive one.
 */

function harness(taskRouter?: TaskRouterConfig): {
	ctx: IterationContext
	modelsUsed: string[]
} {
	const messages: Message[] = [
		{ role: 'system', content: 'prompt', timestamp: 1 },
		...Array.from({ length: 40 }, (_, i) => ({
			role: 'user' as const,
			content: `turn ${i} `.repeat(200),
			timestamp: 1,
		})),
	]
	const config: CompactionConfig = {
		...CompactionConfigSchema.parse({}),
		contextWindowTokens: 1_000,
		keepRecentMessages: 4,
		llmVerification: true,
		// Keep the slot count under the rich-state threshold so the verified
		// summary path — the one that calls a model — is the one taken.
		richStateThreshold: 1_000,
	}
	const modelsUsed: string[] = []
	const abortController = new AbortController()

	const ctx = {
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		runConfig: { model: 'primary-model' },
		...(taskRouter ? { taskRouter } : {}),
		runMgr: {
			id: 'run_routing',
			messages,
			accumulateUsage: vi.fn(),
			clearLastPromptTokens: vi.fn(),
		},
		provider: {
			chatStream: async function* (params: { model: string }) {
				modelsUsed.push(params.model)
				yield { id: 'c1', delta: { content: 'a summary' } }
				yield {
					id: 'c1',
					delta: {},
					finishReason: 'stop',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				}
			},
		},
		abortController,
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IterationContext

	return { ctx, modelsUsed }
}

describe('the compaction summary goes to the model a host routed it to', () => {
	it('uses the primary model when nothing is routed', async () => {
		const h = harness()

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['primary-model'])
	})

	it('uses the compaction model when one is named', async () => {
		const h = harness({ compaction: 'small-model' })

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['small-model'])
	})

	it('falls back to the router default', async () => {
		const h = harness({ default: 'fallback-model' })

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['fallback-model'])
	})

	it('prefers the specific key over the default', async () => {
		const h = harness({ compaction: 'small-model', default: 'fallback-model' })

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['small-model'])
	})

	it('ignores a key that names no model', async () => {
		// `null` is what the schema produces for an explicitly cleared key, and
		// it has to mean "unrouted" rather than "route to nothing" — sending an
		// empty model id is an endpoint error on backends where the id IS the
		// endpoint.
		const h = harness({ compaction: null, default: 'fallback-model' })

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['fallback-model'])
	})

	it('does not route a key the runtime does not consult', async () => {
		// `coding` is documented as inert. Pinning that keeps the docs honest:
		// if a future change starts consulting it, this test says so.
		const h = harness({ coding: 'coding-model' })

		await runCompactionCheck(h.ctx)

		expect(h.modelsUsed).toEqual(['primary-model'])
	})
})
