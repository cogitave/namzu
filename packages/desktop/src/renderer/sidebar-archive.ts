import type { ConversationView } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'

/** Which list the sidebar's second section shows: the recent conversations or the archived ones. */
export type ArchiveView = 'recents' | 'archived'

export type ArchiveLoad =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ready'; rows: ConversationView[]; unreadable: number }

// An unparseable date is the oldest, so one bad row cannot make the order undefined.
const stamp = (value: string) => Date.parse(value) || 0

/** Archived rows from every project in one list, each once, the most recently touched first. */
export function archivedRows(rows: readonly ConversationView[]): ConversationView[] {
	return [...new Map(rows.map((row) => [row.id, row])).values()].sort(
		(a, b) => stamp(b.updatedAt) - stamp(a.updatedAt),
	)
}

/** The archive of every given project, read at once; one that cannot be read is counted, not fatal. */
export async function loadArchived(
	list: (projectId: string) => Promise<ConversationView[]>,
	projects: readonly { id: string }[],
): Promise<ArchiveLoad> {
	const results = await Promise.allSettled(
		projects.map((project) =>
			list(project.id).then((rows) => rows.map((row) => ({ ...row, projectId: project.id }))),
		),
	)
	const unreadable = results.filter((result) => result.status === 'rejected').length
	if (unreadable === results.length && results.length > 0) {
		const first = results.find((result) => result.status === 'rejected')
		const reason = first?.status === 'rejected' ? first.reason : undefined
		return { status: 'error', message: plainErrorText(reason, 'load the archived conversations') }
	}
	const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
	return { status: 'ready', rows: archivedRows(rows), unreadable }
}

/** The list after a conversation was archived here: it leads, without waiting for another read. */
export function withArchived(load: ArchiveLoad, view: ConversationView): ArchiveLoad {
	const rows = load.status === 'ready' ? load.rows : []
	return {
		status: 'ready',
		rows: archivedRows([view, ...rows]),
		unreadable: load.status === 'ready' ? load.unreadable : 0,
	}
}

/** The list after a conversation came back from the archive. */
export function withoutArchived(load: ArchiveLoad, id: string): ArchiveLoad {
	return load.status === 'ready'
		? { ...load, rows: load.rows.filter((row) => row.id !== id) }
		: load
}

/**
 * The section shows while there is something to look at in either view, and always while the
 * archived view is on, so the way back to Recents never disappears under the person.
 */
export function archiveSectionVisible(options: {
	view: ArchiveView
	recents: number
	archived: number
}): boolean {
	return options.view === 'archived' || options.recents > 0 || options.archived > 0
}

export function archiveHeading(view: ArchiveView): string {
	return view === 'archived' ? 'Archived' : 'Recents'
}

export function archiveToggleLabel(view: ArchiveView): string {
	return view === 'archived' ? 'Back to recents' : 'Show archived conversations'
}

export function nextArchiveView(view: ArchiveView): ArchiveView {
	return view === 'archived' ? 'recents' : 'archived'
}

/** The sentence for a list with no rows, or an empty string while it has some or is still loading. */
export function archiveEmptyText(options: {
	view: ArchiveView
	load: ArchiveLoad
	recents: number
}): string {
	if (options.view === 'archived')
		return options.load.status === 'ready' && options.load.rows.length === 0
			? 'Nothing is archived.'
			: ''
	return options.recents === 0 ? 'No recent conversations.' : ''
}
