import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type OutputCard, outputGroupView } from './output-card-model.js'
import { OutputCardView, type OutputCardsContextValue, OutputGroup } from './output-card.js'

const ctx: OutputCardsContextValue = {
	api: {
		readSessionOutput: async () => ({ kind: 'text', text: 'x', size: 1 }) as never,
		openSessionOutput: async () => {},
		describeSessionOutputs: async () => [],
		saveSessionOutput: async () => ({ saved: false }),
	},
	sessionId: 's',
	made: [],
	onOpen: () => {},
	onNotice: () => {},
}
const card = (over: Partial<OutputCard> = {}): OutputCard => ({
	key: 'k',
	path: 'notes/plan.md',
	name: 'plan.md',
	kind: 'document',
	state: 'done',
	kindLine: 'Document · Markdown · 6 KB',
	preview: 'The plan',
	canOpen: true,
	canOpenInBrowser: false,
	canOpenWithSystem: true,
	canCopy: true,
	canSave: true,
	...over,
})
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)

describe('a card', () => {
	it('is one button for the card and separate buttons for its actions', () => {
		const out = html(createElement(OutputCardView, { card: card(), large: false, ctx }))
		expect(out).toContain('Document · Markdown · 6 KB')
		expect(out).toContain('The plan')
		expect(out).toContain(
			'aria-label="plan.md, Document · Markdown · 6 KB. Open beside the conversation."',
		)
		expect(out).toContain('Save a copy of plan.md')
		expect(out).toContain('Copy the text of plan.md')
		expect(out).not.toContain('in the browser')
		// The actions sit beside the main button, never inside it.
		expect(out.match(/<button/g)).toHaveLength(4)
		expect(out).not.toMatch(/<button[^>]*output-card-main[^>]*>(?:(?!<\/button>).)*<button/)
	})
	it('shows a writing card with a progress line and no actions', () => {
		const out = html(
			createElement(OutputCardView, {
				card: card({ state: 'writing', kindLine: 'Writing…', canOpen: false, preview: undefined }),
				large: false,
				ctx,
			}),
		)
		expect(out).toContain('Writing…')
		expect(out).toContain('output-card-progress')
		expect(out).not.toContain('<button')
	})
	it('says why a failed card failed', () => {
		const out = html(
			createElement(OutputCardView, {
				card: card({
					state: 'failed',
					kindLine: 'Couldn’t write this file',
					reason: 'Namzu didn’t have permission.',
					canOpen: false,
				}),
				large: false,
				ctx,
			}),
		)
		expect(out).toContain('data-state="failed"')
		expect(out).toContain('Namzu didn’t have permission.')
	})
})

describe('a group', () => {
	it('is captioned and labelled with its count, and folds past four', () => {
		const many = Array.from({ length: 6 }, (_, index) =>
			card({ key: `k${index}`, name: `f${index}.md` }),
		)
		const out = html(
			createElement(OutputGroup, { view: outputGroupView(many, false), ctx, onExpand: () => {} }),
		)
		expect(out).toContain('aria-label="6 outputs"')
		expect(out).toContain('Made in this reply')
		expect(out).toContain('Show 2 more')
		expect(out.match(/data-output-card=/g)).toHaveLength(4)
	})
})

describe('the tile and its extension badge', () => {
	it('keeps the glyph above the badge, which sits on the tile’s lower edge', async () => {
		const { readFileSync } = await import('node:fs')
		const css = readFileSync(new URL('./output-card.css', import.meta.url), 'utf8')
		const tile = /\.output-card-tile \{([^}]*)\}/.exec(css)?.[1] ?? ''
		expect(tile).toMatch(/padding-bottom:\s*0\.875rem/)
	})
	it('lays the actions over the card, so a narrow card keeps its whole kind line', async () => {
		const { readFileSync } = await import('node:fs')
		const css = readFileSync(new URL('./output-card.css', import.meta.url), 'utf8')
		const actions = /\.output-card-actions \{([^}]*)\}/.exec(css)?.[1] ?? ''
		expect(actions).toMatch(/position:\s*absolute/)
	})
})
