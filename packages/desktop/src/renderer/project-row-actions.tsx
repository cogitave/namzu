import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import { type ReactElement, type ReactNode, useRef } from 'react'
import { ArchiveIcon, FolderOpenIcon, MoreHorizontalIcon, XIcon } from './icons.js'
import { Button } from './ui/button.js'
import './conversation-actions-menu.css'

/** What a project row can do. Removal is last, and only here: never a one-click button on the row. */
export interface ProjectRowActions {
	/** Show the folder in the system's file manager. */
	onOpenFolder?: () => void
	/** Show every archived conversation, grouped by project. */
	onArchived?: () => void
	/** Leave Namzu; the caller confirms and performs it. */
	onRemove: () => void
}

function ProjectMenuItems({
	actions,
	accepted,
}: {
	actions: ProjectRowActions
	accepted: { current: boolean }
}) {
	const run = (action: () => void) => () => {
		accepted.current = true
		action()
	}
	const { onOpenFolder, onArchived, onRemove } = actions
	return (
		<>
			{onOpenFolder && (
				<Menu.Item className="conversation-actions-item" onClick={run(onOpenFolder)}>
					<FolderOpenIcon aria-hidden="true" />
					<span className="conversation-actions-label">Open folder</span>
				</Menu.Item>
			)}
			{onArchived && (
				<Menu.Item className="conversation-actions-item" onClick={run(onArchived)}>
					<ArchiveIcon aria-hidden="true" />
					<span className="conversation-actions-label">Archived conversations</span>
				</Menu.Item>
			)}
			{(onOpenFolder || onArchived) && (
				<Menu.Separator className="conversation-actions-separator" />
			)}
			<Menu.Item className="conversation-actions-item" data-destructive onClick={run(onRemove)}>
				<XIcon aria-hidden="true" />
				<span className="conversation-actions-label">Remove project…</span>
			</Menu.Item>
		</>
	)
}

/** The project row's right-click menu (also Shift+F10 and the context-menu key). */
export function ProjectContextMenu({
	label,
	render,
	children,
	restoreFocus,
	onOpenChange,
	actions,
}: {
	label: string
	render: ReactElement
	children: ReactNode
	restoreFocus: () => HTMLElement | null
	onOpenChange?: (open: boolean) => void
	actions: ProjectRowActions
}) {
	const accepted = useRef(false)
	return (
		<ContextMenu.Root
			onOpenChange={(open) => {
				if (open) accepted.current = false
				onOpenChange?.(open)
			}}
		>
			<ContextMenu.Trigger render={render}>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="conversation-actions-positioner" sideOffset={2}>
					<ContextMenu.Popup
						className="conversation-actions-popup"
						aria-label={label}
						finalFocus={() => (accepted.current ? false : (restoreFocus() ?? true))}
					>
						<ProjectMenuItems actions={actions} accepted={accepted} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	)
}

/** The "…" button on the row: the same menu as the right-click one, for someone who never right-clicks. */
export function ProjectMoreMenu({
	label,
	triggerLabel,
	restoreFocus,
	onOpenChange,
	actions,
}: {
	label: string
	triggerLabel: string
	restoreFocus: () => HTMLElement | null
	onOpenChange?: (open: boolean) => void
	actions: ProjectRowActions
}) {
	const accepted = useRef(false)
	return (
		<Menu.Root
			onOpenChange={(open) => {
				if (open) accepted.current = false
				onOpenChange?.(open)
			}}
		>
			<Menu.Trigger
				render={
					<Button
						variant="ghost-muted"
						size="icon-xs"
						className="sidebar-project-more"
						aria-label={triggerLabel}
					/>
				}
			>
				<MoreHorizontalIcon aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={4}>
					<Menu.Popup
						className="conversation-actions-popup"
						aria-label={label}
						finalFocus={() => (accepted.current ? false : (restoreFocus() ?? true))}
					>
						<ProjectMenuItems actions={actions} accepted={accepted} />
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
