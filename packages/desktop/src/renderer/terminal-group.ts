import { isTerminalTabId } from '../shared/terminal-tabs.js'
import type { WorkspaceGroup } from '../shared/workspace-layout.js'

export interface TerminalGroupSplit {
	/** The pane's conversation tabs, as the conversation machinery has always seen them. */
	group: WorkspaceGroup
	/** Every tab of the pane in the order the strip shows them. */
	order: string[]
	terminalIds: string[]
	/** The terminal tab in front, when one is. */
	activeTerminalId?: string
}

/**
 * Terminal tabs share a pane's tab list with conversations, but nothing in the conversation code
 * knows them. So the conversation side sees the pane without them, and while a terminal is in front
 * it keeps showing the conversation that was in front before: switching back needs no reload.
 *
 * `lastConversation` is the conversation that was in front last, if any.
 */
export function splitTerminalGroup(
	group: WorkspaceGroup,
	lastConversation: string | undefined,
): TerminalGroupSplit {
	const terminalIds = group.tabs.filter(isTerminalTabId)
	if (terminalIds.length === 0) return { group, order: group.tabs, terminalIds }
	const tabs = group.tabs.filter((id) => !isTerminalTabId(id))
	const terminalFront = isTerminalTabId(group.activeTabId)
	const activeTabId = terminalFront
		? lastConversation && tabs.includes(lastConversation)
			? lastConversation
			: (tabs[0] ?? '')
		: group.activeTabId
	return {
		group: { ...group, tabs, activeTabId },
		order: group.tabs,
		terminalIds,
		...(terminalFront ? { activeTerminalId: group.activeTabId } : {}),
	}
}

/** The conversation in front of a pane, remembered across the time a terminal is in front. */
export function rememberConversation(
	previous: string | undefined,
	group: WorkspaceGroup,
): string | undefined {
	if (group.activeTabId && !isTerminalTabId(group.activeTabId)) return group.activeTabId
	return previous && group.tabs.includes(previous) ? previous : undefined
}
