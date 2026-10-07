import { describe, expect, it } from 'vitest'
import {
	type ReviewFile,
	TREE_ROOT,
	buildTree,
	emptyMessageFor,
	filterFiles,
	keyStep,
	latestReplyReceiptIds,
	mergeReceipts,
	receiptsOf,
	scopeFiles,
	stepFile,
	unifiedDiff,
} from './model.js'

const edit = (path: string, before: string, after: string) => ({
	status: 'completed' as const,
	view: { kind: 'diff' as const, path, before, after },
})
const tools = {
	a: edit('src/one.css', 'a\n', 'a\nb\n'),
	b: edit('src/one.css', 'a\nb\n', 'a\nb\nc\n'),
	c: edit('docs/new.md', '', 'x\ny\n'),
	d: edit('src/gone.ts', 'old\n', ''),
	e: edit('src/same.ts', 'k\n', 'k\n'),
	f: {
		status: 'failed' as const,
		view: { kind: 'diff' as const, path: 'x', before: '', after: 'y' },
	},
} as never
const timeline = [
	{ kind: 'tool', id: 'a', turn: 1 },
	{ kind: 'tool', id: 'b', turn: 1 },
	{ kind: 'tool', id: 'c', turn: 2 },
	{ kind: 'tool', id: 'd', turn: 2 },
	{ kind: 'tool', id: 'e', turn: 2 },
	{ kind: 'tool', id: 'f', turn: 2 },
] as never

const file = (path: string, added = 1, removed = 0): ReviewFile => ({
	path,
	status: 'modified',
	added,
	removed,
})

describe('merging receipts per path', () => {
	it('shows a file edited twice once, from the first before to the last after', () => {
		const files = mergeReceipts(receiptsOf(tools, timeline))
		const one = files.find((item) => item.path === 'src/one.css')
		expect(one).toMatchObject({ added: 2, removed: 0, status: 'modified' })
		expect(one?.content).toEqual({ before: 'a\n', after: 'a\nb\nc\n' })
		expect(files.filter((item) => item.path === 'src/one.css')).toHaveLength(1)
	})

	it('classifies new and deleted files and drops edits that cancel out and failed calls', () => {
		const files = mergeReceipts(receiptsOf(tools, timeline))
		expect(files.map((item) => [item.path, item.status])).toEqual([
			['src/one.css', 'modified'],
			['docs/new.md', 'added'],
			['src/gone.ts', 'deleted'],
		])
	})
})

describe('scope selection', () => {
	it('uses the latest reply that changed files, or the reply that was opened', () => {
		const thread = { tools, timeline }
		expect(latestReplyReceiptIds(thread)).toEqual(['c', 'd'])
		expect(scopeFiles('reply', { tools, timeline }).map((item) => item.path)).toEqual([
			'docs/new.md',
			'src/gone.ts',
		])
		expect(
			scopeFiles('reply', { tools, timeline, receiptIds: ['a', 'b'] }).map((item) => item.path),
		).toEqual(['src/one.css'])
		expect(scopeFiles('conversation', { tools, timeline })).toHaveLength(3)
	})

	it('has no latest reply without a timeline', () => {
		expect(scopeFiles('reply', { tools })).toEqual([])
	})

	it('words each empty state', () => {
		expect(emptyMessageFor('reply', true)).toBe('No changes in the last reply.')
		expect(emptyMessageFor('conversation', true)).toContain('hasn’t changed files')
		expect(emptyMessageFor('uncommitted', true)).toBe('No uncommitted changes.')
		expect(emptyMessageFor('uncommitted', false)).toBe('This project is not a git repository.')
	})
})

describe('tree building', () => {
	it('puts folders first and compresses chains of single-child folders', () => {
		const tree = buildTree([
			file('.work/sessions/ses_1/design.md'),
			file('.work/sessions/ses_1/progress.md'),
			file('.work/sessions/README.md'),
			file('docs/README.md'),
			file('docs/guide/a.md'),
			file('top.txt'),
		])
		const top = tree.nodes.get(TREE_ROOT)?.children.map((id) => tree.nodes.get(id)?.name)
		expect(top).toEqual(['.work/sessions', 'docs', 'top.txt'])
		expect(tree.order).toEqual([
			'.work/sessions/ses_1/design.md',
			'.work/sessions/ses_1/progress.md',
			'.work/sessions/README.md',
			'docs/guide/a.md',
			'docs/README.md',
			'top.txt',
		])
		expect(tree.folders).toEqual(['.work/sessions', '.work/sessions/ses_1', 'docs', 'docs/guide'])
	})

	it('filters by fuzzy path match', () => {
		const files = [file('src/sidebar.css'), file('src/rail.css'), file('docs/log.md')]
		expect(filterFiles(files, 'rail').map((item) => item.path)).toEqual(['src/rail.css'])
		expect(filterFiles(files, '  ')).toHaveLength(3)
		expect(filterFiles(files, 'zzzz')).toEqual([])
	})

	it('steps through files and wraps', () => {
		const order = ['a', 'b', 'c']
		expect(stepFile(order, 'a', 1)).toBe('b')
		expect(stepFile(order, 'c', 1)).toBe('a')
		expect(stepFile(order, 'a', -1)).toBe('c')
		expect(stepFile(order, undefined, 1)).toBe('a')
		expect(stepFile([], 'a', 1)).toBeUndefined()
	})
})

describe('copying a diff', () => {
	it('writes a unified diff with context', () => {
		const text = unifiedDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\n')
		expect(text).toContain('--- a/f.txt')
		expect(text).toContain('+++ b/f.txt')
		expect(text).toContain('-b\n+B\n')
		expect(text).toContain(' a\n')
	})
	it('marks a new file as from nothing', () => {
		expect(unifiedDiff('n.txt', '', 'x\n')).toContain('--- /dev/null')
	})
})

describe('stepping keys', () => {
	const key = (name: string, extra: Partial<Parameters<typeof keyStep>[0]> = {}) =>
		keyStep({
			key: name,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			...extra,
		})
	it('steps with brackets and Alt+arrows', () => {
		expect([
			key(']'),
			key('['),
			key('ArrowDown', { altKey: true }),
			key('ArrowUp', { altKey: true }),
		]).toEqual([1, -1, 1, -1])
	})
	it('leaves plain arrows and Cmd or Ctrl combinations alone', () => {
		expect([key('ArrowDown'), key(']', { metaKey: true }), key('[', { ctrlKey: true })]).toEqual([
			0, 0, 0,
		])
	})
})

describe('anonymous receipts', () => {
	it('gives each pathless receipt a file name of its own', () => {
		const files = mergeReceipts([
			{ id: 'a', path: '', before: '', after: 'x\n' },
			{ id: 'b', path: '', before: '', after: 'y\n' },
		] as never)
		expect(files.map((item) => item.path)).toEqual(['File', 'File (2)'])
	})
})
