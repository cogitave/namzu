import { describe, expect, it } from 'vitest'
import {
	type AriaNode,
	REDACTED,
	SELECT_OPTIONS_SHOWN,
	SNAPSHOT_TOTAL_MAX_CHARS,
	SnapshotPager,
	diffLines,
	findInTree,
	renderAriaTree,
	renderInteractive,
	renderReading,
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
				'  - textbox "Email" [ref=e11] [empty]:',
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

// A native select as the browser reports it: the options carry no ref and an empty box.
const emptyBox = { x: 0, y: 0, width: 0, height: 0 }
const option = (name: string, selected = false): AriaNode => ({
	role: 'option',
	name,
	box: emptyBox,
	...(selected ? { selected: true } : {}),
})
const select = (chosen: string): AriaNode => ({
	role: 'combobox',
	name: 'Plan',
	ref: 'e7',
	box: box(78, 88, 86, 19),
	children: ['Free', 'Silver', 'Gold'].map((n) => option(n, n === chosen)),
})

describe('a native select', () => {
	it('shows its chosen option as the value and lists its zero-box options', () => {
		const out = renderAriaTree([select('Gold')])
		expect(out?.text).toBe(
			[
				'- combobox "Plan" [ref=e7]: Gold',
				'  - option "Free"',
				'  - option "Silver"',
				'  - option "Gold" [selected]',
			].join('\n'),
		)
	})

	it('shows no value when nothing is chosen, and still lists the options', () => {
		const out = renderAriaTree([select('none')])
		expect(out?.text.split('\n')[0]).toBe('- combobox "Plan" [ref=e7]:')
		expect(out?.text).toContain('  - option "Gold"')
	})

	it('joins several chosen options of a multiple select', () => {
		const multi: AriaNode = {
			...select('x'),
			children: [option('A', true), option('B'), option('C', true)],
		}
		expect(renderAriaTree([multi])?.text.split('\n')[0]).toBe('- combobox "Plan" [ref=e7]: A, C')
	})

	it('still drops a zero-box option that is not under a combobox or listbox', () => {
		const out = renderAriaTree([
			{ role: 'group', ref: 'e1', box: box(0, 0), children: [option('Ghost')] },
		])
		expect(out?.text).not.toContain('Ghost')
	})

	it('lists a long select partly, always keeping the chosen option, and says how many are left', () => {
		const names = Array.from({ length: 120 }, (_, i) => `Country ${i}`)
		const long: AriaNode = {
			...select('x'),
			children: names.map((n) => option(n, n === 'Country 110')),
		}
		const out = renderAriaTree([long])?.text ?? ''
		expect(out.split('\n')[0]).toBe('- combobox "Plan" [ref=e7]: Country 110')
		expect(out).toContain('option "Country 110" [selected]')
		expect(out.match(/- option /g)?.length).toBe(SELECT_OPTIONS_SHOWN)
		expect(out).toContain(`(${120 - SELECT_OPTIONS_SHOWN} more options not listed`)
	})
})

describe('control values', () => {
	it('says an empty text field is empty and shows what a filled one holds', () => {
		const out = renderAriaTree([
			{ role: 'textbox', name: 'Name', ref: 'e1', box: box(0, 0) },
			{ role: 'textbox', name: 'City', ref: 'e2', box: box(0, 30), text: 'Lisbon' },
			{ role: 'slider', name: 'Volume', ref: 'e3', box: box(0, 60), text: '3' },
		])
		expect(out?.text).toBe(
			'- textbox "Name" [ref=e1] [empty]\n- textbox "City" [ref=e2]: Lisbon\n- slider "Volume" [ref=e3]: 3',
		)
	})
})

const page: AriaNode[] = [
	{
		role: 'main',
		ref: 'e1',
		box: box(0, 0, 1000, 800),
		children: [
			{ role: 'heading', name: 'Plans', level: 1, ref: 'e2', box: box(0, 0) },
			'Pick one.',
			{
				role: 'navigation',
				name: 'Main',
				ref: 'e3',
				box: box(0, 20),
				children: [
					{ role: 'link', name: 'Pricing', ref: 'e4', box: box(0, 20), url: '/pricing' },
					{ role: 'link', name: 'Reports', ref: 'e5', box: box(0, 40), url: '/reports' },
				],
			},
			select('Gold'),
			{ role: 'button', name: 'Buy Gold', ref: 'e8', box: box(0, 100) },
			{ role: 'generic', ref: 'e9', box: box(0, 130), children: ['Products'] },
		],
	},
]

describe('interactive view', () => {
	it('lists only what can be acted on, with the group it sits in', () => {
		expect(renderInteractive(page)).toBe(
			[
				'- link "Pricing" [ref=e4] -> /pricing (in navigation "Main")',
				'- link "Reports" [ref=e5] -> /reports (in navigation "Main")',
				'- combobox "Plan" [ref=e7]: Gold',
				'- button "Buy Gold" [ref=e8]',
			].join('\n'),
		)
	})
})

describe('find', () => {
	it('matches name or text case-insensitively and gives each match its ref and context', () => {
		const found = findInTree(
			page,
			{ scrollX: 0, scrollY: 0, boxes: [] },
			new Set(),
			{ query: 'report' },
			20,
		)
		expect(found.total).toBe(1)
		expect(found.lines).toEqual(['- link "Reports" [ref=e5] (in navigation "Main")'])
	})

	it('finds an element by the text it directly holds', () => {
		const found = findInTree(
			page,
			{ scrollX: 0, scrollY: 0, boxes: [] },
			new Set(),
			{ query: 'products' },
			20,
		)
		expect(found.lines).toEqual(['- generic [ref=e9]: Products'])
	})

	it('lists a match that has no ref, with its text and the nearest ref above it', () => {
		const table: AriaNode[] = [
			{
				role: 'table',
				ref: 'e1',
				name: 'Facts',
				box: box(0, 0, 400, 100),
				children: [
					{
						role: 'row',
						box: box(0, 0, 400, 20),
						children: [
							{ role: 'rowheader', box: box(0, 0, 100, 20), children: ['Opened'] },
							{ role: 'cell', box: box(100, 0, 300, 20), children: ['31 March 1889'] },
						],
					},
				],
			},
		]
		const none = { scrollX: 0, scrollY: 0, boxes: [] }
		expect(findInTree(table, none, new Set(), { query: 'opened' }, 20).lines).toEqual([
			'- rowheader: Opened (in table "Facts" [ref=e1])',
		])
		expect(findInTree(table, none, new Set(), { query: '1889', role: 'cell' }, 20).lines).toEqual([
			'- cell: 31 March 1889 (in table "Facts" [ref=e1])',
		])
	})

	it('requires the role and the text together, and caps the list but reports the total', () => {
		const hiddenNone = { scrollX: 0, scrollY: 0, boxes: [] }
		expect(findInTree(page, hiddenNone, new Set(), { role: 'link', query: 'pric' }, 20).total).toBe(
			1,
		)
		const many: AriaNode[] = Array.from({ length: 30 }, (_, i) => ({
			role: 'button',
			name: `Item ${i}`,
			ref: `e${i + 1}`,
			box: box(0, i),
		}))
		const found = findInTree(many, hiddenNone, new Set(), { role: 'button' }, 20)
		expect(found.lines).toHaveLength(20)
		expect(found.total).toBe(30)
	})
})

describe('reading view', () => {
	it('gives the text without markup, headings as # lines', () => {
		expect(renderReading(page)).toBe(
			['# Plans', 'Pick one.', 'Pricing', 'Reports', 'Gold', 'Buy Gold', 'Products'].join('\n'),
		)
	})
})

describe('diffLines', () => {
	it('counts lines that appeared and went, in page order, ignoring indentation', () => {
		const before = ['- main [ref=e1]:', '  - button "A" [ref=e2]', '  - text: old'].join('\n')
		const after = [
			'- main [ref=e1]:',
			'  - button "A" [ref=e2]',
			'  - text: new',
			'  - link "L" [ref=e3]',
		].join('\n')
		expect(diffLines(before, after)).toEqual({
			added: 2,
			removed: 1,
			addedLines: ['text: new', 'link "L" [ref=e3]'],
			removedLines: ['text: old'],
		})
	})

	it('reports no change for equal trees, and a changed value as one line out and one in', () => {
		expect(diffLines('- a\n- b', '- a\n- b').added).toBe(0)
		const d = diffLines('- combobox "Plan" [ref=e7]:', '- combobox "Plan" [ref=e7]: Gold')
		expect([d.added, d.removed]).toEqual([1, 1])
		expect(d.addedLines).toEqual(['combobox "Plan" [ref=e7]: Gold'])
	})

	it('shows only the first lines and cuts long ones', () => {
		const after = Array.from({ length: 20 }, (_, i) => `- line ${i}`).join('\n')
		const d = diffLines('', after, 5)
		expect(d.added).toBe(20)
		expect(d.addedLines).toHaveLength(5)
		expect(diffLines('', `- ${'x'.repeat(500)}`).addedLines[0]?.length).toBeLessThanOrEqual(160)
	})
})
