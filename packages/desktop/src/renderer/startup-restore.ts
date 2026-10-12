import type { ConversationView, DesktopBoot, ProjectView } from '../shared/protocol.js'
import type { SidebarSectionId } from '../shared/sidebar-sections.js'
import type { SidebarSnapshot } from '../shared/sidebar-snapshot.js'

/**
 * The pre-paint snapshot main handed to this page, and the one-time right to seed state from
 * it. Only the panes mounted by the launch commit may use it: a pane opened later would start
 * from data that is already stale, and reads the live state instead.
 */
let boot: DesktopBoot | undefined
let seedable = false
export function adoptBoot(value: DesktopBoot | undefined): void {
	boot = value
	seedable = value?.launch === true
	sidebar = value && {
		projects: value.projects,
		tabs: value.conversations,
		snapshot: value.sidebar,
		collapsedSections: value.collapsedSections ?? [],
	}
}
export function launchSeed(): DesktopBoot | undefined {
	return seedable ? boot : undefined
}
export function settleLaunchSeed(): void {
	seedable = false
}

/**
 * What the sidebar draws on its very first frame. Unlike the launch seed it is offered to every
 * pane that mounts, a reload and a page that comes back from Settings included, because it
 * follows the live lists: the pane that last changed them leaves its picture here. It only
 * ever fills the sidebar; the live reads reconcile it in place and nothing else reads it.
 */
export interface SidebarSeed {
	projects: ProjectView[]
	/** The saved views of the conversations open as tabs, which say which project is in front. */
	tabs: ConversationView[]
	snapshot?: SidebarSnapshot
	collapsedSections: SidebarSectionId[]
}
let sidebar: SidebarSeed | undefined
export function sidebarSeed(): SidebarSeed | undefined {
	return sidebar
}
export function rememberSidebar(update: Partial<SidebarSeed>): void {
	sidebar = { projects: [], tabs: [], collapsedSections: [], ...sidebar, ...update }
}

export type RestoreDecision = 'restore' | 'home'

/**
 * What the pane shows while its saved tab is being brought back.
 *
 * - `restore`: a skeleton of the conversation. Never the home composer, the welcome or an
 *   empty project home: those say "nothing here" about a tab that is coming back.
 * - `home`: the person asked to start on the home screen, there is no tab to restore, the
 *   restore has finished, or it cannot finish (the tab's folder failed to open, or the load
 *   reported an error) and the ordinary screens carry the explanation.
 */
export function restoreDecision(input: {
	/** The saved setting; unknown until the snapshot or the settings read arrives. */
	startupHome: boolean
	activeTabId: string
	restoring: boolean
	/** The load of the active tab already failed. */
	failed: boolean
	/** The active tab's folder, when known. */
	tabProject?: { status: 'connecting' | 'ready' | 'error'; trusted: boolean }
}): RestoreDecision {
	if (input.startupHome || !input.activeTabId || !input.restoring || input.failed) return 'home'
	const folder = input.tabProject
	// A folder that failed to open, or that is not trusted here, will not restore: its own
	// screen (the error, or the trust dialog) says why.
	if (folder && (folder.status === 'error' || (folder.status === 'ready' && !folder.trusted)))
		return 'home'
	return 'restore'
}
