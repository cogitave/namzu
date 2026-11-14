/** The side panel's tabs and the panel width: view state only, kept per conversation in this window. */
export const MAX_FILE_TABS = 12

/**
 * A reading panel (changes, a file, a preview) and a tool panel (tasks) take different shares of the main
 * area, remember their own dragged width and have their own floor. The numbers are the ones in
 * theme.css (--panel-*); panel-tokens.test.ts keeps the two equal.
 */
export type PanelKind = 'reading' | 'tool'
export const READING_PANEL_MIN = 360
export const TOOL_PANEL_MIN = 320
export const MIN_PANEL_WIDTH = TOOL_PANEL_MIN
/** What the conversation keeps beside an open panel; with less, the panel lies over it instead. */
export const CONVERSATION_MIN = 360
const panelMin = (kind: PanelKind) => (kind === 'reading' ? READING_PANEL_MIN : TOOL_PANEL_MIN)
/** The kind of panel a view is: the terminal's and the tasks' share is the smaller one. */
export const panelKindOf = (
	view: 'activity' | 'changes' | 'file' | 'browse' | 'empty',
): PanelKind => (view === 'activity' || view === 'empty' ? 'tool' : 'reading')

/**
 * Below this window width the sidebar folds to its rail while the Changes pane is open: at 520 px
 * the pane leaves the conversation about 450 px otherwise. Chosen at 1280, the largest width of
 * the two reference windows, where the column would otherwise be 448 px.
 */
export const SIDEBAR_FOLD_BELOW = 1281
const MAX_PATH = 1024
const MAX_STORED = 8192

/** Changes and Activity are ordinary tabs beside the open files. */
export type PanelTab = { kind: 'changes' } | { kind: 'activity' } | { kind: 'file'; path: string }

export interface PanelTabsState {
	/** In display order. */
	tabs: PanelTab[]
	/** Undefined when every tab is closed, or while the "+" quick open has no file chosen yet. */
	active?: PanelTab
	/** Quick open with no file chosen yet. */
	browsing: boolean
	/** Where the active file should scroll to; transient, never stored. */
	line?: number
}

export const changesTab: PanelTab = { kind: 'changes' }
export const activityTab: PanelTab = { kind: 'activity' }
export const fileTab = (path: string): PanelTab => ({ kind: 'file', path })

/** What a conversation starts with: both fixed tabs, Activity showing as it always did. */
export const emptyPanelTabs: PanelTabsState = {
	tabs: [changesTab, activityTab],
	active: activityTab,
	browsing: false,
}

export function sameTab(a: PanelTab | undefined, b: PanelTab | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) return false
	return a.kind !== 'file' || a.path === (b as { path: string }).path
}

export const tabKey = (tab: PanelTab): string =>
	tab.kind === 'file' ? `file:${tab.path}` : tab.kind
export const hasTab = (state: PanelTabsState, tab: PanelTab): boolean =>
	state.tabs.some((item) => sameTab(item, tab))
export const filePaths = (state: PanelTabsState): string[] =>
	state.tabs.flatMap((tab) => (tab.kind === 'file' ? [tab.path] : []))
export const activeFilePath = (state: PanelTabsState): string | undefined =>
	state.active?.kind === 'file' ? state.active.path : undefined

/** Adds a missing tab without choosing it: Changes first, Activity after Changes, files last. */
function withTab(tabs: PanelTab[], tab: PanelTab): PanelTab[] {
	if (tabs.some((item) => sameTab(item, tab))) return tabs
	if (tab.kind === 'changes') return [tab, ...tabs]
	if (tab.kind === 'activity') {
		const at = tabs.findIndex((item) => item.kind === 'changes')
		return [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)]
	}
	return [...tabs, tab]
}

/** Makes sure the tab exists and shows it. */
export function ensurePanelTab(state: PanelTabsState, tab: PanelTab): PanelTabsState {
	if (tab.kind === 'file') return openFileTab(state, tab.path)
	return { tabs: withTab(state.tabs, tab), active: tab, browsing: false }
}

export function openFileTab(state: PanelTabsState, path: string, line?: number): PanelTabsState {
	if (!path || path.length > MAX_PATH) return state
	const tab = fileTab(path)
	let tabs = withTab(state.tabs, tab)
	// Past the cap the oldest file tab that is not this one makes room.
	while (filePaths({ ...state, tabs }).length > MAX_FILE_TABS) {
		const drop = tabs.find((item) => item.kind === 'file' && item.path !== path)
		if (!drop) break
		tabs = tabs.filter((item) => item !== drop)
	}
	return { tabs, active: tab, browsing: false, line }
}

export function activatePanelTab(state: PanelTabsState, tab: PanelTab): PanelTabsState {
	const found = state.tabs.find((item) => sameTab(item, tab))
	if (!found) return state
	return { ...state, active: found, browsing: false, line: undefined }
}

export function browsePanelTabs(state: PanelTabsState): PanelTabsState {
	return { ...state, browsing: true, line: undefined }
}

/** Closing the active tab moves to its right neighbour, else its left; none left shows an empty panel. */
export function closePanelTab(state: PanelTabsState, tab: PanelTab): PanelTabsState {
	const index = state.tabs.findIndex((item) => sameTab(item, tab))
	if (index < 0) return state
	const tabs = state.tabs.filter((_, at) => at !== index)
	if (!sameTab(state.active, tab)) return { ...state, tabs }
	// The quick open stays up when the tab closed was only waiting behind it.
	return { tabs, active: tabs[index] ?? tabs[index - 1], browsing: state.browsing }
}

/** The tab that should show: the active one, else the first that is left. */
export function shownTab(
	state: PanelTabsState,
	allow: (tab: PanelTab) => boolean,
): PanelTab | undefined {
	const visible = state.tabs.filter(allow)
	return visible.find((tab) => sameTab(tab, state.active)) ?? visible[0]
}

export function serializePanelTabs(state: PanelTabsState): string {
	return JSON.stringify({
		v: 2,
		tabs: state.tabs.map((tab) =>
			tab.kind === 'file' ? { kind: 'file', path: tab.path } : { kind: tab.kind },
		),
		active: state.active,
	})
}

function parseTab(item: unknown): PanelTab | undefined {
	if (!item || typeof item !== 'object') return undefined
	const { kind, path } = item as { kind?: unknown; path?: unknown }
	if (kind === 'changes' || kind === 'activity') return { kind }
	if (kind === 'file' && typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH)
		return fileTab(path)
	return undefined
}

/**
 * Reads a stored record. The first format held only file paths, so it gains Changes and Activity
 * in front; `legacy` is the tab the panel used to show when no file was active.
 */
export function parsePanelTabs(
	raw: string | null | undefined,
	legacy: 'changes' | 'activity' = 'activity',
): PanelTabsState {
	const fresh = legacy === 'changes' ? { ...emptyPanelTabs, active: changesTab } : emptyPanelTabs
	if (!raw || raw.length > MAX_STORED) return fresh
	try {
		const value = JSON.parse(raw) as { tabs?: unknown; paths?: unknown; active?: unknown }
		if (!value || typeof value !== 'object') return fresh
		if (Array.isArray(value.tabs)) {
			const tabs: PanelTab[] = []
			for (const item of value.tabs) {
				const tab = parseTab(item)
				if (tab && !tabs.some((existing) => sameTab(existing, tab))) tabs.push(tab)
			}
			const files = tabs.filter((tab) => tab.kind === 'file')
			const capped =
				files.length > MAX_FILE_TABS ? new Set(files.slice(0, MAX_FILE_TABS)) : undefined
			const kept = capped ? tabs.filter((tab) => tab.kind !== 'file' || capped.has(tab)) : tabs
			const parsed = parseTab(value.active)
			return { tabs: kept, active: kept.find((tab) => sameTab(tab, parsed)), browsing: false }
		}
		if (!Array.isArray(value.paths)) return fresh
		const paths = [
			...new Set(
				value.paths.filter(
					(item): item is string =>
						typeof item === 'string' && item.length > 0 && item.length <= MAX_PATH,
				),
			),
		].slice(0, MAX_FILE_TABS)
		const tabs = [changesTab, activityTab, ...paths.map(fileTab)]
		const active =
			typeof value.active === 'string' && paths.includes(value.active)
				? fileTab(value.active)
				: legacy === 'changes'
					? changesTab
					: activityTab
		return { tabs, active, browsing: false }
	} catch {
		return fresh
	}
}

const tabsKey = (id: string) => `namzu.workspace.files:${id}`

export function readPanelTabs(
	storage: Pick<Storage, 'getItem'>,
	id: string,
	legacy?: 'changes' | 'activity',
): PanelTabsState {
	try {
		return parsePanelTabs(storage.getItem(tabsKey(id)), legacy)
	} catch {
		return emptyPanelTabs
	}
}

export function writePanelTabs(
	storage: Pick<Storage, 'setItem'>,
	id: string,
	state: PanelTabsState,
): void {
	try {
		storage.setItem(tabsKey(id), serializePanelTabs(state))
	} catch {
		// Storage can be full or blocked; the tabs then last for this session only.
	}
}

/** A kind's floor up to what leaves the conversation its minimum; a pane too narrow for both keeps the floor. */
export function clampPanelWidth(
	width: number,
	paneWidth: number,
	kind: PanelKind = 'tool',
): number {
	const min = panelMin(kind)
	if (!Number.isFinite(width)) return min
	const max = Math.max(min, Math.floor(paneWidth - CONVERSATION_MIN))
	return Math.round(Math.min(max, Math.max(min, width)))
}

const widthKey = (pane: string, kind?: PanelKind) =>
	`namzu.workspace.panel-width:${pane}${kind ? `:${kind}` : ''}`

export function readPanelWidth(
	storage: Pick<Storage, 'getItem'>,
	pane: string,
	kind?: PanelKind,
): number | undefined {
	try {
		const value = Number(storage.getItem(widthKey(pane, kind)))
		return Number.isFinite(value) && value >= panelMin(kind ?? 'tool') && value <= 10_000
			? value
			: undefined
	} catch {
		return undefined
	}
}

export function writePanelWidth(
	storage: Pick<Storage, 'setItem'>,
	pane: string,
	width: number,
	kind?: PanelKind,
): void {
	try {
		storage.setItem(widthKey(pane, kind), String(Math.round(width)))
	} catch {
		// Not remembering a width is harmless.
	}
}

/** A double click on the seam puts the share back: the remembered width is dropped. */
export function clearPanelWidth(
	storage: Pick<Storage, 'removeItem'>,
	pane: string,
	kind?: PanelKind,
): void {
	try {
		storage.removeItem(widthKey(pane, kind))
	} catch {
		// Nothing was kept, or it cannot be removed; the share comes back this session all the same.
	}
}
