/**
 * Every tool result the executor writes says how its call ended when the call
 * did not simply run: interrupted, rejected by the person, blocked by
 * permissions, blocked by auto mode, or held back because auto mode could not
 * check it. The field is written where the result is made, from who refused
 * the call, and the auto mode's classifier reads it back as one word per
 * earlier call, so a call tried again after a refusal is seen as a second try.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ToolCallDeclined } from '../../../types/hitl/index.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import {
	autoReviewBlockedFeedback,
	autoReviewUnavailableFeedback,
} from '../auto-review/feedback.js'
import { projectTranscript } from '../auto-review/transcript.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../declined.js'
import { ToolExecutor, denialOutcome } from '../executor.js'

const logger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

const work = defineTool({
	name: 'work',
	description: 'Does some work, or fails when asked to.',
	inputSchema: z.object({ fail: z.boolean().optional() }),
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,
	execute: async (input) =>
		input.fail === true
			? { success: false, output: '', error: 'it broke' }
			: { success: true, output: 'done' },
})

function response(args: Record<string, unknown> = {}): ChatCompletionResponse {
	return {
		id: 'outcome-response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'work', arguments: JSON.stringify(args) },
				},
			],
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

function executor(signal: AbortSignal = new AbortController().signal) {
	const turnId = generateTurnId()
	return new ToolExecutor(
		{
			tools: new ToolManager({ toolsets: [testToolset(work)], messages: () => [] }),
			turnId,
			sessionId: generateSessionId(),
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: signal,
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async () => {},
		logger(),
	)
}

async function resultOf(
	options: {
		readonly args?: Record<string, unknown>
		readonly denial?: string
		readonly declined?: ToolCallDeclined
		readonly signal?: AbortSignal
	} = {},
): Promise<ToolMessage> {
	const batch = await executor(options.signal).executeBatch(
		response(options.args),
		options.denial !== undefined ? new Map([['call_1', options.denial]]) : undefined,
		undefined,
		undefined,
		options.declined !== undefined ? new Map([['call_1', options.declined]]) : undefined,
	)
	return batch.messages[0] as ToolMessage
}

describe('a tool result says how its call ended', () => {
	it('says nothing more for a call that ran, whether it worked or failed', async () => {
		const ok = await resultOf()
		expect(ok.isError).toBe(false)
		expect(ok).not.toHaveProperty('outcome')
		const failed = await resultOf({ args: { fail: true } })
		expect(failed.isError).toBe(true)
		expect(failed).not.toHaveProperty('outcome')
	})

	it('marks a person’s no as rejected', async () => {
		expect(
			await resultOf({ denial: DECLINED_TOOL_CALL_FEEDBACK, declined: { note: 'not now' } }),
		).toMatchObject({ isError: true, outcome: 'rejected' })
	})

	it('marks an auto mode block apart from a call held back for want of a verdict', async () => {
		expect(
			await resultOf({ denial: autoReviewBlockedFeedback('it deletes the data') }),
		).toMatchObject({ outcome: 'blocked_by_auto_mode' })
		expect(
			await resultOf({ denial: autoReviewUnavailableFeedback('the check could not be completed') }),
		).toMatchObject({ outcome: 'auto_mode_unavailable' })
	})

	it('marks any other refusal as blocked by permissions', async () => {
		expect(await resultOf({ denial: 'Refused: strict mode does not run edits.' })).toMatchObject({
			outcome: 'blocked_by_permissions',
		})
	})

	it('marks a call the cancelled turn never started as interrupted', async () => {
		const stopped = new AbortController()
		stopped.abort(new Error('the user pressed Esc'))
		expect(await resultOf({ signal: stopped.signal })).toMatchObject({
			isError: true,
			outcome: 'interrupted',
		})
	})

	it('reads the turn-stopped refusal of a batch-mate as interrupted', () => {
		expect(
			denialOutcome(
				'An earlier call in this batch was refused and the turn was stopped, so this call was not run. Wait for the user.',
				undefined,
			),
		).toBe('interrupted')
		// Who refused outranks what the words say.
		expect(denialOutcome(autoReviewBlockedFeedback('x'), {})).toBe('rejected')
	})

	it('is what the classifier is shown for the call, in words', async () => {
		const rejected = await resultOf({ denial: DECLINED_TOOL_CALL_FEEDBACK, declined: {} })
		const call = response().message
		const entries = projectTranscript([call as Message, rejected])
		expect(entries).toEqual([
			{ kind: 'tool', name: 'work', input: '{}', outcome: 'rejected by the person' },
		])
	})
})
