import type { WorkspaceAction, WorkspaceView } from '../shared/protocol.js'
import type { WorkspaceGroup, WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import type { Appearance } from './sidebar.js'

export interface WorkspacePaneController {
	prepare(): Promise<void>
	resume(): void
}
import type { TerminalTabView } from '../shared/terminal-tabs.js'
import type { UpdateState } from '../shared/update-protocol.js'

/** The terminal tabs of a pane. `group` carries only the conversations; this carries the rest of the strip. */
export interface WorkspacePaneTerminals {
	/** Every terminal tab of the app, current. */
	tabs: readonly TerminalTabView[]
	/** The pane's tabs in strip order, terminals included. */
	order: readonly string[]
	/** The terminal in front, if one is. */
	activeId?: string
}

export interface WorkspacePaneProps {
	group: WorkspaceGroup
	/** Absent where the window has no terminals. */
	terminals?: WorkspacePaneTerminals
	windowId: string
	focused: boolean
	shell: HTMLElement | null
	frozen: boolean
	appearance: Appearance
	/** This launch shows the home screen instead of reopening the saved active tab. */
	startAtHome?: boolean
	/** The window's app update, when it has an updater. */
	update?: { state: UpdateState; onOpen: () => void; onCheck: () => void; onDownload?: () => void }
	onAppearanceChange: (value: Appearance) => void
	sideCollapsed: boolean
	onSideCollapsedChange: (value: boolean | ((previous: boolean) => boolean)) => void
	onShellState: (state: { page: string }) => void
	onAction: (action: WorkspaceAction) => Promise<WorkspaceView>
	registerController: (groupId: string, controller: WorkspacePaneController) => () => void
	onComputerFocus: () => void
	onReady: (groupId: string, sessionId: string) => void
	onLoadFailure: (sessionId: string, error: unknown) => void
	onSplit: (groupId: string, tabId: string, position: 'right' | 'bottom') => void
	onDetach: (groupId: string, tabId: string, bounds?: WorkspaceWindowBounds) => void
}
