import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { EditTool, WriteFileTool } from '../../../tools/builtins/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolCall, ToolInputError } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RepairToolCall } from '../../../types/tool/repair.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor, type ToolExecutorConfig } from '../executor.js'
import { unreadableToolInputMessage } from '../executor/tool-call-admission.js'

/**
 * The message for a call whose arguments could not be read was one fixed
 * string: "cut off while the model was streaming JSON arguments … Retry with
 * a much shorter input", then a 12000-character budget for `content` and
 * `new_string` and a recipe for writing long files. A question tool whose
 * JSON was malformed got all of it — advice about file tools, for a failure
 * that was not a cut-off, under a question.
 */

const SESSION_ID = '9d3c4b2a-1e0f-4a8b-9c7d-6e5f4a3b2c1d' as SessionId
const TURN_ID = '62bc1c2f-2254-48d5-b3df-572ccb1102e0' as TurnId

/** A call cut off after `length` characters, with `precedingLength` streamed before it. */
const cutOff = (
	length: number,
	finishReason?: ToolInputError['finishReason'],
	precedingLength = 0,
): ToolInputError => ({
	reason: 'truncated',
	...(finishReason ? { finishReason } : {}),
	parseError: 'Unterminated string in JSON at position 30 (line 1 column 31)',
	offset: length,
	length,
	precedingLength,
})

const malformed: ToolInputError = {
	reason: 'malformed',
	finishReason: 'tool_calls',
	parseError: "Expected ',' or ']' after array element in JSON at position 40 (line 1 column 41)",
	offset: 40,
	length: 45,
	precedingLength: 0,
}

const FILE_ADVICE = /12000|content|new_string|write|marker|edit/i

describe('unreadableToolInputMessage', () => {
	it('tells a tool with no large inputs what happened, and nothing about files', () => {
		const message = unreadableToolInputMessage('ask_user_question', cutOff(900, 'length', 29_100))

		expect(message).toBe(
			'Error: The call to "ask_user_question" was cut off: the response reached its output token limit after 900 characters of its arguments, before they were complete. The tool was NOT executed. 29100 of the response\'s 30000 characters came before this call, so send the call again with less before it in the same response.',
		)
		expect(message).not.toMatch(FILE_ADVICE)
	})

	it('tells a tool that declares nothing to carry less when its own arguments filled the response', () => {
		// A long `bash` heredoc, a `run_code` body or an MCP tool's input: the
		// arguments were what ran out, and blaming the text before them sent
		// the same input back into the same cutoff.
		const message = unreadableToolInputMessage('bash', cutOff(30_000, 'length', 1_000))

		expect(message).toBe(
			'Error: The call to "bash" was cut off: the response reached its output token limit after 30000 characters of its arguments, before they were complete. The tool was NOT executed. Send it again with less in one call: keep its arguments under 15000 characters in all.',
		)
	})

	it('blames what came before the call only when that was most of the response', () => {
		const tool = {
			largeStringArguments: { content: 12_000 },
			truncatedInputHint: 'Write a long file in parts.',
		}
		const before = unreadableToolInputMessage('write', cutOff(40, 'length', 59_960), tool)
		expect(before).toContain("59960 of the response's 60000 characters came before this call")
		// Nothing about the call's own size: 40 characters of it did not fill
		// the response, and a budget cut to half of them would be nonsense.
		expect(before).not.toMatch(/under \d+ characters|in parts/)

		const itself = unreadableToolInputMessage('write', cutOff(30_000, 'length', 30_000), tool)
		expect(itself).toContain('keep `content` under 12000 characters.')
		expect(itself).toMatch(/ Write a long file in parts\.$/)
	})

	it('names the JSON error for malformed arguments, and never calls them cut off', () => {
		const message = unreadableToolInputMessage('ask_user_question', malformed)

		expect(message).toBe(
			`Error: The arguments for "ask_user_question" were not valid JSON (${malformed.parseError}; 45 characters in all). The tool was NOT executed. Send the call again with its arguments as one valid JSON object.`,
		)
		expect(message).not.toMatch(/cut off|shorter|less/i)
	})

	it('gives no size advice for malformed arguments, even to a tool with large inputs', () => {
		const message = unreadableToolInputMessage('write', malformed, {
			largeStringArguments: { content: 12_000 },
		})
		expect(message).not.toMatch(/under \d+ characters/)
	})

	it('names the character where parsing stopped when the parser did not', () => {
		const message = unreadableToolInputMessage('ask', {
			reason: 'malformed',
			finishReason: 'stop',
			parseError: 'Unexpected end of JSON input',
			offset: 12,
			length: 12,
			precedingLength: 0,
		})
		expect(message).toContain(
			'(Unexpected end of JSON input at character 12; 12 characters in all)',
		)
	})

	it('budgets exactly the arguments a tool declares large', () => {
		const message = unreadableToolInputMessage('edit', cutOff(40_000, 'length'), {
			largeStringArguments: { old_string: 12_000, new_string: 12_000 },
		})
		expect(message).toContain(
			'Send it again with less in one call: keep `old_string` under 12000 characters and `new_string` under 12000 characters.',
		)
	})

	it('lowers the budget below what the response could hold', () => {
		const message = unreadableToolInputMessage('write', cutOff(5_000, 'length'), {
			largeStringArguments: { content: 12_000 },
		})
		expect(message).toContain('keep `content` under 2500 characters')
	})

	it("appends the tool's hint for the reason the call failed, and only that one", () => {
		const tool = {
			truncatedInputHint: 'Write a long note as several notes.',
			malformedInputHint: 'Pass "tags" as a JSON array of strings.',
		}
		const malformedMessage = unreadableToolInputMessage('note', malformed, tool)
		expect(malformedMessage).toMatch(/ Pass "tags" as a JSON array of strings\.$/)
		expect(malformedMessage).not.toContain('several notes')

		const cutOffMessage = unreadableToolInputMessage('note', cutOff(10, 'length'), tool)
		expect(cutOffMessage).toMatch(/ Write a long note as several notes\.$/)
		expect(cutOffMessage).not.toContain('JSON array')

		const droppedMessage = unreadableToolInputMessage('note', cutOff(10), tool)
		expect(droppedMessage).toMatch(/ Write a long note as several notes\.$/)
	})

	it('gives a content-filtered or unexplained call neither hint', () => {
		const tool = { truncatedInputHint: 'Send less.', malformedInputHint: 'Fix the JSON.' }
		for (const error of [cutOff(10, 'content_filter'), undefined]) {
			const message = unreadableToolInputMessage('note', error, tool)
			expect(message).not.toContain('Send less.')
			expect(message).not.toContain('Fix the JSON.')
		}
	})

	it('says a content filter stopped the call, with no advice to send less', () => {
		const message = unreadableToolInputMessage('write', cutOff(300, 'content_filter'), {
			largeStringArguments: { content: 12_000 },
		})
		expect(message).toContain("the provider's content filter stopped the response")
		expect(message).not.toMatch(/Send|under \d+/)
	})

	it('says the stream ended when it reported no finish reason', () => {
		const message = unreadableToolInputMessage('ask', cutOff(300))
		expect(message).toContain('the response stream ended after 300 characters')
		expect(message).toMatch(/Send the call again\.$/)
	})

	it('answers a call an older runtime marked, with no reason recorded, without guessing one', () => {
		const message = unreadableToolInputMessage('ask', undefined)
		expect(message).toBe(
			'Error: The arguments for "ask" could not be read as JSON. The tool was NOT executed. Send the call again with complete, valid JSON arguments.',
		)
	})
})

describe('the built-in tools declare what they need', () => {
	it('write and edit declare their large text and advice for a cut-off call', () => {
		expect(WriteFileTool.largeStringArguments).toEqual({ content: 12_000 })
		expect(WriteFileTool.truncatedInputHint).toMatch(/edit/)
		expect(EditTool.largeStringArguments).toEqual({ old_string: 12_000, new_string: 12_000 })
		expect(EditTool.truncatedInputHint).toBeTruthy()
	})

	it('a malformed write or edit, or one a content filter stopped, gets no advice about size or files', () => {
		// The size and file-splitting advice these tools carry answered every
		// unreadable call, which does nothing for malformed JSON or a filter.
		for (const tool of [WriteFileTool, EditTool]) {
			for (const error of [malformed, cutOff(300, 'content_filter')]) {
				const message = unreadableToolInputMessage(tool.name, error, tool)
				expect(message).not.toMatch(/marker|several edit|under \d+ characters|split/i)
			}
		}
	})
})

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeExecutor(registry: ToolRegistry, extra: Partial<ToolExecutorConfig> = {}) {
	return new ToolExecutor(
		{
			tools: registry,
			turnId: TURN_ID,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			sessionId: SESSION_ID,
			...extra,
		},
		new ActivityStore(TURN_ID, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		() => Promise.resolve(),
		makeLogger(),
	)
}

function unreadable(name: string, error: ToolInputError, partial: string): ChatCompletionResponse {
	const call: ToolCall = {
		id: 'call_1',
		type: 'function',
		function: { name, arguments: '{}' },
		metadata: { inputTruncated: true, partialArguments: partial, inputError: error },
	}
	return {
		id: 'resp_1',
		model: 'mock',
		message: { role: 'assistant', content: null, toolCalls: [call] },
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

describe('the executor answers an unreadable call from its reason and its tool', () => {
	const question = defineTool({
		name: 'ask_user_question',
		description: 'Ask the user',
		inputSchema: z.object({ question: z.string(), options: z.array(z.string()) }),
		malformedInputHint: 'Pass "options" as a JSON array of strings.',
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: false,
		async execute() {
			return { success: true, output: 'asked' }
		},
	})

	it('does not give a malformed question file-tool advice', async () => {
		const registry = new ToolRegistry()
		registry.register(question)
		const batch = await makeExecutor(registry).executeBatch(
			unreadable('ask_user_question', malformed, '{"question":"Which one?","options":["a" "b"]}'),
		)

		const output = batch.results[0]?.output ?? ''
		expect(batch.results[0]?.isError).toBe(true)
		expect(output).toContain('were not valid JSON')
		expect(output).toContain('Pass "options" as a JSON array of strings.')
		expect(output).not.toMatch(FILE_ADVICE)
	})

	it('budgets a cut-off write by its own declaration', async () => {
		const registry = new ToolRegistry()
		registry.register(WriteFileTool)
		const batch = await makeExecutor(registry).executeBatch(
			unreadable('write', cutOff(60_000, 'length'), '{"path":"a.md","content":"long'),
		)

		const output = batch.results[0]?.output ?? ''
		expect(output).toContain('was cut off: the response reached its output token limit')
		expect(output).toContain('keep `content` under 12000 characters')
		expect(output).toContain(WriteFileTool.truncatedInputHint)
	})

	it('offers a repairer the same message it would have sent the model', async () => {
		const registry = new ToolRegistry()
		registry.register(question)
		const seen = vi.fn<RepairToolCall>(() => null)
		await makeExecutor(registry, { repairToolCall: seen }).executeBatch(
			unreadable('ask_user_question', malformed, '{"question":"Which one?","options":["a" "b"]}'),
		)

		expect(seen).toHaveBeenCalledOnce()
		const ctx = seen.mock.calls[0]?.[0]
		expect(ctx?.reason).toBe('invalid_json')
		expect(ctx?.toolCall.function.arguments).toBe('{"question":"Which one?","options":["a" "b"]}')
		expect(ctx?.message).toContain('were not valid JSON')
	})
})
