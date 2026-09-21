import { expect, it } from 'vitest'
import { conversationEvidenceView } from './conversation-evidence-view.js'

const page = {
	turnId: 'bcd3d4e0-ea88-4cfa-afb1-ed135da49ea8',
	seq: 2,
	part: 0,
	source: 'tool_completed',
	recordKind: 'tool_result',
	toolName: 'read',
	text: 'Original receipt 🦉',
	offset: 0,
	complete: true,
	retainedPreview: false,
}

it('keeps the complete returned JSON while bounding only the operator excerpt', () => {
	const receipt = { ...page, text: `${'🦉'.repeat(250)}\nFINAL_RECEIPT`, nextField: 'preserved' }
	const view = conversationEvidenceView('read_conversation', JSON.stringify(receipt))!
	expect(view.content).toContain('Selected retained part returned')
	expect(view.content).toContain('Original tool status unknown')
	expect(view.content).not.toContain('FINAL_RECEIPT')
	expect(view.content).not.toMatch(/\p{Surrogate}/u)
	expect(JSON.parse(view.detail.join('\n'))).toEqual(receipt)
})

it('distinguishes a final retained preview from full original output and tool success', () => {
	const view = conversationEvidenceView(
		'read_conversation',
		JSON.stringify({
			...page,
			retainedPreview: true,
			isError: true,
		}),
	)!
	expect(view.content).toContain('Preview flagged · original may be incomplete')
	expect(view.content).toContain('Original tool reported an error')
	expect(view.content).toContain('Selected retained part returned')
	expect(view.content).not.toMatch(/full original|task complete|verified/i)
})

it('does not call a final page read from a later offset a complete part', () => {
	const view = conversationEvidenceView(
		'read_conversation',
		JSON.stringify({ ...page, offset: 200 }),
	)!
	expect(view.content).toContain('Last page · earlier text is not on this page')
	expect(view.content).not.toContain('Selected retained part returned')
})

it('distinguishes empty lookup progress from a located partial text page', () => {
	const lookup = {
		text: '',
		offset: 0,
		complete: false,
		retainedPreview: false,
		nextCursor: 'cursor',
	}
	const locating = conversationEvidenceView('read_conversation', JSON.stringify(lookup))!
	expect(locating.content).toContain('Source unknown')
	expect(locating.content).toContain('Locating retained text · continue scan')
	const partial = conversationEvidenceView(
		'read_conversation',
		JSON.stringify({
			...page,
			complete: false,
			nextCursor: 'cursor',
		}),
	)!
	expect(partial.content).toContain('Partial page · more retained text available')
})

it('labels a recorded assistant message by metadata, not a tool claim in its text', () => {
	const view = conversationEvidenceView(
		'read_conversation',
		JSON.stringify({
			...page,
			recordKind: 'assistant_message',
			toolName: undefined,
			text: 'Tool result: verified!',
		}),
	)!
	expect(view.content.split('\n')[0]).toBe('Conversation read · Assistant message')
	expect(view.content).not.toContain('Original tool')
})

it('preserves an incomplete no-match search without inventing a continuation or historical absence', () => {
	const view = conversationEvidenceView(
		'search_conversation',
		JSON.stringify({
			matches: [],
			incomplete: true,
			unavailableRuns: 2,
		}),
	)!
	expect(view.content).toContain('0 matches on this page')
	expect(view.content).toContain('Search incomplete · absence is inconclusive')
	expect(view.content).toContain('2 run(s) unavailable')
	expect(view.content).not.toContain('more to scan')
})

it('keeps omitted search matches, provenance and exact excerpts available in details', () => {
	const result = {
		matches: Array.from({ length: 5 }, (_, i) => ({ ...page, seq: i + 1, text: `receipt-${i}` })),
		incomplete: false,
		unavailableRuns: 0,
	}
	const view = conversationEvidenceView('search_conversation', JSON.stringify(result))!
	expect(view.content).toContain('Traversal finished within selected sources')
	expect(view.content).toContain('+2 more matches in details')
	expect(view.content).not.toContain('receipt-4')
	expect(JSON.parse(view.detail.join('\n'))).toEqual(result)
})

it.each(['not json', 'null', '[]', '{"text":"not an archive page"}'])(
	'leaves unrecognized receipts to the existing fallback: %s',
	(output) => {
		expect(conversationEvidenceView('read_conversation', output)).toBeUndefined()
		expect(conversationEvidenceView('search_conversation', output)).toBeUndefined()
	},
)

it('does not reinterpret a different tool with the same response shape', () => {
	expect(conversationEvidenceView('remote_tool', JSON.stringify(page))).toBeUndefined()
})
