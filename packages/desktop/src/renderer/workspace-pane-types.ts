import type { WorkspaceAction, WorkspaceView } from '../shared/protocol.js'
import type { WorkspaceGroup, WorkspaceWindowBounds } from '../shared/workspace-layout.js'
import type { Appearance } from './sidebar.js'

export interface WorkspacePaneController {
	prepare(): Promise<void>
	resume(): void
}
export interface WorkspacePaneProps {
	group: WorkspaceGroup
	windowId: string
	focused: boolean
	shell: HTMLElement | null
	frozen: boolean
	appearance: Appearance
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
