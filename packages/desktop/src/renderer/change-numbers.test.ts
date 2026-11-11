import { describe, expect, it } from 'vitest'
import type { ThreadState } from '../shared/projection.js'
import type { PermissionView } from '../shared/protocol.js'
import { buildApprovalCard } from './approval-card-model.js'
import { scopeFiles, totalsOf } from './changes-review/model.js'
import { CUT_NOTE } from './changes-totals.js'
import { toolTranscriptPresentation } from './tool-transcript-presentation.js'
import { turnChanges } from './turn-changes.js'

type Tools = ThreadState['tools']
type Tool = Tools[string]

/** A finished edit as the engine reports it: the hunk sides as the receipt, its own counts as facts. */
function edit(
	path: string,
	before: string,
	after: string,
	added: number,
	removed: number,
	extra: { cut?: true } = {},
): Tool {
	return {
		kind: 'tool_call',
		toolCallId: 'call-x',
		title: 'edit',
		status: 'completed',
		view: { kind: 'diff', path, before, after },
		facts: {
			kind: 'edit',
			path,
			added,
			removed,
			...(extra.cut ? { hunksTruncated: true as const } : {}),
		},
	} as unknown as Tool
}

function thread(tools: Tools): Pick<ThreadState, 'timeline' | 'tools'> {
	return {
		tools,
		timeline: Object.keys(tools).map((id) => ({ kind: 'tool' as const, id, turn: 1 })),
	} as unknown as Pick<ThreadState, 'timeline' | 'tools'>
}

function approval(path: string, before: string, after: string, truncated = false) {
	const request: PermissionView = {
		id: 'p',
		sessionId: 's',
		projectId: 'j',
		calls: [
			{
				id: 'c',
				name: 'write',
				input: { path },
				isDestructive: false,
				preview: { path, before, after, ...(truncated ? { truncated: true } : {}) },
			},
		],
	}
	return buildApprovalCard(request)
}

describe('one change number', () => {
	it('a file edited twice reads +2 -2 on the card, in the panel and on each edit row', () => {
		const tools: Tools = {
			e1: edit('cart.js', 'total = a\n', 'total = b\n', 1, 1),
			e2: edit('cart.js', 'tax = c\n', 'tax = d\n', 1, 1),
		}
		const t = thread(tools)
		const card = turnChanges(t).get(1)
		expect(card).toMatchObject({ added: 2, removed: 2 })
		expect(card?.files[0]).toMatchObject({ added: 2, removed: 2 })
		const [file] = scopeFiles('conversation', t)
		expect(file).toMatchObject({ path: 'cart.js', added: 2, removed: 2 })
		expect(totalsOf([file as NonNullable<typeof file>])).toMatchObject({ added: 2, removed: 2 })
	})

	it('the panel keeps each edit with its own sides for the diff view', () => {
		const t = thread({
			e1: edit('cart.js', 'total = a\n', 'total = b\n', 1, 1),
			e2: edit('cart.js', 'tax = c\n', 'tax = d\n', 1, 1),
		})
		const [file] = scopeFiles('reply', { ...t, receiptIds: ['e1', 'e2'] })
		expect(file?.edits).toEqual([
			{ before: 'total = a\n', after: 'total = b\n', added: 1, removed: 1 },
			{ before: 'tax = c\n', after: 'tax = d\n', added: 1, removed: 1 },
		])
	})

	it('a three-file change agrees across the card, the panel and the approval', () => {
		const a = ['one\n', 'two\n']
		const tools: Tools = {
			a1: edit('a.ts', a[0] as string, 'ONE\n', 1, 1),
			a2: edit('a.ts', 'x\n', 'y\nz\n', 2, 1),
			b1: edit('b.ts', '', 'p\nq\nr\n', 3, 0),
			c1: edit('c.ts', 'gone\n', '', 0, 1),
		}
		const t = thread(tools)
		const card = turnChanges(t).get(1)
		const panel = totalsOf(scopeFiles('reply', { ...t, receiptIds: Object.keys(tools) }))
		expect(card).toMatchObject({ added: 6, removed: 3 })
		expect(panel).toMatchObject({ added: 6, removed: 3 })
		// The approval for the one write that makes b.ts reads what the card reads for it.
		const pending = approval('b.ts', '', 'p\nq\nr\n')
		expect(pending).toMatchObject({ added: 3, removed: 0 })
		expect(card?.files.find((file) => file.name === 'b.ts')).toMatchObject({
			added: pending.added,
			removed: pending.removed,
		})
		// Each edit row reads its own engine count.
		const rows = Object.keys(tools).map((id) => {
			const state = {
				...t,
				turns: {},
				running: false,
			} as unknown as ThreadState
			return toolTranscriptPresentation(state, id)?.stats
		})
		expect(rows).toEqual([
			{ added: 1, removed: 1 },
			{ added: 2, removed: 1 },
			{ added: 3, removed: 0 },
			{ added: 0, removed: 1 },
		])
	})

	it('a cut diff keeps the true total and says it is cut', () => {
		const t = thread({ w: edit('big.ts', '', 'a\nb\n', 477, 0, { cut: true }) })
		const card = turnChanges(t).get(1)
		expect(card).toMatchObject({ added: 477, removed: 0, cut: true })
		const [file] = scopeFiles('conversation', t)
		expect(file).toMatchObject({ added: 477, cut: true })
		expect(totalsOf([file as NonNullable<typeof file>])).toMatchObject({ added: 477, cut: true })
		expect(CUT_NOTE).toBe('First 400 lines shown')
		// A preview the engine cut says so beside its number, which stays the one it computed.
		expect(approval('big.ts', '', 'a\nb\n', true)).toMatchObject({ added: 2, cut: true })
		expect(approval('big.ts', '', 'a\nb\n')).not.toHaveProperty('cut')
	})

	it('a rewritten file counts its own removed and added lines', () => {
		const rewritten: Tool = {
			...edit('page.md', 'old\nlines\nhere\n', 'brand\nnew\n', 2, 3),
			facts: { kind: 'write', path: 'page.md', operation: 'updated', added: 2, removed: 3 },
		} as unknown as Tool
		const card = turnChanges(thread({ w: rewritten })).get(1)
		expect(card?.files[0]).toMatchObject({ added: 2, removed: 3 })
	})

	it('an older saved edit without engine counts is compared from its own sides', () => {
		const old = {
			...edit('a.ts', 'a\n', 'a\nb\n', 1, 0),
			facts: undefined,
		} as unknown as Tool
		expect(turnChanges(thread({ o: old })).get(1)).toMatchObject({ added: 1, removed: 0 })
	})
})
