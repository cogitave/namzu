import type { TerminalTabView } from '../shared/terminal-tabs.js'

/** What pressing the Terminal button does: show a terminal that is already running, or start one. */
export type TerminalPaneChoice = { reuse: string } | { start: true }

/**
 * Closing the Terminal pane only hides it, so its shells keep running. Pressing the button again
 * shows the one that was in front, or else the first live terminal of this project. A new shell
 * starts only when this project has no live terminal; an ended or restored one does not count,
 * it stays in the strip for its Restart.
 */
export function chooseTerminalForPane(
	tabs: readonly Pick<TerminalTabView, 'id' | 'projectId' | 'status'>[],
	projectId: string | undefined,
	shownId?: string,
): TerminalPaneChoice {
	const live = tabs.filter((tab) => tab.projectId === projectId && tab.status === 'running')
	const pick = live.find((tab) => tab.id === shownId) ?? live[0]
	return pick ? { reuse: pick.id } : { start: true }
}
