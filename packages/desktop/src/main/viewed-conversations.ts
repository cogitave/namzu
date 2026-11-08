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
