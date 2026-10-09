import { compareVersions } from '../shared/engine-update-protocol.js'
import type {
	EngineUpdateId,
	EngineUpdateItem,
	EngineUpdatesState,
} from '../shared/engine-update-protocol.js'

/** What one row of Settings ▸ Updates shows, decided from the item alone so a test can read it. */
export interface EngineRowView {
	title: string
	/** `0.154.0 → 0.162.0`, `0.162.0`, or a plain statement when nothing is known. */
	versions: string
	/** The state in words, also read to a screen reader. */
	status: string
	tone: 'neutral' | 'attention' | 'error'
	/** The muted line: how it was installed, or why Namzu does not run the update. */
	note: string
	/** The button the state calls for. `copy` shows the command instead of running it. */
	action?: 'update' | 'retry' | 'copy'
	/** The command a click runs or a person copies. */
	command?: string
	/** The button is busy and cannot be pressed again. */
	busy: boolean
}

export function engineRowView(item: EngineUpdateItem): EngineRowView {
	// The command line that comes with the app is the one About lists; a copy installed on its own
	// is a different program with its own version, and the row says so.
	const title =
		item.id === 'namzu-cli' && !item.bundled && !item.missing
			? `${item.name} (installed separately)`
			: item.name
	if (item.missing)
		return {
			title,
			versions: 'Not installed',
			status: 'Not installed',
			tone: 'neutral',
			note: 'Namzu does not install it. Install it first to use it from Namzu.',
			busy: false,
		}
	const versions =
		item.installed && item.latest && item.status === 'available'
			? `${item.installed} → ${item.latest}`
			: (item.installed ?? 'Version unknown')
	const base = item.note ?? ''
	const note = [
		base,
		item.updated ? 'Open conversations use the new version after they restart.' : '',
	]
		.filter(Boolean)
		.join(' · ')
	const copy = Boolean(item.command) && (!item.runnable || /administrator/iu.test(item.error ?? ''))
	switch (item.status) {
		case 'updating':
			return {
				title,
				versions,
				status: 'Updating…',
				tone: 'neutral',
				note: 'The update is running in its own terminal tab.',
				busy: true,
			}
		case 'available':
			return {
				title,
				versions,
				status: 'Update available',
				tone: 'attention',
				note,
				action: copy ? 'copy' : 'update',
				...(item.command ? { command: item.command } : {}),
				busy: false,
			}
		case 'failed':
			return {
				title,
				versions,
				status: 'Update failed',
				tone: 'error',
				note: item.error ?? `${item.name} update failed. The terminal tab shows why.`,
				action: copy ? 'copy' : 'retry',
				...(item.command ? { command: item.command } : {}),
				busy: false,
			}
		case 'current':
			return { title, versions, status: 'Up to date', tone: 'neutral', note, busy: false }
		default:
			return {
				title,
				versions,
				status: item.installed ? 'Could not check' : 'Version unknown',
				tone: 'neutral',
				note: item.installed ? 'You may be offline. Namzu will try again later.' : note,
				busy: false,
			}
	}
}

/** The programs that are behind, in the order Settings lists them. */
export function availableEngineUpdates(state: EngineUpdatesState | undefined): EngineUpdateItem[] {
	return (state?.items ?? []).filter(isBehind)
}

/** A failed update leaves the program behind, so it still counts until the version moves. */
function isBehind(item: EngineUpdateItem): boolean {
	if (item.status === 'available') return true
	return (
		item.status === 'failed' &&
		item.installed !== undefined &&
		item.latest !== undefined &&
		compareVersions(item.latest, item.installed) > 0
	)
}

export type EngineBadge = { visible: false } | { visible: true; label: string; tooltip: string }

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? ''
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The rail button for programs that are behind. The app's own update keeps priority over it. */
export function engineBadge(state: EngineUpdatesState | undefined): EngineBadge {
	const behind = availableEngineUpdates(state)
	if (behind.length === 0) return { visible: false }
	const names = joinNames(behind.map((item) => item.name))
	return {
		visible: true,
		label: `Updates available. Open Settings to update ${names}`,
		tooltip: `Update available for ${names}`,
	}
}

export function engineAnnouncement(
	previous: EngineUpdatesState | undefined,
	next: EngineUpdatesState | undefined,
): string {
	const before = new Set(
		availableEngineUpdates(previous).map((item) => `${item.id}@${item.latest}`),
	)
	const fresh = availableEngineUpdates(next).filter(
		(item) => !before.has(`${item.id}@${item.latest}`),
	)
	return fresh.length === 0
		? ''
		: `Update available for ${joinNames(fresh.map((item) => item.name))}.`
}

/** The small line under an engine row of the model popup. */
export function engineUpdateNote(
	state: EngineUpdatesState | undefined,
	engine: string,
): string | undefined {
	const item = state?.items.find((candidate) => candidate.id === (engine as EngineUpdateId))
	if (!item || !isBehind(item)) return undefined
	return item.latest ? `Update available (${item.latest})` : 'Update available'
}

/**
 * The toast for versions the person has not been told about. Several found at once share one
 * toast, so a second never sits unreadable behind the first.
 */
export function engineToastText(
	announcements: readonly { name: string; version: string }[] | { name: string; version: string },
): string {
	const list = Array.isArray(announcements) ? announcements : [announcements]
	if (list.length === 1) return `${list[0]?.name} ${list[0]?.version} is available`
	return `Updates available for ${joinNames(list.map((item) => item.name))}`
}
