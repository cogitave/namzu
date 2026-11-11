import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { recordRestorable } from '../../../../compaction/restore.js'
import { COMPACTION_HEADER } from '../../../../compaction/summary.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * After a compaction the skills the model loaded and the files it read are
 * back in front of it, and a host can add its own line.
 */

function harness(options: { hostNote?: () => string | undefined | Promise<string | undefined> }) {
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
		contextWindowTokens: 100_000,
		keepRecentMessages: 4,
		llmVerification: false,
		richStateThreshold: 1_000,
		triggerThreshold: 0.01,
	}
	const manager = new WorkingStateManager(config)
	const ctx = {
		compactionConfig: config,
		workingStateManager: manager,
		turnConfig: { model: 'primary-model' },
		tools: { listNames: () => [] },
		recorder: {
			id: '0b69064f-36a8-4ec0-87c8-5ec601789313',
			messages,
			accumulateUsage: vi.fn(),
			clearLastPromptTokens: vi.fn(),
		},
		...(options.hostNote ? { postCompactionContext: options.hostNote } : {}),
		abortController: new AbortController(),
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IterationContext
	return { ctx, manager }
}

const summaryOf = (ctx: IterationContext): string =>
	String(
		ctx.recorder.messages.find(
			(m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER),
		)?.content,
	)

describe('what comes back after a compaction', () => {
	it('puts the loaded skill, the read file and the host note after the summary', async () => {
		const h = harness({ hostNote: () => '### Plan file\n\nThe plan is at plans/plan.md.' })
		recordRestorable(h.manager, {
			toolName: 'skill',
			input: { name: 'release-notes' },
			output: 'Step one: gather the merged changes.',
			success: true,
		})
		recordRestorable(h.manager, {
			toolName: 'read',
			input: { path: 'src/a.ts' },
			output: '1\tconst answer = 42',
			success: true,
		})

		await runCompactionCheck(h.ctx, { force: true })

		const summary = summaryOf(h.ctx)
		expect(summary).toContain('## Restored after compaction')
		expect(summary).toContain('<loaded-skill name="release-notes">')
		expect(summary).toContain('Step one: gather the merged changes.')
		expect(summary).toContain('### File: src/a.ts')
		expect(summary).toContain('const answer = 42')
		expect(summary).toContain('The plan is at plans/plan.md.')
	})

	it('does not put a skill back when its instructions are whole in what the pass keeps', async () => {
		const h = harness({})
		const call = {
			role: 'assistant' as const,
			content: null,
			toolCalls: [
				{
					id: 'k1',
					type: 'function' as const,
					function: {
						name: 'skill',
						arguments: JSON.stringify({ name: 'release-notes' }),
					},
				},
			],
			timestamp: 1,
		}
		const result = {
			role: 'tool' as const,
			content: 'Step one: gather the merged changes.',
			toolCallId: 'k1',
			timestamp: 1,
		}
		// Loaded in the last messages, which the pass keeps verbatim.
		h.ctx.recorder.messages.push(call, result)
		recordRestorable(h.manager, {
			toolName: 'skill',
			input: { name: 'release-notes' },
			output: 'Step one: gather the merged changes.',
			success: true,
		})

		await runCompactionCheck(h.ctx, { force: true })

		const text = JSON.stringify(h.ctx.recorder.messages)
		expect(text.split('Step one: gather the merged changes.').length - 1).toBe(1)
		expect(summaryOf(h.ctx)).not.toContain('<loaded-skill')
	})

	it('adds nothing when nothing was loaded and the host has nothing to carry', async () => {
		const h = harness({ hostNote: () => undefined })

		await runCompactionCheck(h.ctx, { force: true })

		expect(summaryOf(h.ctx)).not.toContain('Restored after compaction')
	})

	it('still compacts when the host note cannot be read', async () => {
		const h = harness({
			hostNote: () => {
				throw new Error('plan file unreadable')
			},
		})

		await runCompactionCheck(h.ctx, { force: true })

		expect(summaryOf(h.ctx)).toContain(COMPACTION_HEADER)
	})
})
