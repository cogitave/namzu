import { describe, expect, it } from 'vitest'

import { toolsHash } from '../../../connector/mcp/policy.js'
import type { MCPToolDefinition } from '../../../types/connector/index.js'
import { mergeTokenUsage } from '../index.js'

/**
 * Arithmetic defects, each pinned by the exact counterexample that proves it.
 * A test here is only worth having if it fails against the old formula, so
 * every one names the number the old code produced.
 */

describe('mergeTokenUsage — totalTokens is derived, not independent', () => {
	it('does not lose the completion tokens Anthropic reports in a later frame', () => {
		// A driver reports the input on `message_start` and the output on
		// `message_delta`. The driver derives each frame's own total as
		// input+output, so the two frames carry 1200 and 350 — and a max of
		// those returns the larger COMPONENT, not the sum.
		const messageStart = {
			promptTokens: 1200,
			completionTokens: 0,
			totalTokens: 1200,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const messageDelta = {
			promptTokens: 0,
			completionTokens: 350,
			totalTokens: 350,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}

		const merged = mergeTokenUsage(messageStart, messageDelta)

		expect(merged.promptTokens).toBe(1200)
		expect(merged.completionTokens).toBe(350)
		// Old formula: Math.max(1200, 350) = 1200. Every completion token was
		// invisible to the budget hard stop, which reads only totalTokens.
		expect(merged.totalTokens).toBe(1550)
	})

	it('holds for the minimal case too', () => {
		const a = {
			promptTokens: 1,
			completionTokens: 0,
			totalTokens: 1,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const b = {
			promptTokens: 0,
			completionTokens: 1,
			totalTokens: 1,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		expect(mergeTokenUsage(a, b).totalTokens).toBe(2)
	})

	it('never under-reports a provider total that exceeds prompt + completion', () => {
		// Some providers count tokens the two components do not cover. The
		// merge must be monotone: it may never return less than what was
		// reported.
		const reported = {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 99,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		const empty = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		expect(mergeTokenUsage(reported, empty).totalTokens).toBe(99)
	})

	it('is idempotent, so re-merging a frame cannot inflate the total', () => {
		const usage = {
			promptTokens: 1200,
			completionTokens: 350,
			totalTokens: 1550,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
		expect(mergeTokenUsage(usage, usage).totalTokens).toBe(1550)
		expect(mergeTokenUsage(mergeTokenUsage(usage, usage), usage).totalTokens).toBe(1550)
	})
})

describe('toolsHash — the fingerprint covers what the HITL gate reads', () => {
	const tool = (annotations?: Record<string, unknown>): MCPToolDefinition =>
		({
			name: 'delete_rows',
			description: 'Delete rows',
			inputSchema: { type: 'object', properties: {} },
			...(annotations ? { annotations } : {}),
		}) as MCPToolDefinition

	it('notices a server flipping destructive to read-only', () => {
		// `annotations` becomes `isDestructive` / `isReadOnly` on the tool
		// definition, and those drive whether a human reviews the call. A
		// fingerprint that ignores them cannot see the exact rug-pull it was
		// built to catch: same name, same schema, no longer reviewed.
		const before = toolsHash([tool({ destructiveHint: true, readOnlyHint: false })])
		const after = toolsHash([tool({ destructiveHint: false, readOnlyHint: true })])
		expect(after).not.toBe(before)
	})

	it('notices annotations appearing where there were none', () => {
		expect(toolsHash([tool()])).not.toBe(toolsHash([tool({ readOnlyHint: true })]))
	})

	it('is still stable for an unchanged tool', () => {
		expect(toolsHash([tool({ destructiveHint: true })])).toBe(
			toolsHash([tool({ destructiveHint: true })]),
		)
	})
})
