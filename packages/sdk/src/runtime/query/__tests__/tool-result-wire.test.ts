import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolRegistryContract, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * The seam between what a tool RETURNS and what reaches the provider.
 *
 * Both halves of the content-block migration were landing here and neither
 * was covered: the executor's local `result` was typed as a narrowed
 * literal that silently dropped `content`, and its final return omitted
 * `isError` entirely. So a tool could return an image block and a failure
 * flag, the wire mappers were built to carry both, and neither ever
 * arrived — the mapper tests passed because they set the fields by hand.
 */

const RUN_ID = 'run_wire' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function response(name: string): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'call_1', type: 'function', function: { name, arguments: '{}' } }],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function executorReturning(result: ToolResult, maxToolOutputChars?: number): ToolExecutor {
	const tools = {
		get: vi.fn(() => ({
			name: 'tool',
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

	return new ToolExecutor(
		{
			tools,
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...(maxToolOutputChars !== undefined ? { maxToolOutputChars } : {}),
		},
		new ActivityStore(RUN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		makeLogger(),
	)
}

describe('a failed tool is marked as failed on the message', () => {
	it('sets isError on the tool message', async () => {
		const exec = executorReturning({ success: false, output: '', error: 'no such file' })
		const batch = await exec.executeBatch(response('read'))

		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.messages[0]).toMatchObject({ role: 'tool', isError: true })
	})

	it('leaves isError false on success', async () => {
		const exec = executorReturning({ success: true, output: 'fine' })
		const batch = await exec.executeBatch(response('read'))

		expect(batch.results[0]?.isError).toBe(false)
		expect(batch.messages[0]).toMatchObject({ isError: false })
	})
})

describe('rich tool content reaches the message', () => {
	const IMAGE: ToolResult = {
		success: true,
		output: 'Screenshot captured (1920x1080, image/png).',
		content: [
			{ type: 'text', text: 'Screenshot captured.' },
			{ type: 'image', data: 'AAAA', mediaType: 'image/png' },
		],
	}

	it('puts the blocks on the message, not the text summary', async () => {
		const exec = executorReturning(IMAGE)
		const batch = await exec.executeBatch(response('computer_use'))

		const content = batch.messages[0]?.content
		expect(Array.isArray(content)).toBe(true)
		expect(content).toEqual(IMAGE.content)
	})

	it('still reports the text form on the result, for the transcript', async () => {
		const exec = executorReturning(IMAGE)
		const batch = await exec.executeBatch(response('computer_use'))
		expect(batch.results[0]?.output).toContain('1920x1080')
	})

	it('falls back to the string when the tool returned no blocks', async () => {
		const exec = executorReturning({ success: true, output: 'plain text' })
		const batch = await exec.executeBatch(response('read'))
		expect(batch.messages[0]?.content).toBe('plain text')
	})

	it('drops rich content when the output was spilled — the preview is not the payload', async () => {
		const exec = executorReturning(
			{ success: true, output: 'x'.repeat(5_000), content: [{ type: 'text', text: 'x' }] },
			200,
		)
		const batch = await exec.executeBatch(response('read'))

		// The model must see the budgeted preview, not a block array that
		// still carries the full payload.
		expect(typeof batch.messages[0]?.content).toBe('string')
		expect(String(batch.messages[0]?.content)).toContain('characters omitted')
	})
})
