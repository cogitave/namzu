/**
 * A person who declines a call without words of their own declined the
 * outcome, not the tool. In a live session a refused browser navigation was
 * followed by a web search for the same page; the refusal the model reads
 * now says not to reach the same content another way without asking.
 */

import { describe, expect, it } from 'vitest'

import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { CheckpointId, TurnId } from '../../../types/ids/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../declined.js'
import { createReviewHandler } from '../review-policy.js'

const review = (): HITLDecisionRequest => ({
	sessionId: generateSessionId(),
	type: 'tool_review',
	turnId: 'f8223c92-2ebb-4961-8f5c-51dffd77693e' as TurnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as CheckpointId,
	toolCalls: [
		{
			id: 'call_1',
			name: 'browser',
			input: { action: 'navigate' },
			isDestructive: false,
		},
	],
})

describe('a declined call', () => {
	it('tells the model not to reach the same content another way without asking', () => {
		expect(DECLINED_TOOL_CALL_FEEDBACK).toMatch(/declined/)
		expect(DECLINED_TOOL_CALL_FEEDBACK).toMatch(/another tool/)
		expect(DECLINED_TOOL_CALL_FEEDBACK).toMatch(/web search/)
		expect(DECLINED_TOOL_CALL_FEEDBACK).toMatch(/ask the user first/)
	})

	it('is what a refusal without feedback carries', async () => {
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt: async () => ({ kind: 'reject' }),
		})
		await expect(handler(review())).resolves.toEqual({
			action: 'reject_tools',
			feedback: DECLINED_TOOL_CALL_FEEDBACK,
		})
	})

	it('leaves the person’s own words as they wrote them', async () => {
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt: async () => ({
				kind: 'reject',
				feedback: 'Use the API instead.',
			}),
		})
		await expect(handler(review())).resolves.toEqual({
			action: 'reject_tools',
			feedback: 'Use the API instead.',
		})
	})
})
