import type { ConversationView, ProjectView } from '../shared/protocol.js'
import {
	SIDEBAR_SNAPSHOT_CONVERSATIONS,
	SIDEBAR_SNAPSHOT_PER_PROJECT,
	type SidebarConversationRow,
} from '../shared/sidebar-snapshot.js'
import { compareConversationOrder } from './conversation-order.js'

/** A refreshed project keeps its place; one that is new to the list follows the others. */
export function replaceProject(items: readonly ProjectView[], item: ProjectView): ProjectView[] {
	return items.some((row) => row.id === item.id)
		? items.map((row) => (row.id === item.id ? item : row))
		: [...items, item]
}

/** How a project's conversation list went this session. A project that is absent has not answered. */
export type ListOutcome = 'listed' | 'failed'

/** The rows worth drawing again on the next start: each project's newest, newest first. */
export function snapshotConversations(
	rows: readonly ConversationView[],
	projects: readonly ProjectView[],
): SidebarConversationRow[] {
	const usable = new Set(projects.filter((item) => !item.missing).map((item) => item.id))
	const taken = new Map<string, number>()
	const kept: SidebarConversationRow[] = []
	for (const row of [...rows].sort(compareConversationOrder)) {
		if (kept.length >= SIDEBAR_SNAPSHOT_CONVERSATIONS) break
		if (!usable.has(row.projectId)) continue
		const count = taken.get(row.projectId) ?? 0
		if (count >= SIDEBAR_SNAPSHOT_PER_PROJECT) continue
		taken.set(row.projectId, count + 1)
		const { id, projectId, title, updatedAt, palId, harness, pinned } = row
		kept.push({
			id,
			projectId,
			title,
			updatedAt,
			...(palId ? { palId } : {}),
			...(harness ? { harness } : {}),
			...(pinned ? { pinned } : {}),
		})
	}
	return kept
}

/**
 * The live rows, plus the remembered rows of every project whose own list has not arrived yet.
 * Once a project answers, its live rows replace its remembered ones, so a conversation that is
 * gone leaves and a title that changed is replaced in place. A remembered row never decides
 * whether anything exists: callers that do read the live rows only.
 */
export function withRememberedRows(
	live: readonly ConversationView[],
	remembered: readonly ConversationView[],
	lists: ReadonlyMap<string, ListOutcome>,
	projects: readonly ProjectView[],
	gone: { conversations: ReadonlySet<string>; projects: ReadonlySet<string> },
): ConversationView[] {
	if (remembered.length === 0) return [...live]
	const liveIds = new Set(live.map((item) => item.id))
	const owners = new Map(projects.map((item) => [item.id, item]))
	const waiting = remembered.filter((row) => {
		if (liveIds.has(row.id) || gone.conversations.has(row.id) || gone.projects.has(row.projectId))
			return false
		if (lists.get(row.projectId) === 'listed') return false
		const owner = owners.get(row.projectId)
		if (!owner || owner.missing) return false
		// Still on its way, or connected and being listed. One that failed or lost trust has nothing to show.
		return owner.status === 'connecting' || (owner.status === 'ready' && owner.trusted)
	})
	return [...live, ...waiting]
}

/**
 * The rows to write for the next start: those drawn, plus the remembered rows of a project whose
 * list failed this session. A failed read says nothing about what the project holds, so what was
 * remembered stays instead of vanishing from the next first frame.
 */
export function rowsToRemember(
	drawn: readonly ConversationView[],
	remembered: readonly ConversationView[],
	lists: ReadonlyMap<string, ListOutcome>,
	gone: { conversations: ReadonlySet<string>; projects: ReadonlySet<string> },
): ConversationView[] {
	const ids = new Set(drawn.map((item) => item.id))
	return [
		...drawn,
		...remembered.filter(
			(row) =>
				lists.get(row.projectId) === 'failed' &&
				!ids.has(row.id) &&
				!gone.conversations.has(row.id) &&
				!gone.projects.has(row.projectId),
		),
	]
}

/** The sort keys a background list delivered, by conversation. */
export type DeliveredKeys = ReadonlyMap<string, { pinned: boolean; updatedAt: string }>

/**
 * Nothing already on screen moves because data arrived. While the start is still reconciling,
 * a row that is shown keeps the place it was shown in unless a person changed it (a background
 * list that only repeats its earlier keys does not count), and a row that a background list
 * delivered and that was not shown appears only where it moves no shown row: below the last
 * one, or anywhere once nothing is shown. When the start is over, everything falls into its
 * sorted place at once. Rows a person made, pinned or renamed arrive with keys the list never
 * delivered, so they take effect at once. `rows` need not be sorted; the result is.
 */
export function stableConversationRows(
	rows: readonly ConversationView[],
	shown: readonly ConversationView[],
	delivered: DeliveredKeys,
	settled: boolean,
): ConversationView[] {
	const ordered = [...rows].sort(compareConversationOrder)
	if (settled || shown.length === 0) return ordered
	const shownById = new Map(shown.map((item) => [item.id, item]))
	const frozen = rows.map((row) => {
		const before = shownById.get(row.id)
		const keys = delivered.get(row.id)
		if (
			!before ||
			!keys ||
			keys.updatedAt !== row.updatedAt ||
			keys.pinned !== (row.pinned === true)
		)
			return row
		const { pinned: _pinned, ...rest } = row
		return {
			...rest,
			updatedAt: before.updatedAt,
			...(before.pinned ? { pinned: true as const } : {}),
		}
	})
	const sorted = frozen.sort(compareConversationOrder)
	const last = [...sorted].reverse().find((row) => shownById.has(row.id))
	if (!last) return sorted
	return sorted.filter(
		(row) =>
			shownById.has(row.id) || !delivered.has(row.id) || compareConversationOrder(row, last) > 0,
	)
}
