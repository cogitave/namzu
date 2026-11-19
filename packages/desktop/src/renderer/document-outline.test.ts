import { describe, expect, it } from 'vitest'
import {
	documentOutline,
	drawnHeadingIndex,
	outlineDepths,
	plainHeading,
} from './document-outline.js'

describe('the outline of a document', () => {
	it('lists headings down to the fourth level, in order', () => {
		const out = documentOutline(
			'# Plan\n\ntext\n\n## Goals\n\n### Detail\n\n#### Fine\n\n##### Too deep\n\n## Risks\n',
		)
		expect(out.map((entry) => [entry.level, entry.text])).toEqual([
			[1, 'Plan'],
			[2, 'Goals'],
			[3, 'Detail'],
			[4, 'Fine'],
			[2, 'Risks'],
		])
	})
	it('skips code blocks, front matter and lines that are not headings', () => {
		const text = [
			'---',
			'title: x',
			'# not a heading',
			'---',
			'# Real',
			'```md',
			'# in code',
			'```',
			'~~~',
			'## in tilde code',
			'~~~',
			'#hashtag',
			'    # indented code',
			'<h2>html</h2>',
			'## Next ##',
		].join('\n')
		expect(documentOutline(text).map((entry) => entry.text)).toEqual(['Real', 'Next'])
	})
	it('counts a repeated heading so the right one is found', () => {
		const out = documentOutline('## Notes\n\n## Other\n\n## Notes\n')
		expect(out.map((entry) => entry.occurrence)).toEqual([0, 0, 1])
		expect(drawnHeadingIndex(out, 2, ['Notes', 'Other', 'Notes'])).toBe(2)
		expect(drawnHeadingIndex(out, 0, ['Notes', 'Other', 'Notes'])).toBe(0)
	})
	it('falls back to its place when the page drew the text differently', () => {
		const out = documentOutline('## A\n\n## B\n')
		expect(drawnHeadingIndex(out, 1, ['A', 'B!'])).toBe(1)
		expect(drawnHeadingIndex(out, 1, ['A'])).toBeUndefined()
		expect(drawnHeadingIndex(out, 5, ['A', 'B'])).toBeUndefined()
	})
	it('reads a heading as a person does', () => {
		expect(plainHeading('The **big** [plan](a.md) with `code` and snake_case_name')).toBe(
			'The big plan with code and snake_case_name',
		)
		expect(plainHeading('*Soft* and _quiet_')).toBe('Soft and quiet')
		expect(plainHeading('![logo](a.png) Intro')).toBe('logo Intro')
	})
	it('indents from the shallowest heading present', () => {
		expect(outlineDepths(documentOutline('## A\n### B\n## C\n'))).toEqual([0, 1, 0])
	})
})
