/** Open file tabs and the panel width: view state only, kept per conversation in this window. */
export const MAX_FILE_TABS = 12
export const MIN_PANEL_WIDTH = 320
const MAX_PATH = 1024
const MAX_STORED = 4096

export interface FileTabsState {
	/** Project-relative, '/' separated. */
	paths: string[]
	active?: string
	/** The "+" tab: quick open with no file chosen yet. */
	browsing: boolean
	/** Where the active file should scroll to; transient, never stored. */
	line?: number
}
export const emptyFileTabs: FileTabsState = { paths: [], browsing: false }

export function openFileTab(state: FileTabsState, path: string, line?: number): FileTabsState {
	if (!path || path.length > MAX_PATH) return state
	let paths = state.paths.includes(path) ? state.paths : [...state.paths, path]
	// Past the cap the oldest tab that is not this one makes room.
	while (paths.length > MAX_FILE_TABS) {
		const drop = paths.find((item) => item !== path)
		if (drop === undefined) break
		paths = paths.filter((item) => item !== drop)
	}
	return { paths, active: path, browsing: false, line }
}

export function activateFileTab(state: FileTabsState, path: string): FileTabsState {
	if (!state.paths.includes(path)) return state
	return { ...state, active: path, browsing: false, line: undefined }
}

export function browseFileTabs(state: FileTabsState): FileTabsState {
	return { ...state, browsing: true, line: undefined }
}

/** Closing the active tab moves to its right neighbour, else its left; none left shows no file. */
export function closeFileTab(state: FileTabsState, path: string): FileTabsState {
	const index = state.paths.indexOf(path)
	if (index < 0) return state
	const paths = state.paths.filter((item) => item !== path)
	if (state.active !== path) return { ...state, paths }
	return { paths, active: paths[index] ?? paths[index - 1], browsing: false }
}

/** Leaves file view for the Changes or Activity tab without closing any file. */
export function leaveFileTabs(state: FileTabsState): FileTabsState {
	if (state.active === undefined && !state.browsing) return state
	return { ...state, active: undefined, browsing: false, line: undefined }
}

export function serializeFileTabs(state: FileTabsState): string {
	return JSON.stringify({ paths: state.paths, active: state.active })
}

export function parseFileTabs(raw: string | null | undefined): FileTabsState {
	if (!raw || raw.length > MAX_STORED) return emptyFileTabs
	try {
		const value = JSON.parse(raw) as { paths?: unknown; active?: unknown }
		if (!value || !Array.isArray(value.paths)) return emptyFileTabs
		const paths = [
			...new Set(
				value.paths.filter(
					(item): item is string =>
						typeof item === 'string' && item.length > 0 && item.length <= MAX_PATH,
				),
			),
		].slice(0, MAX_FILE_TABS)
		const active =
			typeof value.active === 'string' && paths.includes(value.active) ? value.active : undefined
		return { paths, active, browsing: false }
	} catch {
		return emptyFileTabs
	}
}

const tabsKey = (id: string) => `namzu.workspace.files:${id}`

export function readFileTabs(storage: Pick<Storage, 'getItem'>, id: string): FileTabsState {
	try {
		return parseFileTabs(storage.getItem(tabsKey(id)))
	} catch {
		return emptyFileTabs
	}
}

export function writeFileTabs(
	storage: Pick<Storage, 'setItem' | 'removeItem'>,
	id: string,
	state: FileTabsState,
): void {
	try {
		if (state.paths.length === 0) storage.removeItem(tabsKey(id))
		else storage.setItem(tabsKey(id), serializeFileTabs(state))
	} catch {
		// Storage can be full or blocked; the tabs then last for this session only.
	}
}

/** 320px up to 70% of the pane; a pane narrower than the floor keeps the floor. */
export function clampPanelWidth(width: number, paneWidth: number): number {
	if (!Number.isFinite(width)) return MIN_PANEL_WIDTH
	const max = Math.max(MIN_PANEL_WIDTH, Math.floor(paneWidth * 0.7))
	return Math.round(Math.min(max, Math.max(MIN_PANEL_WIDTH, width)))
}

const widthKey = (pane: string) => `namzu.workspace.panel-width:${pane}`

export function readPanelWidth(
	storage: Pick<Storage, 'getItem'>,
	pane: string,
): number | undefined {
	try {
		const value = Number(storage.getItem(widthKey(pane)))
		return Number.isFinite(value) && value >= MIN_PANEL_WIDTH && value <= 10_000 ? value : undefined
	} catch {
		return undefined
	}
}

export function writePanelWidth(
	storage: Pick<Storage, 'setItem'>,
	pane: string,
	width: number,
): void {
	try {
		storage.setItem(widthKey(pane), String(Math.round(width)))
	} catch {
		// Not remembering a width is harmless.
	}
}
