import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { buildEvidenceQueryInput, validateEvidenceQueryResolution } from '../evidence-query.js'
import {
	type EvidenceRecallCandidate,
	type EvidenceRecallRequest,
	createEvidenceRecallStep,
} from '../evidence-recall.js'

const history = [
	{ position: 0, role: 'user', text: 'Inspect DELTA tracking code.', truncated: false },
]
const current = 'Recall the earlier SIGMA tracking code.'
const scope = {
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
}
function plan(query = current, focus = ['SIGMA']) {
	const input = buildEvidenceQueryInput(query, history)
	if (!input) throw new Error('Test input did not fit')
	const id = (word: string) => {
		const index = input.tokens.indexOf(word)
		if (index < 0) throw new Error(`Test word not offered: ${word}`)
		return index
	}
	return {
		mode: 'direct',
		time: 'past',
		termIds: [...focus, 'tracking', 'code'].map(id),
		focusIds: focus.map(id),
		basis: [],
	}
}
function context(query = current, raw = plan(query)): PrepareStepContext {
	const latestUserMessage = createUserMessage(query)
	return {
		runId: generateRunId(),
		stepNumber: 1,
		steps: [],
		prepared: { context: 'Earlier host context.' },
		messages: [createUserMessage(history[0]!.text), latestUserMessage],
		latestUserMessage,
		generateText: vi.fn(async () => ({
			text: JSON.stringify(raw),
			usage: {
				promptTokens: 10,
				completionTokens: 10,
				totalTokens: 20,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			servedBy: { providerId: 'fixture', model: 'fixture', chainIndex: 0 },
		})),
	}
}
function candidate(excerpt: string): EvidenceRecallCandidate {
	return {
		scope: { ...scope, runId: generateRunId() },
		seq: 2,
		part: 0,
		source: 'tool_completed',
		retained: 'full',
		excerpt,
	}
}
function metadata(value: string | undefined) {
	const line = value?.split('\n').find((line) => line.startsWith('{"incomplete":'))
	if (!line) throw new Error('Missing recall metadata')
	return JSON.parse(line)
}

describe('grounded query focus', () => {
	it('does not let a mutating JavaScript retriever alter cached focus or its diagnostic', async () => {
		const received: string[][] = []
		const retrieve = async (request: EvidenceRecallRequest) => {
			received.push([...request.terms])
			;(request.terms as string[]).push('DELTA')
			return {
				candidates: [candidate('DELTA tracking code: WRONG')],
				scannedBytes: 128,
				incomplete: false,
			}
		}
		const ctx = context()
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })
		for (const stepNumber of [1, 2]) {
			const result = await recall({ ...ctx, stepNumber })
			expect(metadata(result?.context).queryFocus.terms).toEqual(['SIGMA'])
			expect(result?.context).not.toContain('WRONG')
		}
		expect(received).toEqual([['SIGMA'], ['SIGMA']])
		expect(ctx.generateText).toHaveBeenCalledOnce()
	})
	it('resolves a named direct subject from current words without importing the old subject', () => {
		expect(validateEvidenceQueryResolution(JSON.stringify(plan()), current, history)).toEqual({
			terms: ['SIGMA', 'tracking', 'code'],
			focusTerms: ['SIGMA'],
			time: 'past',
			basis: [],
		})
		const oldSubject = plan(current, ['DELTA'])
		expect(() =>
			validateEvidenceQueryResolution(JSON.stringify(oldSubject), current, history),
		).toThrow('ungrounded token')
	})
	it('requires focus IDs to belong to the selected grounded terms', () => {
		const raw = plan()
		raw.termIds = raw.termIds.slice(1)
		expect(() => validateEvidenceQueryResolution(JSON.stringify(raw), current, history)).toThrow(
			'subset',
		)
	})
	it('still requires exact quotes for contextual focus', () => {
		const query = 'What was its tracking code?'
		const raw = {
			...plan(query, ['DELTA']),
			mode: 'contextual',
			basis: [{ message: 0, quote: history[0]!.text }],
		}
		expect(validateEvidenceQueryResolution(JSON.stringify(raw), query, history)).toMatchObject({
			focusTerms: ['DELTA'],
		})
		expect(() =>
			validateEvidenceQueryResolution(
				JSON.stringify({ ...raw, basis: [{ message: 0, quote: 'DELTA invented fact' }] }),
				query,
				history,
			),
		).toThrow('outside')
	})
	it('does not use focus to revive ambiguous, no-search or present-state plans', () => {
		for (const mode of ['ambiguous', 'none'])
			expect(() =>
				validateEvidenceQueryResolution(JSON.stringify({ ...plan(), mode }), current, history),
			).toThrow()
		expect(
			validateEvidenceQueryResolution(
				JSON.stringify({ ...plan(), time: 'present' }),
				current,
				history,
			),
		).toBeUndefined()
	})
	it('narrows discovery and discards off-subject custom-host matches after validation', async () => {
		const original = 'SIGMA tracking code: A17'
		const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
			candidates: [candidate('DELTA tracking code: WRONG'), candidate(original)],
			scannedBytes: 512,
			incomplete: false,
		}))
		const ctx = context()
		const before = structuredClone(ctx.messages)
		const result = await createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })(ctx)
		expect(retrieve.mock.calls[0]?.[0].terms).toEqual(['SIGMA'])
		expect(result?.context).toContain(original)
		expect(result?.context).not.toContain('WRONG')
		expect(result?.context).toContain('Earlier host context.')
		expect(metadata(result?.context).queryFocus).toEqual({
			terms: ['SIGMA'],
			matchedTerms: ['SIGMA'],
			excludedPassages: 1,
		})
		expect(ctx.messages).toEqual(before)
	})
	it.each([false, true])(
		'reports an empty focused scan without claiming absence (incomplete=%s)',
		async (incomplete) => {
			const retrieve = async () => ({
				candidates: [],
				scannedBytes: 128,
				incomplete,
				...(incomplete
					? {
							continuations: [
								{ toolName: 'search_conversation', input: { cursor: 'host-cursor' } },
							],
						}
					: {}),
			})
			const result = await createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })(
				context(),
			)
			expect(metadata(result?.context)).toMatchObject({
				incomplete,
				queryFocus: { terms: ['SIGMA'], matchedTerms: [] },
			})
			expect(result?.context).toContain('do not prove the requested record is absent')
			expect(result?.context).not.toContain('"excerpt":')
			if (incomplete) expect(result?.context).toContain('host-cursor')
		},
	)
	it('matches any focus word, preserves preview status and does not match substrings', async () => {
		const query = 'SIGMA OMEGA tracking code'
		const retrieve = async () => ({
			candidates: [
				candidate('PRESIGMA WRONG'),
				{ ...candidate('omega A17'), retained: 'preview' as const },
			],
			scannedBytes: 128,
			incomplete: true,
		})
		const result = await createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })(
			context(query, plan(query, ['SIGMA', 'OMEGA'])),
		)
		expect(result?.context).toContain('omega A17')
		expect(result?.context).toContain('"retained":"preview"')
		expect(result?.context).not.toContain('WRONG')
		expect(metadata(result?.context).queryFocus.matchedTerms).toEqual(['OMEGA'])
	})
	it('rejects a foreign off-subject candidate before excluding it', async () => {
		const foreign = candidate('DELTA wrong owner')
		const retrieve = async () => ({
			candidates: [{ ...foreign, scope: { ...foreign.scope, sessionId: generateSessionId() } }],
			scannedBytes: 10,
			incomplete: false,
		})
		await expect(
			createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })(context()),
		).rejects.toThrow('different conversation scope')
	})
	it('drops oversized focus metadata and does no work after cancellation', async () => {
		const retrieve = vi.fn(async () => ({ candidates: [], scannedBytes: 10, incomplete: false }))
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true, maxChars: 1300 })
		expect(await recall(context())).toBeUndefined()
		const caller = new AbortController()
		caller.abort(new Error('cancelled focus'))
		retrieve.mockClear()
		await expect(recall({ ...context(), signal: caller.signal })).rejects.toThrow('cancelled focus')
		expect(retrieve).not.toHaveBeenCalled()
	})
})
