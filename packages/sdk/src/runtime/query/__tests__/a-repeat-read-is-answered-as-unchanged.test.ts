import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Message } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * The executor tells a tool what the model is shown, so a repeat read of an
 * unchanged file can say "unchanged" only while the earlier receipt is there.
 */

function respond(name: string, args: Record<string, unknown>): ChatCompletionResponse {
	return respondMany([[name, args]])
}

function respondMany(
	calls: readonly (readonly [string, Record<string, unknown>])[],
): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: calls.map(([name, args], i) => ({
				id: `call_${i + 1}`,
				type: 'function' as const,
				function: { name, arguments: JSON.stringify(args) },
			})),
		},
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

function setup(dir: string) {
	const turnId = generateTurnId()
	const tools = new ToolManager({
		toolsets: [testToolset(ReadFileTool)],
		messages: () => [],
	})
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	const log = { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
	return new ToolExecutor(
		{
			tools,
			turnId,
			sessionId: generateSessionId(),
			workingDirectory: dir,
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			fileReadTracker: createFileReadTracker(),
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		log,
	)
}

describe('a repeat read through the executor', () => {
	it('is answered as unchanged while the first receipt is in the conversation, and not after it is replaced', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-unchanged-executor-'))
		const file = join(dir, 'a.ts')
		writeFileSync(file, 'export const a = 1\n')
		const executor = setup(dir)
		const history: Message[] = []
		executor.setHistoryView(() => history)
		const call = respond('read', { path: file })

		const first = await executor.executeBatch(call)
		history.push(...first.messages)
		const second = await executor.executeBatch(call)
		expect(first.results[0]?.output).toContain('export const a = 1')
		expect(second.results[0]?.output).toMatch(/^Unchanged since your earlier read/)

		// The first receipt is cleared out of the conversation.
		history.splice(0, history.length, {
			...(first.messages[0] as Message),
			content: '[cleared]',
		} as Message)
		const third = await executor.executeBatch(call)
		expect(third.results[0]?.output).toContain('export const a = 1')
	})

	it('reads the lines again when the executor was given no view of the conversation', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-unchanged-executor-'))
		const file = join(dir, 'a.ts')
		writeFileSync(file, 'export const a = 1\n')
		const executor = setup(dir)
		const call = respond('read', { path: file })

		await executor.executeBatch(call)
		const again = await executor.executeBatch(call)

		expect(again.results[0]?.output).toContain('export const a = 1')
	})
})
