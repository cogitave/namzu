/**
 * Refs that survive: a ref names a control, and when the window has moved on
 * the control is found again by its evidence (id, place, role and name)
 * before anything is sent. One fit is the control, several are
 * AMBIGUOUS_TARGET, none is STALE_REF. Large windows come back as an outline
 * whose regions open one at a time.
 */
import type { UiElement, UiSnapshot } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { CuaDriverAdapter, type CuaDriverAdapterOptions } from '../adapters/cua-driver/adapter.js'
import { type UiEvidence, locate, toUiTree } from '../adapters/cua-driver/ui-tree.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	toolResult,
} from './fake-mcp-process.js'

interface Node {
	role: string
	label?: string
	id?: string
	actions?: string[]
	value?: string
	children?: Node[]
}

/** A window the test edits between reads. Tokens die with the next read, as the driver's do. */
function window(
	root: Node,
	options: {
		app?: string
		sparseFirst?: boolean
		effect?: string
		onClick?: () => void
		onTool?: (call: ToolCall) => void
		foreground?: CuaDriverAdapterOptions['foreground']
	} = {},
) {
	const state = {
		root,
		reads: 0,
		clock: 0,
		closed: false,
		extraWindow: false,
		pid: 7,
		queryRoot: undefined as Node | undefined,
		queries: [] as unknown[],
	}
	const calls: ToolCall[] = []
	const clicks: { token: string; read: number }[] = []
	let latestRead = 0
	const render = (root?: Node): Record<string, unknown> => {
		state.reads += 1
		latestRead = state.reads
		const elements: Record<string, unknown>[] = []
		const lines: string[] = []
		let index = 0
		const walk = (node: Node, depth: number, parent: number | undefined): void => {
			const label = node.label ?? ''
			const actionable = (node.actions ?? []).length > 0
			const attrs = [
				...(node.id ? [`id=${node.id}`] : []),
				...(actionable ? [`actions=[${(node.actions ?? []).join(',')}]`] : []),
			]
			const attrText = attrs.length ? ` [${attrs.join(' ')}]` : ''
			const head = `${node.role}${label ? ` "${label}"` : ''}${attrText}`
			let mine: number | undefined
			if (actionable) {
				mine = index++
				elements.push({
					element_index: mine,
					element_token: `s${state.reads}:${mine}`,
					role: node.role,
					label,
					...(node.value !== undefined ? { value: node.value } : {}),
					enabled: true,
					actions: node.actions,
					...(parent !== undefined ? { parent_index: parent } : {}),
				})
				lines.push(`${'  '.repeat(depth)}- [${mine}] ${head}`)
			} else {
				lines.push(`${'  '.repeat(depth)}- ${head}`)
			}
			for (const child of node.children ?? []) walk(child, depth + 1, mine ?? parent)
		}
		const sparse = options.sparseFirst === true && state.reads === 1
		walk(
			sparse ? { role: 'Window', label: 'Page', children: [] } : (root ?? state.root),
			0,
			undefined,
		)
		return {
			window_title: 'Page',
			app_name: options.app ?? 'page.exe',
			pid: state.pid,
			elements,
			tree_markdown: lines.join('\n'),
		}
	}
	const script: FakeServerScript = {
		tool: (call) => {
			calls.push(call)
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: state.closed
							? []
							: [
									{
										window_id: 100,
										pid: state.pid,
										app_name: options.app ?? 'page.exe',
										title: 'Page',
										bounds: { x: 0, y: 0, width: 800, height: 600 },
										z_index: 1,
									},
									...(state.extraWindow
										? [
												{
													window_id: 200,
													pid: state.pid,
													app_name: options.app ?? 'page.exe',
													title: 'Open',
													bounds: { x: 10, y: 10, width: 300, height: 200 },
													z_index: 2,
												},
											]
										: []),
								],
					})
				case 'get_window_state': {
					state.queries.push(call.arguments)
					if (state.closed)
						return {
							result: {
								isError: true,
								content: [{ type: 'text', text: 'no such window' }],
							},
						}
					return toolResult(
						render(call.arguments.query !== undefined ? state.queryRoot : undefined),
					)
				}
				case 'click': {
					const token = String(call.arguments.element_token)
					if (!token.startsWith(`s${latestRead}:`))
						return {
							result: {
								isError: true,
								content: [
									{
										type: 'text',
										text: 'element_token is stale; call get_window_state again',
									},
								],
								structuredContent: {
									status: 'refused',
									refusal: {
										code: 'stale_element_token',
										message: 'element_token is stale',
									},
								},
							},
						}
					clicks.push({ token, read: latestRead })
					options.onClick?.()
					return toolResult({ effect: options.effect ?? 'unverifiable', route: 'accessibility' })
				}
				default:
					options.onTool?.(call)
					return toolResult({ effect: 'unverifiable', route: 'accessibility' })
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
		now: () => state.clock,
		...(options.foreground ? { foreground: options.foreground } : {}),
	})
	return { adapter, state, calls, clicks, externalRead: () => render() }
}

function find(snapshot: UiSnapshot, role: string, name: string): UiElement {
	const stack = [snapshot.root]
	while (stack.length > 0) {
		const element = stack.pop() as UiElement
		if (element.role === role && element.name === name) return element
		stack.push(...(element.children ?? []))
	}
	throw new Error(`no ${role} ${name}`)
}

const button = (label: string, id?: string): Node => ({
	role: 'Button',
	label,
	...(id ? { id } : {}),
	actions: ['invoke'],
})

const page = (...children: Node[]): Node => ({
	role: 'Window',
	label: 'Page',
	children,
})

describe('locate', () => {
	const tree = toUiTree({
		elements: [
			{
				element_index: 0,
				element_token: 't0',
				role: 'Button',
				label: 'OK',
				actions: ['invoke'],
			},
			{
				element_index: 1,
				element_token: 't1',
				role: 'Button',
				label: 'OK',
				actions: ['invoke'],
			},
			{
				element_index: 2,
				element_token: 't2',
				role: 'Button',
				label: 'Save',
				actions: ['invoke'],
			},
		],
		tree_markdown: [
			'- Window "W"',
			'  - Group "A"',
			'    - [0] Button "OK" [actions=[invoke]]',
			'  - Group "B"',
			'    - [1] Button "OK" [actions=[invoke]]',
			'  - [2] Button "Save" [id=save actions=[invoke]]',
			'  - Text "Status"',
		].join('\n'),
	})
	const ev = (over: Partial<UiEvidence>): UiEvidence => ({
		role: 'Button',
		name: 'OK',
		path: [],
		...over,
	})

	it('finds a control by its id when the id and name still say the same thing', () => {
		const found = locate(ev({ name: 'Save', automationId: 'save', path: [9, 9] }), tree, {
			actionable: true,
		})
		expect(found).toMatchObject({ kind: 'found', node: { token: 't2' } })
	})

	it('does not accept the same id under another name', () => {
		expect(
			locate(ev({ name: 'Delete', automationId: 'save' }), tree, {
				actionable: true,
			}),
		).toEqual({
			kind: 'gone',
		})
	})

	it('settles a name shared by two controls by the stored path, and never guesses without it', () => {
		const second = tree.nodes.find((n) => n.token === 't1')
		expect(locate(ev({ path: second?.path ?? [] }), tree, { actionable: true })).toMatchObject({
			kind: 'found',
			node: { token: 't1' },
		})
		expect(locate(ev({ path: [5, 5] }), tree, { actionable: true })).toEqual({
			kind: 'ambiguous',
			count: 2,
		})
	})

	it('reports a control that is gone, and one that can no longer be acted on', () => {
		expect(locate(ev({ name: 'Nope' }), tree, { actionable: true })).toEqual({
			kind: 'gone',
		})
		expect(locate(ev({ role: 'Text', name: 'Status' }), tree, { actionable: true })).toEqual({
			kind: 'gone',
		})
		expect(locate(ev({ role: 'Text', name: 'Status' }), tree, { actionable: false })).toMatchObject(
			{
				kind: 'found',
			},
		)
	})
})

describe('a ref that outlives its read', () => {
	it('is found again where it moved, and the click carries the new handle', async () => {
		const w = window(page(button('Save'), button('Cancel')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const cancel = find(snapshot, 'Button', 'Cancel').ref
		// A banner is inserted above: every path shifts.
		w.state.root = page(
			{ role: 'Group', label: 'Banner', children: [button('Dismiss')] },
			button('Save'),
			button('Cancel'),
		)
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(cancel, 'invoke')
		expect(result).toMatchObject({ ok: true })
		// The window was read again, then the click used the handle of that read.
		expect(w.clicks).toHaveLength(1)
		expect(w.clicks[0]?.token).toBe(`s${w.clicks[0]?.read}:2`)
		await w.adapter.dispose()
	})

	it('answers AMBIGUOUS_TARGET and sends nothing when several controls fit', async () => {
		const w = window(
			page(button('OK'), {
				role: 'Group',
				label: 'Dialog',
				children: [button('Retry')],
			}),
		)
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const ok = find(snapshot, 'Button', 'OK').ref
		w.state.root = page(
			{ role: 'Group', label: 'One', children: [button('OK')] },
			{ role: 'Group', label: 'Two', children: [button('OK')] },
		)
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(ok, 'invoke')
		expect(result).toMatchObject({
			ok: false,
			code: 'AMBIGUOUS_TARGET',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})

	it('answers STALE_REF and sends nothing when the control is gone', async () => {
		const w = window(page(button('Save'), button('Cancel')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const cancel = find(snapshot, 'Button', 'Cancel').ref
		w.state.root = page(button('Save'))
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(cancel, 'invoke')
		expect(result).toMatchObject({
			ok: false,
			code: 'STALE_REF',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result.detail).toContain('Button "Cancel"')
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})

	it('answers STALE_REF when the window has closed', async () => {
		const w = window(page(button('Save')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const save = find(snapshot, 'Button', 'Save').ref
		w.state.closed = true
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(save, 'invoke')
		expect(result).toMatchObject({
			ok: false,
			code: 'STALE_REF',
			delivery: 'not_delivered',
		})
		expect(result.detail).toContain('closed')
		await w.adapter.dispose()
	})

	it('is not read again while the read is fresh, and is read again once it is not', async () => {
		// A confirmed click needs no read afterwards, so the reads counted are those before the click:
		// the two that watch the window, and the one that finds the control again once its read is old.
		const w = window(page(button('Save')), { effect: 'confirmed' })
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const save = find(snapshot, 'Button', 'Save').ref
		const reads = w.state.reads
		w.state.clock = 2_000
		await w.adapter.uiAct(save, 'invoke')
		expect(w.clicks[0]?.read).toBe(reads + 2)
		w.state.clock = 9_000
		await w.adapter.uiAct(save, 'invoke')
		expect(w.clicks[1]?.read).toBe(reads + 2 + 1 + 2)
		expect(w.clicks).toHaveLength(2)
		await w.adapter.dispose()
	})

	it('checks again right before the write: a handle another read replaced is refused, found again, and used once', async () => {
		const w = window(page(button('Save'), button('Cancel')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const save = find(snapshot, 'Button', 'Save').ref
		// Something else read the window after the snapshot: its handles are dead.
		w.externalRead()
		const result = await w.adapter.uiAct(save, 'invoke')
		expect(result).toMatchObject({ ok: true })
		expect(w.clicks).toHaveLength(1)
		expect(w.clicks[0]?.token).toBe(`s${w.clicks[0]?.read}:0`)
		await w.adapter.dispose()
	})

	it('keeps the ref the same in every snapshot of a control that did not move', async () => {
		const w = window(page(button('Save', 'save'), button('Cancel')))
		const first = await w.adapter.uiSnapshot('0x64')
		const second = await w.adapter.uiSnapshot('0x64')
		expect(find(second, 'Button', 'Save').ref).toBe(find(first, 'Button', 'Save').ref)
		expect(find(second, 'Button', 'Cancel').ref).toBe(find(first, 'Button', 'Cancel').ref)
		await w.adapter.dispose()
	})
})

describe('large windows', () => {
	const rows = (n: number): Node[] =>
		Array.from({ length: n }, (_, i) => ({
			role: 'ListItem',
			label: `Row ${i}`,
			actions: ['select'],
		}))
	const big = (): Node =>
		page(
			button('Search', 'search'),
			{ role: 'List', label: 'Results', children: rows(500) },
			{ role: 'Group', label: 'Footer', children: [button('Help')] },
		)

	it('comes back as an outline that counts what it hides', async () => {
		const w = window(big())
		const snapshot = await w.adapter.uiSnapshot('0x64')
		expect(snapshot.outline).toBe(true)
		expect(snapshot.total).toBeGreaterThan(500)
		const list = find(snapshot, 'List', 'Results')
		expect(list.hiddenChildren).toBeGreaterThan(300)
		expect(list.ref).not.toBe('')
		// Top-level controls stay in view.
		expect(find(snapshot, 'Button', 'Search').ref).not.toBe('')
		await w.adapter.dispose()
	})

	it('does not act on a region, and says how to open it', async () => {
		const w = window(big())
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const list = find(snapshot, 'List', 'Results').ref
		const result = await w.adapter.uiAct(list, 'invoke')
		expect(result).toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result.detail).toContain('ui_snapshot {root:')
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})

	it('opens one region, and every ref outside it stays valid', async () => {
		const w = window(big())
		const outline = await w.adapter.uiSnapshot('0x64')
		const list = find(outline, 'List', 'Results').ref
		const search = find(outline, 'Button', 'Search').ref
		const help = find(outline, 'Button', 'Help').ref
		const region = await w.adapter.uiSnapshot(undefined, { root: list })
		// The window may be named in either letter case.
		await w.adapter.uiSnapshot('0X64', { root: list })
		expect(region.region).toBe(true)
		expect(region.windowId).toBe(outline.windowId)
		expect(region.root.name).toBe('Results')
		expect(find(region, 'ListItem', 'Row 7').ref).not.toBe('')
		// The refs the outline gave, outside the region, name the same controls.
		await expect(w.adapter.uiAct(search, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		await expect(w.adapter.uiAct(help, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		expect(w.clicks.map((c) => c.token)).toEqual([
			`s${w.clicks[0]?.read}:0`,
			`s${w.clicks[1]?.read}:${500 + 1}`,
		])
		await w.adapter.dispose()
	})

	it('lists a long region in pages, each reporting where the next begins', async () => {
		const w = window(big())
		const outline = await w.adapter.uiSnapshot('0x64')
		const list = find(outline, 'List', 'Results').ref
		const first = await w.adapter.uiSnapshot(undefined, { root: list })
		expect(first.next).toBe(60)
		const second = await w.adapter.uiSnapshot(undefined, {
			root: list,
			offset: 60,
		})
		expect(find(second, 'ListItem', 'Row 60').ref).not.toBe('')
		expect(() => find(second, 'ListItem', 'Row 59')).toThrow()
		let offset = 60
		let last = second
		while (last.next !== undefined) {
			offset = last.next
			last = await w.adapter.uiSnapshot(undefined, { root: list, offset })
		}
		expect(find(last, 'ListItem', 'Row 499').ref).not.toBe('')
		await w.adapter.dispose()
	})

	it('reads the wider tree for a region and fails closed when the region is gone', async () => {
		const w = window(big())
		const outline = await w.adapter.uiSnapshot('0x64')
		const list = find(outline, 'List', 'Results').ref
		w.state.root = page(button('Search', 'search'))
		await expect(w.adapter.uiSnapshot('0x64', { root: list })).rejects.toThrow(/STALE_REF/)
		await expect(w.adapter.uiSnapshot('0x64', { root: 'cua-ui:nope:1' })).rejects.toThrow(
			/STALE_REF/,
		)
		await w.adapter.dispose()
	})

	it('hands a query to the driver', async () => {
		const w = window(big())
		await w.adapter.uiSnapshot('0x64', { query: 'Help' })
		expect(w.state.queries.at(-1)).toMatchObject({ query: 'Help' })
		await w.adapter.dispose()
	})
})

describe('a browser tree that is not built yet', () => {
	it('is read once more when the first walk shows only the frame', async () => {
		const w = window(
			page(
				button('Go'),
				button('Back'),
				button('Reload'),
				button('Stop'),
				button('Home'),
				button('Find'),
				button('Next'),
				button('Prev'),
				button('More'),
				button('Tab'),
				button('Close'),
				button('New'),
				button('Menu'),
			),
			{
				app: 'msedge.exe',
				sparseFirst: true,
			},
		)
		const snapshot = await w.adapter.uiSnapshot('0x64')
		expect(w.state.reads).toBe(2)
		expect(find(snapshot, 'Button', 'Go').ref).not.toBe('')
		await w.adapter.dispose()
	})
})

describe('identical controls without an id', () => {
	const row = (name: string): Node => ({
		role: 'Group',
		label: name,
		children: [button('Delete')],
	})
	const deleteIn = (snapshot: UiSnapshot, rowName: string): string => {
		const group = find(snapshot, 'Group', rowName)
		return group.children?.[0]?.ref ?? ''
	}

	it('locate: a changed tree never settles identical controls by place or by the one left', () => {
		const make = (rows: string[]) =>
			toUiTree({
				elements: rows.map((_, i) => ({
					element_index: i,
					element_token: `t${i}`,
					role: 'Button',
					label: 'Delete',
					actions: ['invoke'],
				})),
				tree_markdown: [
					'- Window "W"',
					...rows.map((r, i) => `  - Group "${r}"\n    - [${i}] Button "Delete"`),
				].join('\n'),
			})
		const before = make(['A', 'B'])
		const second = before.nodes.find((n) => n.token === 't1')
		const evidence = {
			role: 'Button',
			name: 'Delete',
			path: second?.path ?? [],
			twin: true,
			treeSig: before.signature,
		}
		expect(locate(evidence, before, { actionable: true })).toMatchObject({
			kind: 'found',
		})
		// Rows swapped: the same two buttons, other places.
		expect(locate(evidence, make(['B', 'A']), { actionable: true })).toMatchObject({
			kind: 'ambiguous',
		})
		// The first row deleted: the one left is not known to be the one meant.
		expect(locate(evidence, make(['B']), { actionable: true })).toMatchObject({
			kind: 'ambiguous',
		})
	})

	it('locate: a nameless container is found by place only while it holds as many children', () => {
		const tree = toUiTree({
			elements: [],
			tree_markdown: [
				'- Window "W"',
				'  - List',
				'    - Text "a"',
				'    - Text "b"',
				'  - List',
				'    - Text "c"',
			].join('\n'),
		})
		const second = tree.nodes.filter((n) => n.role === 'List')[1]
		const base = {
			role: 'List',
			name: '',
			path: second?.path ?? [],
			twin: false,
			treeSig: 'other',
		}
		expect(locate({ ...base, childCount: 1 }, tree, { actionable: false })).toMatchObject({
			kind: 'found',
			node: { path: second?.path },
		})
		expect(locate({ ...base, childCount: 5 }, tree, { actionable: false })).toMatchObject({
			kind: 'ambiguous',
		})
	})

	it('answers AMBIGUOUS_TARGET after the rows swap, and sends nothing', async () => {
		const w = window(page(row('A'), row('B')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const deleteB = deleteIn(snapshot, 'B')
		w.state.root = page(row('B'), row('A'))
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(deleteB, 'invoke')
		expect(result).toMatchObject({
			ok: false,
			code: 'AMBIGUOUS_TARGET',
			delivery: 'not_delivered',
		})
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})

	it('answers AMBIGUOUS_TARGET when the other identical control was removed', async () => {
		const w = window(page(row('A'), row('B')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const deleteB = deleteIn(snapshot, 'B')
		w.state.root = page(row('A'))
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(deleteB, 'invoke')
		expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_TARGET' })
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})

	it('still acts on the right one when the window kept its shape', async () => {
		const w = window(page(row('A'), row('B')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const deleteB = deleteIn(snapshot, 'B')
		w.state.clock = 10_000
		await expect(w.adapter.uiAct(deleteB, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		expect(w.clicks[0]?.token).toBe(`s${w.clicks[0]?.read}:1`)
		await w.adapter.dispose()
	})

	it('keeps the places of a full read when a query snapshot comes in between', async () => {
		const w = window(page(row('A'), row('B')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const deleteB = deleteIn(snapshot, 'B')
		w.state.queryRoot = page(button('Delete'))
		await w.adapter.uiSnapshot('0x64', { query: 'Delete' })
		w.state.clock = 10_000
		await expect(w.adapter.uiAct(deleteB, 'invoke')).resolves.toMatchObject({
			ok: true,
		})
		expect(w.clicks[0]?.token).toBe(`s${w.clicks[0]?.read}:1`)
		await w.adapter.dispose()
	})
})

describe('a window handle another program reuses', () => {
	it('does not turn a ref of the old program into a ref of the new one', async () => {
		const w = window(page(button('Save', 'save')))
		const first = await w.adapter.uiSnapshot('0x64')
		const oldSave = find(first, 'Button', 'Save').ref
		w.state.pid = 8
		await w.adapter.listWindows()
		const second = await w.adapter.uiSnapshot('0x64')
		expect(find(second, 'Button', 'Save').ref).not.toBe(oldSave)
		w.state.clock = 10_000
		const result = await w.adapter.uiAct(oldSave, 'invoke')
		expect(result).toMatchObject({ ok: false })
		expect(w.clicks).toHaveLength(0)
		await w.adapter.dispose()
	})
})

describe('refs of a big match set', () => {
	it('hands out a bounded number of refs and keeps the ones it handed out', async () => {
		const many = Array.from({ length: 1_500 }, (_, i) => button(`Item ${i}`))
		const w = window(page(...many))
		w.state.queryRoot = page(...many)
		const snapshot = await w.adapter.uiSnapshot('0x64', { query: 'Item' })
		const refs = (snapshot.root.children ?? []).map((c) => c.ref).filter((r) => r !== '')
		expect(refs.length).toBeGreaterThan(0)
		expect(refs.length).toBeLessThanOrEqual(1_000)
		await expect(w.adapter.uiAct(refs[0] ?? '', 'invoke')).resolves.toMatchObject({ ok: true })
		await w.adapter.dispose()
	})
})

describe('paging an outline', () => {
	it('does not list a nameless container after the cut, so the next page does not repeat it', async () => {
		const rows = Array.from({ length: 300 }, (_, i) => ({
			role: 'ListItem',
			label: `Row ${i}`,
			actions: ['select'],
		}))
		rows.splice(200, 0, {
			role: 'Group',
			label: undefined,
			children: [button('Hidden')],
		} as never)
		const w = window(
			page(button('Search', 'search'), {
				role: 'List',
				label: 'Results',
				children: rows,
			}),
		)
		const outline = await w.adapter.uiSnapshot('0x64')
		const list = find(outline, 'List', 'Results').ref
		const first = await w.adapter.uiSnapshot(undefined, { root: list })
		expect(first.next).toBe(60)
		expect(() => find(first, 'Button', 'Hidden')).toThrow()
		await w.adapter.dispose()
	})
})

describe('an input the driver cannot confirm, judged by what the window shows', () => {
	const text = (label: string): Node => ({ role: 'Text', label })

	it('is verified when the window changed after the click and then held still', async () => {
		const result = text('none')
		const w = window(page(button('Submit'), result), {
			onClick: () => {
				result.label = 'submitted 1'
			},
		})
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(find(snapshot, 'Button', 'Submit').ref, 'invoke')
		expect(outcome).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			readBack: { observed: 'submitted 1' },
		})
		expect(outcome.detail).toContain('none')
		await w.adapter.dispose()
	})

	it('is verified by a new window of the same program, named by its title', async () => {
		const w = window(page(button('Open')), {
			onClick: () => {
				w.state.extraWindow = true
			},
		})
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(find(snapshot, 'Button', 'Open').ref, 'invoke')
		expect(outcome).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			readBack: { observed: 'Open' },
		})
		await w.adapter.dispose()
	})

	it('stays unconfirmed when nothing on the window changed', async () => {
		const w = window(page(button('Submit'), text('none')))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(find(snapshot, 'Button', 'Submit').ref, 'invoke')
		expect(outcome).toMatchObject({ ok: true, delivery: 'delivered_unverified' })
		expect(outcome.readBack).toBeUndefined()
		await w.adapter.dispose()
	})

	it('stays unconfirmed when the window was changing by itself', async () => {
		let tick = 0
		const clock = text('t0')
		const w = window(page(button('Submit'), clock))
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const submit = find(snapshot, 'Button', 'Submit').ref
		// The text differs on every read, as a clock's does.
		Object.defineProperty(clock, 'label', { get: () => `t${tick++}`, configurable: true })
		const outcome = await w.adapter.uiAct(submit, 'invoke')
		expect(outcome).toMatchObject({ ok: true, delivery: 'delivered_unverified' })
		await w.adapter.dispose()
	})
})

describe('choosing an option in a list the driver does not change', () => {
	const ran = {
		kind: 'ran',
		interfered: false,
		stopped: false,
		restoredForeground: true,
		restoredCursor: true,
		heldMs: 1_500,
	}
	const ladder = (outcome: (value: unknown) => unknown): CuaDriverAdapterOptions['foreground'] =>
		({
			run: async (_request: unknown, burst: (context: unknown) => Promise<unknown>) =>
				outcome(await burst({ checkpoint: async () => undefined })),
		}) as unknown as CuaDriverAdapterOptions['foreground']
	const combo = (): Node => ({
		role: 'ComboBox',
		label: 'Color',
		actions: ['set_value'],
		value: 'red',
	})

	it('focuses it, types the option and confirms it in one burst, then reads it back', async () => {
		const color = combo()
		const sent: string[] = []
		const w = window(page(color), {
			foreground: ladder((value) => ({ ...ran, value })),
			onTool: (call) => {
				sent.push(call.name)
				if (call.name === 'press_key') color.value = 'blue'
			},
		})
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(
			find(snapshot, 'ComboBox', 'Color').ref,
			'set_value',
			'blue',
		)
		expect(outcome).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			readBack: { observed: 'blue' },
		})
		expect(sent.filter((name) => name !== 'set_agent_cursor_enabled')).toEqual([
			'set_value',
			'type_text',
			'press_key',
		])
		expect(w.clicks).toHaveLength(1)
		expect(outcome.detail).toMatch(/put back/)
		await w.adapter.dispose()
	})

	it('names the browser tool when the keyboard does not change it either', async () => {
		const w = window(page(combo()), { foreground: ladder((value) => ({ ...ran, value })) })
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(
			find(snapshot, 'ComboBox', 'Color').ref,
			'set_value',
			'blue',
		)
		expect(outcome).toMatchObject({ ok: false, delivery: 'not_delivered' })
		expect(outcome.detail).toMatch(/browser tool/)
		await w.adapter.dispose()
	})

	it('says nothing was sent when the screen was not available', async () => {
		const w = window(page(combo()), {
			foreground: ladder(() => ({
				kind: 'blocked',
				block: { code: 'user_active', detail: 'A person is using the screen.' },
			})),
		})
		const snapshot = await w.adapter.uiSnapshot('0x64')
		const outcome = await w.adapter.uiAct(
			find(snapshot, 'ComboBox', 'Color').ref,
			'set_value',
			'blue',
		)
		expect(outcome).toMatchObject({ ok: false, delivery: 'not_delivered', retrySafety: 'safe' })
		expect(outcome.detail).toContain('A person is using the screen.')
		await w.adapter.dispose()
	})
})
