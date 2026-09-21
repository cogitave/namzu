import { expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateTurnId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import {
	type EvidenceRecallBatch,
	type EvidenceRecallRequest,
	createEvidenceRecallStep,
} from '../evidence-recall.js'
import { PreparationContextError } from '../preparation-context-error.js'

function fixture(maxChars = 6000) {
	const scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
	}
	const operator = createUserMessage('What was the DELTA code?')
	const generateText = vi
		.fn<NonNullable<PrepareStepContext['generateText']>>()
		.mockRejectedValue(new Error('PRIVATE_INVALID_PLAN'))
	const context: PrepareStepContext = {
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
		candidates: [
			{
				scope: { ...scope, runId: generateTurnId() },
				seq: 2,
				part: 0,
				source: 'tool_completed',
				retained: 'full',
				excerpt: 'DELTA code: ORIGINAL-123',
			},
		],
		scannedBytes: 100,
		incomplete: false,
	}
	const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => batch)
	const recall = createEvidenceRecallStep({ scope, resolveQuery: true, maxChars, retrieve })
	return { scope, context, batch, retrieve, generateText, recall }
}

async function failure(operation: unknown): Promise<PreparationContextError> {
	try {
		await operation
	} catch (error) {
		expect(error).toBeInstanceOf(PreparationContextError)
		return error as PreparationContextError
	}
	throw new Error('Expected the planning failure to remain diagnostic.')
}

it('preserves literal discovery after failed optional planning without importing prior subject words', async () => {
	const f = fixture()
	const before = structuredClone(f.context.messages)
	const error = await failure(f.recall(f.context))
	expect(f.retrieve).toHaveBeenCalledOnce()
	expect(f.retrieve.mock.calls[0]![0].terms).toEqual(['DELTA', 'code'])
	expect(error.context).toContain('ORIGINAL-123')
	expect(error.context).toContain('"stage":"query_planning"')
	expect(error.context).toContain('"fallback":"literal_query"')
	expect(error.context).not.toContain('PRIVATE_INVALID_PLAN')
	expect(error.context).not.toContain('OMEGA')
	expect(error.context).not.toContain('This automatic pass supplied no evidence')
	expect(error.context.length).toBeLessThanOrEqual(6000)
	expect(f.context.messages).toEqual(before)
})

it('caches only the failed plan and revalidates fallback evidence on the next step', async () => {
	const f = fixture()
	await failure(f.recall(f.context))
	f.retrieve.mockResolvedValueOnce({
		...f.batch,
		candidates: [{ ...f.batch.candidates[0]!, excerpt: 'DELTA code: REVISED-456' }],
	})
	const next = await failure(f.recall({ ...f.context, stepNumber: 2 }))
	expect(next.context).toContain('REVISED-456')
	expect(next.context).not.toContain('ORIGINAL-123')
	expect(f.generateText).toHaveBeenCalledOnce()
	expect(f.retrieve).toHaveBeenCalledTimes(2)
})

it('keeps empty fallback scan coverage distinct from a planning failure', async () => {
	const f = fixture()
	f.retrieve.mockResolvedValue({ candidates: [], scannedBytes: 100, incomplete: false })
	const error = await failure(f.recall(f.context))
	expect(error.context).toContain('"fallback":"literal_query"')
	expect(error.context).toContain('"incomplete":false')
	expect(error.context).toContain('"scannedBytes":100')
})

it('retains explicit continuation from partial literal fallback', async () => {
	const f = fixture()
	f.retrieve.mockResolvedValue({
		...f.batch,
		incomplete: true,
		continuations: [{ toolName: 'history_search', input: { cursor: 'owned-cursor' } }],
	})
	const error = await failure(f.recall(f.context))
	expect(error.context).toContain('owned-cursor')
	expect(error.context).toContain('"incomplete":true')
})

it('rejects a foreign fallback candidate before exposing any text', async () => {
	const f = fixture()
	f.retrieve.mockResolvedValue({
		...f.batch,
		candidates: [
			...f.batch.candidates,
			{
				...f.batch.candidates[0]!,
				scope: { ...f.batch.candidates[0]!.scope, sessionId: generateSessionId() },
				excerpt: 'DELTA FOREIGN_SECRET',
			},
		],
	})
	const error = await failure(f.recall(f.context))
	expect(error.context).toContain('"stage":"retrieval"')
	expect(error.context).not.toContain('ORIGINAL-123')
	expect(error.context).not.toContain('FOREIGN_SECRET')
})

it('does not start fallback after parent cancellation during planning', async () => {
	const f = fixture()
	const controller = new AbortController()
	f.generateText.mockImplementation(async () => {
		controller.abort(new Error('Operator stopped'))
		throw new Error('PRIVATE_INVALID_PLAN')
	})
	await expect(f.recall({ ...f.context, signal: controller.signal })).rejects.toThrow(
		'Operator stopped',
	)
	expect(f.retrieve).not.toHaveBeenCalled()
})

it('reports failed fallback retrieval without exposing its cause or claiming a literal result', async () => {
	const f = fixture()
	f.retrieve.mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'))
	const error = await failure(f.recall(f.context))
	expect(f.retrieve).toHaveBeenCalledOnce()
	expect(error.context).toContain('"stage":"retrieval"')
	expect(error.context).not.toContain('PRIVATE_STORAGE_FAILURE')
	expect(error.context).not.toContain('PRIVATE_INVALID_PLAN')
	expect(error.context).not.toContain('ORIGINAL-123')
})

it('reserves the availability note within the same character allowance', async () => {
	const f = fixture(1800)
	f.retrieve.mockResolvedValue({
		...f.batch,
		candidates: Array.from({ length: 8 }, (_, i) => ({
			...f.batch.candidates[0]!,
			seq: i + 2,
			excerpt: `DELTA code ${i} ${'<'.repeat(200)}`,
		})),
	})
	const error = await failure(f.recall(f.context))
	expect(f.retrieve).toHaveBeenCalledOnce()
	expect(error.context).toContain('"fallback":"literal_query"')
	expect(error.context.length).toBeLessThanOrEqual(1800)
})

it('does not fetch when there is no room for status and bounded evidence framing', async () => {
	const f = fixture(1100)
	const error = await failure(f.recall(f.context))
	expect(error.context).toContain('"stage":"query_planning"')
	expect(error.context).not.toContain('"fallback":"literal_query"')
	expect(f.retrieve).not.toHaveBeenCalled()
	expect(error.context.length).toBeLessThanOrEqual(1100)
})
