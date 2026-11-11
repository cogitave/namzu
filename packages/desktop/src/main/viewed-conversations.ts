import { type WorkspaceLayoutSnapshot, workspaceGroups } from '../shared/workspace-layout.js'

/**
 * The tabs a person can see right now: the active tab of every pane of every window that is
 * shown and not minimized. A window behind another one still counts as shown; only a hidden or
 * minimized window does not. Terminals and Pal tabs appear here too; callers match by id.
 */
export function viewedTabs(
	layout: WorkspaceLayoutSnapshot,
	shown: (windowId: string) => boolean,
): Set<string> {
	const viewed = new Set<string>()
	for (const window of layout.windows) {
		if (!shown(window.id)) continue
		for (const group of workspaceGroups(window.root))
			if (group.activeTabId) viewed.add(group.activeTabId)
	}
	return viewed
}

/**
 * The windows that hold this conversation as a tab, those showing it as the active tab of a pane
 * first, then those with it in a background tab, each in layout order. A notification click uses
 * it to open the conversation where it already is.
 */
export function windowsHoldingTab(layout: WorkspaceLayoutSnapshot, tabId: string): string[] {
	const showing: string[] = []
	const holding: string[] = []
	for (const window of layout.windows) {
		const groups = workspaceGroups(window.root)
		if (groups.some((group) => group.activeTabId === tabId)) showing.push(window.id)
		else if (groups.some((group) => group.tabs.includes(tabId))) holding.push(window.id)
	}
	return [...showing, ...holding]
}
