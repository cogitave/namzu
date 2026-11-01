import type { Entry, Roster, Space, Tab } from './roster.js'
import { type Dot, aggregateDot } from './status.js'
import { leaves } from './tiling.js'

export type GotoTarget =
	| { readonly kind: 'space'; readonly space: Space }
	| { readonly kind: 'tab'; readonly space: Space; readonly tab: Tab }
	| { readonly kind: 'pane'; readonly entry: Entry }

/** One line of the go-to tree: a space, one of its tabs, or one of a tab's panes. */
export interface GotoRow {
	readonly depth: 0 | 1 | 2
	readonly text: string
	readonly dot: Dot
	readonly target: GotoTarget
}

/** Every space with its tabs and each tab's panes, in the order the sidebar and tab bars show them. */
export function gotoRows(roster: Roster): GotoRow[] {
	const rows: GotoRow[] = []
	for (const space of roster.spaces) {
		rows.push({
			depth: 0,
			text: space.name,
			dot: roster.spaceDot(space),
			target: { kind: 'space', space },
		})
		space.tabs.forEach((tab, i) => {
			const panes = leaves(tab.root)
			rows.push({
				depth: 1,
				text: tab.name ?? `tab ${i + 1}`,
				dot: aggregateDot(panes.map((p) => p.dot())),
				target: { kind: 'tab', space, tab },
			})
			for (const entry of panes)
				rows.push({
					depth: 2,
					text: entry.account ? `${entry.label} · ${entry.account}` : entry.label,
					dot: entry.dot(),
					target: { kind: 'pane', entry },
				})
		})
	}
	return rows
}

/**
 * The rows that answer a typed filter: those whose text contains it (ignoring
 * case), the parents that lead to them, and everything under a space or tab that
 * matches. An empty filter keeps all.
 */
export function filterGoto(rows: readonly GotoRow[], query: string): GotoRow[] {
	const wanted = query.trim().toLowerCase()
	if (wanted === '') return [...rows]
	const own = rows.map((r) => r.text.toLowerCase().includes(wanted))
	const keep = rows.map(() => false)
	// A match keeps its whole subtree and the chain of parents above it.
	const chain: number[] = []
	rows.forEach((row, i) => {
		while (chain.length > row.depth) chain.pop()
		chain[row.depth] = i
		const underMatch = chain.slice(0, row.depth).some((at) => own[at])
		if (own[i] || underMatch) {
			keep[i] = true
			for (const at of chain.slice(0, row.depth)) keep[at] = true
		}
	})
	return rows.filter((_, i) => keep[i])
}

/** The row to start on: the focused pane's. */
export function currentRow(rows: readonly GotoRow[], entry: Entry | undefined): number {
	const at = rows.findIndex((r) => r.target.kind === 'pane' && r.target.entry === entry)
	return Math.max(0, at)
}
