import type { WorkspaceAction, WorkspaceView } from '../shared/protocol.js'
import type { WorkspaceGroup, WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import type { Appearance } from './sidebar.js'

export interface WorkspacePaneController {
	prepare(): Promise<void>
	resume(): void
}
import type { UpdateState } from '../shared/update-protocol.js'

export interface WorkspacePaneProps {
	group: WorkspaceGroup
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
