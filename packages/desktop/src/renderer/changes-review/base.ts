import type { ProjectCompareBase } from '../../shared/protocol.js'

/** What the Changes pane compares against. Each conversation keeps its own. */
export type ChangesBase =
	| { kind: 'all' }
	| { kind: 'uncommitted' }
	| { kind: 'branch'; ref: string }
	| { kind: 'commit'; sha: string; subject?: string }

export interface BaseContext {
	/** The folder is a repository the pane may read. */
	repository: boolean
	/** The branch "All changes" is measured against; none when the repository has no usual one. */
	defaultBranch: string | null
}

/** Where a base's files come from. */
export type BaseSource =
	| { via: 'receipts' }
	| { via: 'host' }
	| { via: 'compare'; base: ProjectCompareBase }

export const DEFAULT_BASE: ChangesBase = { kind: 'all' }

/** The base in effect: a base that needs a repository falls back to the conversation's own edits. */
export function effectiveBase(
	base: ChangesBase,
	context: BaseContext,
): ChangesBase | 'conversation' {
	if (!context.repository) return 'conversation'
	if (base.kind === 'all' && !context.defaultBranch) return { kind: 'uncommitted' }
	return base
}

export function sourceOf(base: ChangesBase, context: BaseContext): BaseSource {
	const base2 = effectiveBase(base, context)
	if (base2 === 'conversation') return { via: 'receipts' }
	switch (base2.kind) {
		case 'uncommitted':
			return { via: 'host' }
		case 'all':
			return { via: 'compare', base: { kind: 'branch', ref: context.defaultBranch as string } }
		case 'branch':
			return { via: 'compare', base: { kind: 'branch', ref: base2.ref } }
		case 'commit':
			return { via: 'compare', base: { kind: 'commit', sha: base2.sha } }
	}
}

export interface ChipLabel {
	/** The branch or commit side, absent for the conversation's own edits. */
	from?: string
	/** The other side; absent when the whole label is one phrase. */
	to?: string
	text: string
}

export function chipLabel(base: ChangesBase, context: BaseContext): ChipLabel {
	const used = effectiveBase(base, context)
	if (used === 'conversation') return { text: 'Conversation edits' }
	if (used.kind === 'commit') {
		const from = used.sha.slice(0, 7)
		return { from, to: 'working tree', text: `${from} → working tree` }
	}
	const from =
		used.kind === 'branch'
			? used.ref
			: used.kind === 'all'
				? (context.defaultBranch as string)
				: 'HEAD'
	return { from, to: 'working tree', text: `${from} → working tree` }
}

export interface BaseRow {
	id: 'all' | 'uncommitted' | 'conversation'
	label: string
	hint?: string
	checked: boolean
}

/** The radio rows at the top of the base menu; "Compare against" follows them when it can. */
export function baseRows(
	base: ChangesBase,
	context: BaseContext,
): {
	rows: BaseRow[]
	compare: boolean
} {
	if (!context.repository)
		return {
			rows: [{ id: 'conversation', label: 'Conversation edits', checked: true }],
			compare: false,
		}
	const used = effectiveBase(base, context)
	const kind = used === 'conversation' ? 'conversation' : used.kind
	const rows: BaseRow[] = []
	if (context.defaultBranch)
		rows.push({
			id: 'all',
			label: 'All changes',
			hint: `vs ${context.defaultBranch}`,
			checked: kind === 'all',
		})
	rows.push({ id: 'uncommitted', label: 'Uncommitted changes', checked: kind === 'uncommitted' })
	return { rows, compare: true }
}

/** Branches matching what was typed, the default branch and the current one first. */
export function matchBranches<T extends { name: string }>(
	branches: readonly T[],
	query: string,
	pinned: readonly (string | null)[],
): T[] {
	const text = query.trim().toLowerCase()
	const hits = branches.filter((branch) => !text || branch.name.toLowerCase().includes(text))
	const rank = (name: string) => {
		const at = pinned.indexOf(name)
		return at < 0 ? pinned.length : at
	}
	return hits
		.map((branch, index) => ({ branch, index }))
		.sort((a, b) => rank(a.branch.name) - rank(b.branch.name) || a.index - b.index)
		.map((item) => item.branch)
}

/** Commits whose subject, or whose hash from seven characters, matches what was typed. */
export function matchCommits<T extends { sha: string; short: string; subject: string }>(
	commits: readonly T[],
	query: string,
): T[] {
	const text = query.trim().toLowerCase()
	if (!text) return [...commits]
	return commits.filter(
		(commit) =>
			commit.subject.toLowerCase().includes(text) ||
			commit.short.toLowerCase().startsWith(text) ||
			(text.length >= 7 && commit.sha.toLowerCase().startsWith(text)),
	)
}

/** A picked branch that is the usual one is the same as "All changes". */
export function normaliseChoice(base: ChangesBase, context: BaseContext): ChangesBase {
	return base.kind === 'branch' && context.defaultBranch && base.ref === context.defaultBranch
		? { kind: 'all' }
		: base
}

/** The ref or short hash a "Compare against" pick names, or null when a plain row is active. */
export function compareHint(base: ChangesBase, context: BaseContext): string | null {
	const used = effectiveBase(base, context)
	if (used === 'conversation') return null
	if (used.kind === 'branch') return used.ref
	if (used.kind === 'commit') return used.sha.slice(0, 7)
	return null
}
