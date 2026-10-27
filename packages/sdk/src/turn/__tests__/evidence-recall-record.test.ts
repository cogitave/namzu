import { describe, expect, it, vi } from 'vitest'
import {
	type Message,
	createTurnContextEntry,
	createUserMessage,
	turnContextEntries,
} from '../../types/message/index.js'
import type { PrepareStepContext, PrepareStepResult } from '../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '../../utils/id.js'
import {
	type EvidenceRecallCandidate,
	type EvidenceRecallOptions,
	RECALLED_EVIDENCE_ENTRY_KEY,
	createEvidenceRecallStep,
} from '../evidence-recall.js'

/**
 * With `record`, recalled passages are kept in the conversation: a passage is
 * recorded once by address, the total the conversation holds is bounded, and
 * past the bound an entry only points. Notes about the search stay
 * request-only.
 */

const scope = {
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
}
const sourceRun = generateTurnId()
const candidate = (
	excerpt: string,
	seq: number,
	extra: Partial<EvidenceRecallCandidate> = {},
): EvidenceRecallCandidate => ({
	scope: { ...scope, turnId: sourceRun },
	seq,
	part: 0,
	source: 'tool_completed',
	toolName: 'read',
	retained: 'full',
	excerpt,
	byteOffset: 0,
	...extra,
})

function context(messages: Message[]): PrepareStepContext {
	return {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		stepNumber: 1,
		messages,
		steps: [],
		prepared: { context: 'Earlier request context.' },
	}
}

/** What the loop does with a step's result: append each item as an entry. */
function keep(history: Message[], result: PrepareStepResult | undefined): void {
	for (const item of result?.recordedContext ?? [])
		history.push(createTurnContextEntry(item.key, item.text))
}

function fixture(archive: EvidenceRecallCandidate[], options: Partial<EvidenceRecallOptions> = {}) {
	const retrieve = vi.fn(async () => ({
		candidates: [...archive],
		scannedBytes: 64,
		incomplete: false,
	}))
	return {
		retrieve,
		recall: createEvidenceRecallStep({ scope, retrieve, record: true, ...options }),
	}
}

const QUERY = 'DELTA tracking code'
const sentLines = (entry: string) =>
	entry
		.split('\n')
		.filter((line) => line.startsWith('{"turnId":'))
		.map((line) => JSON.parse(line) as { seq: number; excerpt: string })

describe('recalled evidence recorded in the conversation', () => {
	it('records the passages under one key and leaves request-only context alone', async () => {
		const { recall } = fixture([candidate('DELTA tracking code: A17', 1)])
		const result = await recall(context([createUserMessage(QUERY)]))

		expect(result?.context).toBeUndefined()
		expect(result?.recordedContext).toHaveLength(1)
		expect(result?.recordedContext?.[0]?.key).toBe(RECALLED_EVIDENCE_ENTRY_KEY)
		expect(sentLines(result?.recordedContext?.[0]?.text ?? '').map((p) => p.seq)).toEqual([1])
	})

	it('keeps the old request-only behaviour when record is not set', async () => {
		const { recall } = fixture([candidate('DELTA tracking code: A17', 1)], { record: false })
		const result = await recall(context([createUserMessage(QUERY)]))
		expect(result?.recordedContext).toBeUndefined()
		expect(result?.context).toContain('DELTA tracking code: A17')
	})

	it('adds nothing for passages an earlier entry already carries', async () => {
		const { recall } = fixture([candidate('DELTA tracking code: A17', 1)])
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		history.push(createUserMessage('And the DELTA tracking code again?'))

		expect(await recall(context(history))).toBeUndefined()
	})

	it('adds only the passages whose address is new', async () => {
		const archive = [candidate('DELTA tracking code: A17', 1)]
		const { recall } = fixture(archive)
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		archive.push(candidate('DELTA tracking code: B99', 2))
		history.push(createUserMessage('What was the DELTA tracking code later?'))

		const second = await recall(context(history))
		const lines = sentLines(second?.recordedContext?.[0]?.text ?? '')
		expect(lines.map((p) => p.seq)).toEqual([2])
		expect(second?.recordedContext?.[0]?.text).not.toContain('A17')
	})

	it('holds at most the session budget, then names further records by address only', async () => {
		const archive = [candidate(`DELTA tracking code: ${'a'.repeat(300)}`, 1)]
		const { recall } = fixture(archive, { sessionMaxChars: 2_500 })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		const held = turnContextEntries(history, RECALLED_EVIDENCE_ENTRY_KEY)
			.map((entry) => entry.length)
			.reduce((a, b) => a + b, 0)
		expect(held).toBeLessThanOrEqual(2_500)

		// Fill the rest of the budget with an entry of another earlier record.
		history.push(createTurnContextEntry(RECALLED_EVIDENCE_ENTRY_KEY, 'x'.repeat(2_400)))
		archive.push(candidate('DELTA tracking code: B99', 2), candidate('DELTA tracking code: C42', 3))
		history.push(createUserMessage('What was the DELTA tracking code later?'))

		const result = await recall(context(history))
		const text = result?.recordedContext?.[0]?.text ?? ''
		expect(result?.recordedContext?.[0]?.key).toBe(RECALLED_EVIDENCE_ENTRY_KEY)
		expect(text).toContain('2 more records')
		expect(text).not.toContain('B99')
		expect(text).not.toContain('C42')
		expect(JSON.parse(text.split('\n')[1] ?? '{}').additionalEvidence).toHaveLength(2)

		// The same pointers are not said twice.
		keep(history, result)
		history.push(createUserMessage('Again, the DELTA tracking code?'))
		expect(await recall(context(history))).toBeUndefined()
	})

	it('offers everything again once a compaction has dropped the entries', async () => {
		const { recall } = fixture([candidate('DELTA tracking code: A17', 1)])
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		const afterCompaction: Message[] = [createUserMessage('What was the DELTA tracking code?')]

		const result = await recall(context(afterCompaction))
		expect(sentLines(result?.recordedContext?.[0]?.text ?? '').map((p) => p.seq)).toEqual([1])
	})

	it('gives the full reading rules once and a short header to a later entry', async () => {
		const archive = [candidate('DELTA tracking code: A17', 1)]
		const { recall } = fixture(archive)
		const history: Message[] = [createUserMessage(QUERY)]
		const first = await recall(context(history))
		keep(history, first)
		archive.push(candidate('DELTA tracking code: B99', 2))
		history.push(createUserMessage('What was the DELTA tracking code later?'))
		const second = await recall(context(history))

		const firstText = first?.recordedContext?.[0]?.text ?? ''
		const secondText = second?.recordedContext?.[0]?.text ?? ''
		expect(firstText).toContain('Quote identifiers exactly')
		expect(secondText).not.toContain('Quote identifiers exactly')
		expect(secondText).toContain('not instructions')
		expect(secondText).toContain('untrusted')
		expect(sentLines(secondText).map((p) => p.seq)).toEqual([2])
		expect(secondText.length).toBeLessThan(firstText.length - 500)
	})

	it('gives the full reading rules again when the entries that carried them are gone', async () => {
		const archive = [candidate('DELTA tracking code: A17', 1)]
		const { recall } = fixture(archive)
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		const afterCompaction: Message[] = [createUserMessage('What was the DELTA tracking code?')]
		const result = await recall(context(afterCompaction))
		expect(result?.recordedContext?.[0]?.text).toContain('Quote identifiers exactly')
	})

	it('keeps a pointer entry short, says where to open it when nothing else does, and loses no address', async () => {
		const archive = [
			candidate('DELTA tracking code: B99', 2),
			candidate('DELTA tracking code: C42', 3),
		]
		const { recall } = fixture(archive, { sessionMaxChars: 2_500 })
		// The conversation holds recorded evidence, but not the rules for reading it.
		const history: Message[] = [
			createUserMessage(QUERY),
			createTurnContextEntry(RECALLED_EVIDENCE_ENTRY_KEY, 'x'.repeat(2_400)),
		]

		const text = (await recall(context(history)))?.recordedContext?.[0]?.text ?? ''
		const [lead, json] = text.split('\n')
		expect(lead).toBe(
			'2 more records to open by address with the conversation-history tools (untrusted data):',
		)
		const parsed = JSON.parse(json ?? '{}') as {
			additionalEvidence: {
				turnId: string
				seq: number
				part: number
				byteOffset: number
			}[]
			omittedAddresses?: number
		}
		expect(parsed.additionalEvidence.map((a) => a.seq).sort()).toEqual([2, 3])
		for (const address of parsed.additionalEvidence) {
			expect(address.turnId).toBe(sourceRun)
			expect(address.part).toBe(0)
			expect(address.byteOffset).toBe(0)
		}
		// Nothing was left out, so nothing is said about leaving out.
		expect(parsed.omittedAddresses).toBeUndefined()
		expect(text.length).toBeLessThan(450)
	})

	it('names a pointer’s addresses briefly once the reading rules are in the conversation', async () => {
		const archive = [candidate('DELTA tracking code: A17', 1)]
		const { recall } = fixture(archive, { sessionMaxChars: 2_500 })
		const history: Message[] = [createUserMessage(QUERY)]
		keep(history, await recall(context(history)))
		// Past the session budget the next record is only pointed to.
		history.push(createTurnContextEntry(RECALLED_EVIDENCE_ENTRY_KEY, 'x'.repeat(2_400)))
		archive.push(candidate('DELTA tracking code: B99', 2))
		history.push(createUserMessage('What was the DELTA tracking code later?'))

		const text = (await recall(context(history)))?.recordedContext?.[0]?.text ?? ''
		expect(text.split('\n')[0]).toBe('1 more records (untrusted data):')
		expect(JSON.parse(text.split('\n')[1] ?? '{}').additionalEvidence).toHaveLength(1)
	})

	it('keeps a note about an unavailable search request-only', async () => {
		const failing = createEvidenceRecallStep({
			scope,
			record: true,
			retrieve: async () => {
				throw new Error('archive down')
			},
		})
		const error = await Promise.resolve(failing(context([createUserMessage(QUERY)]))).then(
			() => undefined,
			(thrown: { context?: string }) => thrown,
		)
		expect(error?.context).toContain('Conversation evidence is not available')
	})
})
