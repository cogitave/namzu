import { viewState } from '../view-state.js'

/** The Changes pane's display switches, kept per viewer. Storage may be missing; defaults then hold. */
export type ListPosition = 'auto' | 'left' | 'right'

export interface ChangesDisplay {
	showFiles: boolean
	listPosition: ListPosition
	listWidth: number
	groupByFolder: boolean
	separateKinds: boolean
	sideBySide: boolean
	wordWrap: boolean
	highlightWords: boolean
	hideWhitespace: boolean
}

export const LIST_WIDTH = { default: 240, min: 160, max: 640 } as const
/** The pane body must fit the list at its default width plus this much for the diffs. */
export const LIST_FIT_WIDTH = LIST_WIDTH.default + 160
/** Two columns need this much room; below it the pane reads unified without changing the choice. */
export const SPLIT_FIT_WIDTH = 560

export const DISPLAY_DEFAULTS: ChangesDisplay = {
	showFiles: false,
	listPosition: 'auto',
	listWidth: LIST_WIDTH.default,
	groupByFolder: false,
	separateKinds: false,
	sideBySide: false,
	wordWrap: true,
	highlightWords: true,
	hideWhitespace: false,
}

const KEY = 'namzu.changes.display'

export const clampListWidth = (width: number) =>
	Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)))

/** Reads what was stored, keeping a stored value only when it has the right type. */
export function parseDisplay(raw: string | null | undefined): ChangesDisplay {
	const out = { ...DISPLAY_DEFAULTS }
	if (!raw) return out
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return out
	}
	if (!value || typeof value !== 'object') return out
	const stored = value as Record<string, unknown>
	for (const key of Object.keys(DISPLAY_DEFAULTS) as (keyof ChangesDisplay)[]) {
		const item = stored[key]
		if (key === 'listPosition') {
			if (item === 'auto' || item === 'left' || item === 'right') out.listPosition = item
		} else if (key === 'listWidth') {
			if (typeof item === 'number' && Number.isFinite(item)) out.listWidth = clampListWidth(item)
		} else if (typeof item === 'boolean') (out as Record<string, unknown>)[key] = item
	}
	return out
}

export function loadDisplay(): ChangesDisplay {
	try {
		return parseDisplay(viewState.getItem(KEY))
	} catch {
		return { ...DISPLAY_DEFAULTS }
	}
}

export function saveDisplay(display: ChangesDisplay): void {
	try {
		viewState.setItem(KEY, JSON.stringify(display))
	} catch {
		// Storage is a convenience: without it the switches last for this window only.
	}
}

/** Which side the file list sits on: away from the conversation unless the person chose. */
export function listSide(position: ListPosition): 'left' | 'right' {
	return position === 'left' ? 'left' : 'right'
}
