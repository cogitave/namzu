import { expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import {
	type EvidenceRecallBatch,
	type EvidenceRecallRequest,
	createEvidenceRecallStep,
} from '../evidence-recall.js'

/**
 * The history lookup asks a small model to plan the search. On a thinking model
 * the whole allowance can go to reasoning, so the answer is empty or cut off.
 * That says nothing about the question: the turn must go on with nothing added,
 * not with a note that evidence is unavailable.
 */
function fixture(reply: { text: string; finishReason?: 'stop' | 'length' }) {
	const scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
	}
	const operator = createUserMessage('What was the DELTA code?')
	const generateText = vi.fn<NonNullable<PrepareStepContext['generateText']>>().mockResolvedValue({
		...reply,
		usage: {
			promptTokens: 10,
			completionTokens: 512,
			totalTokens: 522,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		servedBy: { providerId: 'fake', model: 'fake', chainIndex: 0 },
	})
	const context: PrepareStepContext = {
		sessionId: scope.sessionId,
		turnId: generateTurnId(),
		stepNumber: 1,
		steps: [],
		prepared: {},
		latestUserMessage: operator,
		messages: [
			createUserMessage('Inspect OMEGA.'),
			createAssistantMessage('OMEGA was inspected.'),
			operator,
		],
		generateText,
	}
	const batch: EvidenceRecallBatch = {
		candidates: [],
		scannedBytes: 0,
		incomplete: false,
	}
	const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => batch)
	const recall = createEvidenceRecallStep({ scope, resolveQuery: true, maxChars: 6000, retrieve })
	return { context, generateText, retrieve, recall }
}

it('adds nothing when the planner ran out of tokens with nothing written', async () => {
	const f = fixture({ text: '', finishReason: 'length' })
	await expect(f.recall(f.context)).resolves.toBeUndefined()
	expect(f.generateText).toHaveBeenCalledTimes(1)
	expect(f.retrieve).not.toHaveBeenCalled()
})

it('adds nothing when the planner was cut off in the middle of its plan', async () => {
	const f = fixture({ text: '{"mode":"direct","time":"unspec', finishReason: 'length' })
	await expect(f.recall(f.context)).resolves.toBeUndefined()
	expect(f.retrieve).not.toHaveBeenCalled()
})

it('adds nothing when the planner stopped with an empty reply', async () => {
	const f = fixture({ text: '  ', finishReason: 'stop' })
	await expect(f.recall(f.context)).resolves.toBeUndefined()
	expect(f.retrieve).not.toHaveBeenCalled()
})

it('still reports a finished reply that is not a valid plan', async () => {
	const f = fixture({ text: 'not json', finishReason: 'stop' })
	await expect(f.recall(f.context)).rejects.toThrow()
})
