import type { AcpSessionUpdate } from '@namzu/sdk'
import { parseDiffFromFile } from '@pierre/diffs'
import type { ThreadState } from '../../shared/projection.js'
import type { ProjectChangeFile } from '../../shared/protocol.js'
import { changeTotals } from '../changes-totals.js'
import { prepareIndex, searchFiles } from '../file-panel/file-search.js'
import { baseNameOf } from '../file-panel/project-refs.js'
import { turnChanges } from '../turn-changes.js'

type Tool = Extract<AcpSessionUpdate, { kind: 'tool_call' }>

export type ReviewScope = 'reply' | 'conversation' | 'uncommitted'
export type ReviewStatus = ProjectChangeFile['status']

/** One changed file as the review shows it, whichever scope it came from. */
export interface ReviewFile {
	path: string
	oldPath?: string
	status: ReviewStatus
	added: number
	removed: number
	/** A renamed file whose content is not text. */
	binary?: true
	/** Receipts carry their text; a working-tree file is read when it is selected. */
	content?: { before: string; after: string }
}

export interface Receipt {
	id: string
	path: string
	before?: string
	after?: string
}

/** Completed diff receipts in the order the work happened, optionally only some of them. */
export function receiptsOf(
	tools: Record<string, Tool>,
	timeline?: ThreadState['timeline'],
	only?: readonly string[],
): Receipt[] {
	const ids = timeline
		? timeline.filter((entry) => entry.kind === 'tool').map((entry) => entry.id)
		: Object.keys(tools)
	const wanted = only ? new Set(only) : undefined
	const receipts: Receipt[] = []
	for (const id of ids) {
		if (wanted && !wanted.has(id)) continue
		const view = tools[id]?.status === 'completed' ? tools[id]?.view : undefined
		if (view?.kind !== 'diff') continue
		receipts.push({
			id,
			path: view.path || view.label || '',
			before: view.before,
			after: view.after,
		})
	}
	return receipts
}

/**
 * One entry per path, from the first `before` to the last `after`, so a file edited twice is one
 * row. A path whose edits cancel out is left out.
 */
export function mergeReceipts(receipts: readonly Receipt[]): ReviewFile[] {
	const byPath = new Map<string, Receipt[]>()
	let anonymous = 0
	// Receipts without a path each get a name of their own, or they would share one tree node.
	const anonymousName = (key: string) => {
		const n = Number(key.slice('receipt:'.length)) + 1
		return n === 1 ? 'File' : `File (${n})`
	}
	for (const receipt of receipts) {
		const key = receipt.path || `receipt:${anonymous++}`
		const list = byPath.get(key)
		if (list) list.push(receipt)
		else byPath.set(key, [receipt])
	}
	const files: ReviewFile[] = []
	for (const [key, list] of byPath) {
		const first = list[0]
		const last = list[list.length - 1]
		if (!first || !last) continue
		const totals = changeTotals(list)
		if (totals.files === 0) continue
		const before = first.before ?? ''
		const after = last.after ?? ''
		files.push({
			path: key.startsWith('receipt:') ? anonymousName(key) : key,
			status: !before && after ? 'added' : before && !after ? 'deleted' : 'modified',
			added: totals.added,
			removed: totals.removed,
			content: { before, after },
		})
	}
	return files
}

/** The receipts of the latest reply that changed files; empty when none did. */
export function latestReplyReceiptIds(thread: Pick<ThreadState, 'timeline' | 'tools'>): string[] {
	let latest: { turn: number; receiptIds: string[] } | undefined
	for (const changes of turnChanges(thread).values())
		if (!latest || changes.turn > latest.turn) latest = changes
	return latest?.receiptIds ?? []
}

export function scopeFiles(
	scope: Exclude<ReviewScope, 'uncommitted'>,
	input: {
		tools: Record<string, Tool>
		timeline?: ThreadState['timeline']
		/** The reply the person opened; absent means the latest one. */
		receiptIds?: readonly string[]
	},
): ReviewFile[] {
	if (scope === 'conversation') return mergeReceipts(receiptsOf(input.tools, input.timeline))
	const ids =
		input.receiptIds ??
		(input.timeline
			? latestReplyReceiptIds({ timeline: input.timeline, tools: input.tools })
			: undefined)
	return ids ? mergeReceipts(receiptsOf(input.tools, input.timeline, ids)) : []
}

export function totalsOf(files: readonly ReviewFile[]): {
	added: number
	removed: number
} {
	return {
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	}
}

export interface TreeNode {
	id: string
	name: string
	kind: 'dir' | 'file'
	children: string[]
	file?: ReviewFile
}
export interface ReviewTree {
	nodes: Map<string, TreeNode>
	/** Files in the order the tree shows them, for previous and next. */
	order: string[]
	/** Every folder, for expanding all of them. */
	folders: string[]
}
export const TREE_ROOT = ''

/** Folders first, then files; a chain of folders with one child each shows as one row. */
export function buildTree(files: readonly ReviewFile[]): ReviewTree {
	const nodes = new Map<string, TreeNode>()
	nodes.set(TREE_ROOT, { id: TREE_ROOT, name: '', kind: 'dir', children: [] })
	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean)
		let parent = TREE_ROOT
		parts.forEach((part, index) => {
			const id = parts.slice(0, index + 1).join('/')
			const leaf = index === parts.length - 1
			let node = nodes.get(id)
			if (!node) {
				node = leaf
					? { id, name: part, kind: 'file', children: [], file }
					: { id, name: part, kind: 'dir', children: [] }
				nodes.set(id, node)
				nodes.get(parent)?.children.push(id)
			}
			parent = id
		})
	}
	const sort = (node: TreeNode) => {
		node.children.sort((a, b) => {
			const left = nodes.get(a)
			const right = nodes.get(b)
			if (!left || !right) return 0
			if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
			return left.name.localeCompare(right.name)
		})
		for (const id of node.children) {
			const child = nodes.get(id)
			if (child?.kind === 'dir') sort(child)
		}
	}
	const root = nodes.get(TREE_ROOT)
	if (root) sort(root)
	// A folder whose only child is a folder takes that child's place, named with both.
	const compress = (id: string): string => {
		const node = nodes.get(id)
		if (!node || node.kind === 'file') return id
		node.children = node.children.map(compress)
		const [only] = node.children
		const child = only && node.children.length === 1 ? nodes.get(only) : undefined
		if (id === TREE_ROOT || child?.kind !== 'dir') return id
		nodes.delete(id)
		child.name = `${node.name}/${child.name}`
		return child.id
	}
	if (root) root.children = root.children.map(compress)
	const order: string[] = []
	const folders: string[] = []
	const walk = (id: string) => {
		const node = nodes.get(id)
		if (!node) return
		if (node.kind === 'file') order.push(id)
		else if (id !== TREE_ROOT) folders.push(id)
		for (const child of node.children) walk(child)
	}
	walk(TREE_ROOT)
	return { nodes, order, folders }
}

/** Files whose path matches the query, best first; no query keeps them all. */
export function filterFiles(files: readonly ReviewFile[], query: string): ReviewFile[] {
	if (!query.trim()) return [...files]
	const byPath = new Map(files.map((file) => [file.path, file]))
	return searchFiles(prepareIndex([...byPath.keys()]), query, files.length).flatMap((hit) => {
		const file = byPath.get(hit.path)
		return file ? [file] : []
	})
}

/** The file one step from `current` in tree order, wrapping at both ends. */
export function stepFile(order: readonly string[], current: string | undefined, step: 1 | -1) {
	if (order.length === 0) return undefined
	const at = current ? order.indexOf(current) : -1
	if (at < 0) return order[step === 1 ? 0 : order.length - 1]
	return order[(at + step + order.length) % order.length]
}

export const nameOf = baseNameOf

/** A unified diff of the whole change, for the clipboard. */
export function unifiedDiff(path: string, before: string, after: string, oldPath = path): string {
	const meta = parseDiffFromFile(
		{ name: oldPath, contents: before },
		{ name: path, contents: after },
	)
	const out = [
		`--- ${before ? `a/${oldPath}` : '/dev/null'}`,
		`+++ ${after ? `b/${path}` : '/dev/null'}`,
	]
	const line = (text: string | undefined) => (text ?? '').replace(/\r?\n$/, '')
	for (const hunk of meta.hunks) {
		out.push(
			`@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
		)
		for (const part of hunk.hunkContent) {
			if (part.type === 'context') {
				for (let i = 0; i < part.lines; i++)
					out.push(` ${line(meta.additionLines[part.additionLineIndex + i])}`)
			} else {
				for (let i = 0; i < part.deletions; i++)
					out.push(`-${line(meta.deletionLines[part.deletionLineIndex + i])}`)
				for (let i = 0; i < part.additions; i++)
					out.push(`+${line(meta.additionLines[part.additionLineIndex + i])}`)
			}
		}
	}
	return `${out.join('\n')}\n`
}

/** What an empty scope says. */
export function emptyMessageFor(scope: ReviewScope, repository: boolean): string {
	if (scope === 'reply') return 'No changes in the last reply.'
	if (scope === 'conversation') return 'This conversation hasn’t changed files yet.'
	return repository ? 'No uncommitted changes.' : 'This project is not a git repository.'
}

/** Which way a key steps between files: `]` or Alt+Down forward, `[` or Alt+Up back; 0 for anything else. */
export function keyStep(event: {
	key: string
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
}): 1 | -1 | 0 {
	// Cmd or Ctrl with a bracket belongs to the app or the system, not to this view.
	if (event.ctrlKey || event.metaKey) return 0
	if (event.key === ']' || (event.altKey && event.key === 'ArrowDown')) return 1
	if (event.key === '[' || (event.altKey && event.key === 'ArrowUp')) return -1
	return 0
}
