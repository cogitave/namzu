import { expect, it } from 'vitest'

import { generateCheckpointId, generateTurnId } from '../../../utils/id.js'
import {
	type ToolReviewAnswer,
	type ToolReviewRequest,
	createReviewHandler,
} from '../review-policy.js'

it('preserves each originating run when identical child reviews overlap', async () => {
	const seen: ToolReviewRequest[] = []
	const resolve: Array<(answer: ToolReviewAnswer) => void> = []
	const handler = createReviewHandler({
		prompt: (request) => {
			seen.push(request)
			return new Promise((done) => resolve.push(done))
		},
	})
	const turnIds = [generateTurnId(), generateTurnId()]
	const calls = [
		{
			id: 'same-call',
			name: 'bash',
			input: { command: 'echo ok' },
			isDestructive: false,
		},
	]
	const pending = turnIds.map((turnId) =>
		handler({
			type: 'tool_review',
			turnId,
			checkpointId: generateCheckpointId(),
			toolCalls: calls,
		}),
	)
	expect(seen.map((request) => request.turnId)).toEqual(turnIds)
	resolve[1]?.({ kind: 'reject', feedback: 'second only' })
	resolve[0]?.({ kind: 'approve' })
	expect(await Promise.all(pending)).toEqual([
		{ action: 'approve_tools' },
		{ action: 'reject_tools', feedback: 'second only' },
	])
})
