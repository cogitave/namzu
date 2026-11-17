import { type ReactNode, useSyncExternalStore } from 'react'

/**
 * The Changes pane's controls live in the pane's own header row: the base chip where a title would
 * be, and the search, file-list and "..." buttons beside the pane's own. The review owns their
 * state, so it hands the finished elements to the pane's header through this one-slot store.
 */
export interface ChangesHeader {
	title: ReactNode
	actions: ReactNode
}

let current: ChangesHeader = { title: null, actions: null }
const listeners = new Set<() => void>()

export function publishChangesHeader(header: ChangesHeader) {
	current = header
	for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** One half of the published header; the pane's title or its actions. */
export function ChangesHeaderSlot({ part }: { part: keyof ChangesHeader }) {
	const node = useSyncExternalStore(
		subscribe,
		() => current[part],
		() => null,
	)
	// Until the review has mounted the title is the pane's plain name.
	return <>{node ?? (part === 'title' ? <span>Changes</span> : null)}</>
}
