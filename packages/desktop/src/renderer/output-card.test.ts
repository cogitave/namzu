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
	stateWord: 'Created',
	canOpen: true,
	canOpenInBrowser: false,
	canOpenWithSystem: true,
	canCopy: true,
	canSave: true,
	...over,
})
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)

describe('a card', () => {
	it('is one compact row: icon, title, a state word and a chevron, with the kind in the tooltip', () => {
		const out = html(createElement(OutputCardView, { card: card(), ctx }))
		expect(out).toContain('output-card-icon')
		expect(out).toContain('>plan.md<')
		expect(out).toContain('>Created<')
		expect(out).toContain('output-card-chevron')
		expect(out).toContain('title="Document · Markdown · 6 KB"')
		// No kind line, no preview line, no badge.
		expect(out).not.toContain('output-card-kind')
		expect(out).not.toContain('output-card-preview')
		expect(out).not.toContain('output-card-badge')
		expect(out).toContain(
			'aria-label="plan.md, Document · Markdown · 6 KB. Open beside the conversation."',
		)
		expect(out).toContain('Save a copy of plan.md')
		expect(out).toContain('Copy the text of plan.md')
		// The actions sit beside the main button, never inside it.
		expect(out.match(/<button/g)).toHaveLength(4)
		expect(out).not.toMatch(/<button[^>]*output-card-main[^>]*>(?:(?!<\/button>).)*<button/)
	})
	it('shows a writing card with a progress line and no actions', () => {
		const out = html(
			createElement(OutputCardView, {
				card: card({
					state: 'writing',
					stateWord: 'Writing',
					kindLine: 'Writing…',
					canOpen: false,
				}),
				ctx,
			}),
		)
		expect(out).toContain('>Writing<')
		expect(out).toContain('output-card-progress')
		expect(out).not.toContain('<button')
	})
	it('keeps a failed document write as a compact red row with its reason', () => {
		const out = html(
			createElement(OutputCardView, {
				card: card({
					state: 'failed',
					stateWord: 'Failed',
					kindLine: 'Couldn’t write this file',
					reason: 'Namzu didn’t have permission.',
					canOpen: false,
				}),
				ctx,
			}),
		)
		expect(out).toContain('data-state="failed"')
		expect(out).toContain('>Failed<')
		expect(out).toContain('output-card-reason')
		expect(out).toContain('Namzu didn’t have permission.')
		expect(out).not.toContain('output-card-chevron')
	})
})

describe('a group', () => {
	it('has no caption for a few cards, and folds past three', () => {
		const few = html(
			createElement(OutputGroup, {
				view: outputGroupView([card()], false),
				ctx,
				onExpand: () => {},
			}),
		)
		expect(few).not.toContain('Made in this reply')
		const many = Array.from({ length: 5 }, (_, index) =>
			card({ key: `k${index}`, name: `f${index}.md` }),
		)
		const out = html(
			createElement(OutputGroup, { view: outputGroupView(many, false), ctx, onExpand: () => {} }),
		)
		expect(out).toContain('aria-label="5 outputs"')
		expect(out).toContain('Made in this reply')
		expect(out).toContain('Show 2 more')
		expect(out.match(/data-output-card=/g)).toHaveLength(3)
	})
})

describe('the card’s measured shape', () => {
	const css = async () => {
		const { readFileSync } = await import('node:fs')
		return readFileSync(new URL('./output-card.css', import.meta.url), 'utf8')
	}
	it('is 320 wide and 36 tall, flat, with a 16 px icon', async () => {
		const text = await css()
		const card = /\.output-card \{([^}]*)\}/.exec(text)?.[1] ?? ''
		expect(card).toMatch(/width:\s*min\(100%,\s*20rem\)/)
		expect(card).toMatch(/min-height:\s*36px/)
		expect(text).not.toMatch(/translateY\(-2px\)/)
		expect(/\.output-card-icon \{([^}]*)\}/.exec(text)?.[1]).toMatch(/width:\s*16px/)
	})
	it('lays the actions over the state word’s slot, so the row never changes size', async () => {
		const actions = /\.output-card-actions \{([^}]*)\}/.exec(await css())?.[1] ?? ''
		expect(actions).toMatch(/position:\s*absolute/)
		expect(actions).toMatch(/right:/)
	})
})
