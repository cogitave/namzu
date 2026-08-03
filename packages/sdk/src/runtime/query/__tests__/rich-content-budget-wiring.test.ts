import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolRegistryContract, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolingBootstrap } from '../tooling.js'

/**
 * The rich-content budget was declared on the executor's own config and read
 * in exactly one place — and no caller could set it. `ToolingBootstrapConfig`
 * had no such field, so the value the executor read was always `undefined`,
 * the cap was always `0`, and the capping branch plus its warn were
 * unreachable. A knob documented as "a host that knows its payloads sets it"
 * could not be set by any host.
 *
 * This covers the chain, not the capping: the capping is already tested
 * against an executor built by hand, which is precisely how the gap survived.
 */

const RUN_ID = 'run_budget' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shot', arguments: '{}' } }],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function bootstrapReturning(result: ToolResult, maxToolContentBytes?: number) {
	const tools = {
		get: vi.fn(() => ({
			name: 'shot',
			isConcurrencySafe: () => true,
			isReadOnly: () => true,
			isDestructive: () => false,
		})),
		execute: vi.fn(async () => result),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	return ToolingBootstrap.init(
		{
			tools,
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...(maxToolContentBytes !== undefined ? { maxToolContentBytes } : {}),
		},
		new ActivityStore(RUN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		makeLogger(),
	)
}

/** An image block whose payload is comfortably over any cap set below. */
function oversizedImage(): ToolResult {
	return {
		success: true,
		output: 'captured',
		content: [
			{ type: 'text', text: 'captured' },
			{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(4096) },
		],
	} as unknown as ToolResult
}

describe('the rich-content budget is reachable from the bootstrap config', () => {
	it('withholds an over-budget image when a host sets the cap', async () => {
		const exec = bootstrapReturning(oversizedImage(), 512)
		const batch = await exec.executeBatch(response())

		const content = batch.messages[0]?.content
		expect(Array.isArray(content)).toBe(true)
		const blocks = content as ReadonlyArray<{ type: string; text?: string }>
		expect(blocks.some((b) => b.type === 'image')).toBe(false)
		expect(blocks[0]?.text).toContain('rich content withheld')
		// The message names both the measurement and the cap, so an operator
		// can tell "too big" from "cap set too low" without a repro.
		expect(blocks[0]?.text).toContain('512')
	})

	it('passes the same payload through untouched when no cap is set', async () => {
		const exec = bootstrapReturning(oversizedImage())
		const batch = await exec.executeBatch(response())

		const blocks = batch.messages[0]?.content as ReadonlyArray<{ type: string }>
		expect(blocks.some((b) => b.type === 'image')).toBe(true)
	})
})
