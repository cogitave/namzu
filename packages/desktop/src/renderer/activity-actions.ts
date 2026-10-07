import { createContext } from 'react'
import type { TurnChanges } from './turn-changes.js'

/**
 * What an action row may do for its turn: show an edit in the Changes panel, or a file in a tab.
 * A context, so the five components between the turn and its rows pass nothing; its value is
 * built per turn from inputs the turn already compares, so a settled turn still skips.
 */
export interface ActivityActions {
	/** The turn's completed edits; absent while it has none yet. */
	changes?: TurnChanges
	/** The folder the conversation works in, to turn a relative path into the full one. */
	projectRoot?: string
	onOpenTurnChanges?: (receiptIds: string[], path?: string) => void
	onOpenChangedFile?: (path: string) => void
}

export const ActivityActionsContext = createContext<ActivityActions | null>(null)

const absolute = /^(?:[\\/]|[A-Za-z]:[\\/]|\\\\)/

/** Resolves `.` and `..` segments so a path outside the project reads as the place it really is. */
function settle(path: string, separator: string): string {
	const lead = path.match(/^(?:\\\\|[A-Za-z]:|[\\/])?/)?.[0] ?? ''
	const parts: string[] = []
	for (const part of path.slice(lead.length).split(/[\\/]+/)) {
		if (!part || part === '.') continue
		if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
		else parts.push(part)
	}
	return `${lead}${lead && !/[\\/]$/.test(lead) ? separator : ''}${parts.join(separator)}`
}

/** The full path to show in a tooltip. Never throws and never waits; with no root it is the path as given. */
export function fullPath(path: string, root?: string): string {
	if (absolute.test(path) || !root) return path
	const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
	return settle(`${root.replace(/[\\/]+$/, '')}${separator}${path}`, separator)
}

export type OpenTarget = 'changes' | 'file'

/** An edit opens its diff when the turn has a completed receipt for that file, else the file itself. */
export function openTarget(actions: ActivityActions | null, path: string): OpenTarget | undefined {
	if (!actions) return undefined
	if (actions.onOpenTurnChanges && actions.changes?.files.some((file) => file.path === path))
		return 'changes'
	return actions.onOpenChangedFile ? 'file' : undefined
}

/** Runs the open that `openTarget` chose. */
export function openAction(actions: ActivityActions, path: string): void {
	if (openTarget(actions, path) === 'changes' && actions.changes)
		actions.onOpenTurnChanges?.(actions.changes.receiptIds, path)
	else actions.onOpenChangedFile?.(path)
}
