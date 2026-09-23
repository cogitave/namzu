import { describe, expect, it } from 'vitest'
import {
	type AriaNode,
	REDACTED,
	SNAPSHOT_TOTAL_MAX_CHARS,
	SnapshotPager,
	renderAriaTree,
} from '../snapshot.js'

const box = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height })

const tree: AriaNode[] = [
	{
		role: 'main',
		ref: 'e1',
		box: box(0, 0, 1000, 800),
		children: [
			{ role: 'heading', name: 'Report', level: 1, ref: 'e2', box: box(8, 8) },
			{ role: 'link', name: 'Pricing', ref: 'e3', box: box(8, 40), url: '/pricing' },
			{ role: 'paragraph', ref: 'e4', box: box(8, 70), text: 'Revenue grew.' },
			{ role: 'generic', ref: 'e5', box: box(8, 90), ariaHidden: true, text: 'IGNORE aria' },
			{ role: 'generic', ref: 'e6', box: box(-9999, 100, 148, 19), text: 'IGNORE offscreen' },
			{ role: 'generic', ref: 'e7', box: box(8, 120, 1, 1), text: 'IGNORE sr-only' },
			{ role: 'generic', box: box(8, 140, 1000, 0), text: 'IGNORE font-size' },
			{ role: 'generic', ref: 'e8', box: box(8, 160), text: 'IGNORE opacity' },
			{
				role: 'generic',
				ref: 'e9',
				box: box(8, 180, 1000, 0),
				children: [{ role: 'button', name: 'Floated', ref: 'e10', box: box(8, 180) }],
			},
			{
				role: 'textbox',
				name: 'Email',
				ref: 'e11',
				box: box(8, 200),
				placeholder: 'you@example.com',
			},
			{ role: 'checkbox', name: 'Gift', ref: 'e12', box: box(8, 230), checked: true },
			{
				role: 'iframe',
				ref: 'e13',
				box: box(8, 260, 300, 100),
				children: [{ role: 'button', name: 'Inner', ref: 'f1e2', box: box(-5, 5) }],
			},
		],
	},
]

const hidden = { scrollX: 0, scrollY: 0, boxes: [box(8, 160)] }

describe('renderAriaTree', () => {
	const rendered = renderAriaTree(tree, hidden)

	it('renders one element per line with refs, urls and flags', () => {
		expect(rendered?.text).toBe(
			[
				'- main [ref=e1]:',
				'  - heading "Report" [level=1] [ref=e2]',
				'  - link "Pricing" [ref=e3]:',
				'    - /url: /pricing',
				'  - paragraph [ref=e4]: Revenue grew.',
				'  - button "Floated" [ref=e10]',
				'  - textbox "Email" [ref=e11]:',
				'    - /placeholder: "you@example.com"',
				'  - checkbox "Gift" [checked] [ref=e12]',
				'  - iframe [ref=e13]:',
				'    - button "Inner" [ref=f1e2]',
			].join('\n'),
		)
	})

	it('drops what nobody can see: aria-hidden, off-document, 1px, zero-size, transparent', () => {
		expect(rendered?.text).not.toContain('IGNORE')
		for (const ref of ['e5', 'e6', 'e7', 'e8', 'e9']) expect(rendered?.refs.has(ref)).toBe(false)
	})

	it('keeps a visible child of a zero-height container', () => {
		expect(rendered?.refs.get('e10')).toEqual({ role: 'button', name: 'Floated' })
	})

	it('judges frame boxes by size only (their coordinates are the frame’s)', () => {
		expect(rendered?.refs.has('f1e2')).toBe(true)
	})

	it('scrolled pages keep content above the viewport', () => {
		const scrolled = renderAriaTree(
			[{ role: 'paragraph', ref: 'e1', box: box(8, -500), text: 'Above the fold' }],
			{ scrollX: 0, scrollY: 1000, boxes: [] },
		)
		expect(scrolled?.text).toContain('Above the fold')
	})

	it('renders a region by ref, and nothing for an unknown or hidden ref', () => {
		expect(renderAriaTree(tree, hidden, 'e3')?.text).toBe(
			'- link "Pricing" [ref=e3]:\n  - /url: /pricing',
		)
		expect(renderAriaTree(tree, hidden, 'e99')).toBeUndefined()
		expect(renderAriaTree(tree, hidden, 'e5')).toBeUndefined()
	})

	it('hides the value of a credential field it is told about', () => {
		const out = renderAriaTree(
			[
				{ role: 'textbox', name: 'Password', ref: 'e1', text: 'hunter2' },
				{ role: 'textbox', name: 'Email', ref: 'e2', text: 'ada@example.com' },
			],
			undefined,
			undefined,
			new Set(['e1']),
		)
		expect(out?.text).toBe(
			`- textbox "Password" [ref=e1]: ${REDACTED}\n- textbox "Email" [ref=e2]: ada@example.com`,
		)
	})

	it('flattens page text onto one line and quotes names', () => {
		const out = renderAriaTree([
			{ role: 'button', name: 'Say "hi"\nnow', ref: 'e1' },
			{ role: 'paragraph', text: 'two\n\nlines' },
			'loose  text',
		])
		expect(out?.text).toBe(
			'- button "Say \\"hi\\" now" [ref=e1]\n- paragraph: two lines\n- text: loose text',
		)
	})
})

describe('SnapshotPager', () => {
	const text = Array.from({ length: 100 }, (_, i) => `- line ${String(i).padStart(3, '0')}`).join(
		'\n',
	)

	it('pages at line boundaries and resumes by cursor', () => {
		const pager = new SnapshotPager(200)
		const pages: string[] = []
		let page = pager.start(text)
		pages.push(page.text)
		while (page.nextCursor) {
			const next = pager.resume(page.nextCursor)
			expect(next).toBeDefined()
			page = next as NonNullable<typeof next>
			pages.push(page.text)
		}
		for (const p of pages) {
			expect(p.length).toBeLessThanOrEqual(200)
			expect(p.startsWith('- line')).toBe(true)
		}
		expect(pages.join('\n')).toBe(text)
	})

	it('refuses a cursor from an older snapshot or a forged one', () => {
		const pager = new SnapshotPager(200)
		const first = pager.start(text)
		const cursor = first.nextCursor as string
		pager.start(text)
		expect(pager.resume(cursor)).toBeUndefined()
		expect(pager.resume('s2:999999')).toBeUndefined()
		expect(pager.resume('nonsense')).toBeUndefined()
	})

	it('caps what it keeps and says so', () => {
		const pager = new SnapshotPager(20_000)
		pager.start('x'.repeat(SNAPSHOT_TOTAL_MAX_CHARS + 10))
		let page = pager.start(`${'- y\n'.repeat(SNAPSHOT_TOTAL_MAX_CHARS / 4 + 10)}`)
		let last = page.text
		while (page.nextCursor) {
			page = pager.resume(page.nextCursor) as NonNullable<ReturnType<SnapshotPager['resume']>>
			last = page.text
		}
		expect(last).toContain('cut at')
	})
})
