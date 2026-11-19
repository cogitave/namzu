import {
	type Column,
	type Layout,
	MAX_COLUMNS,
	MAX_TILES,
	type Tile,
	emptyLayout,
	isGridKind,
} from './pane-grid.js'

/** What a conversation group remembers of its panes: which, where, how big, and the Session flag. */
const KEY = 'namzu.panes.1.'
const MAX_STORED = 4096

const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 20_000
		? value
		: undefined

/** Reads a stored layout. Anything that does not read as a layout reads as none, never as an error. */
export function parseLayout(raw: string | null | undefined, sessionWanted = false): Layout {
	const fresh = emptyLayout(sessionWanted)
	if (!raw || raw.length > MAX_STORED) return fresh
	try {
		const value = JSON.parse(raw) as Record<string, unknown>
		if (!value || typeof value !== 'object' || value.version !== 1) return fresh
		const seen = new Set<string>()
		const columns: Column[] = []
		for (const item of Array.isArray(value.columns) ? value.columns : []) {
			if (columns.length >= MAX_COLUMNS || !item || typeof item !== 'object') continue
			const source = item as Record<string, unknown>
			const tiles: Tile[] = []
			for (const entry of Array.isArray(source.tiles) ? source.tiles : []) {
				const kind = (entry as { kind?: unknown } | null)?.kind
				if (tiles.length >= MAX_TILES || !isGridKind(kind) || seen.has(kind)) continue
				seen.add(kind)
				tiles.push({ kind, flex: num((entry as { flex?: unknown }).flex) ?? 1 })
			}
			if (tiles.length === 0) continue
			columns.push({
				id: `c${columns.length}`,
				tiles,
				flex: num(source.flex) ?? 1,
				sized: source.sized === true,
			})
		}
		const maximised =
			isGridKind(value.maximised) && seen.has(value.maximised) ? value.maximised : undefined
		return {
			version: 1,
			columns,
			maximised,
			sessionWanted: typeof value.sessionWanted === 'boolean' ? value.sessionWanted : sessionWanted,
			oneWidth: num(value.oneWidth),
			twoWidth: num(value.twoWidth),
		}
	} catch {
		return fresh
	}
}

export function serializeLayout(layout: Layout): string {
	return JSON.stringify(layout)
}

export function readLayout(
	storage: Pick<Storage, 'getItem'>,
	group: string,
	sessionWanted = false,
): Layout {
	try {
		return parseLayout(storage.getItem(KEY + group), sessionWanted)
	} catch {
		return emptyLayout(sessionWanted)
	}
}

export function writeLayout(
	storage: Pick<Storage, 'setItem'>,
	group: string,
	layout: Layout,
): void {
	try {
		storage.setItem(KEY + group, serializeLayout(layout))
	} catch {
		// Storage can be full or blocked; the layout then lasts for this window only.
	}
}
