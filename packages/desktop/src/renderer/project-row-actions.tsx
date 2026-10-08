import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import { type ReactElement, type ReactNode, useRef } from 'react'
import { XIcon } from './icons.js'
import './conversation-actions-menu.css'

/**
 * The project row's right-click menu (also Shift+F10 and the context-menu key). It offers the one
 * thing a project can do from the sidebar: leave Namzu. The caller confirms and performs it.
 */
export function ProjectContextMenu({
	label,
	render,
	children,
	restoreFocus,
	onOpenChange,
	onRemove,
}: {
	label: string
	render: ReactElement
	children: ReactNode
	restoreFocus: () => HTMLElement | null
	onOpenChange?: (open: boolean) => void
	onRemove: () => void
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
						<Menu.Item
							className="conversation-actions-item"
							data-destructive
							onClick={() => {
								accepted.current = true
								onRemove()
							}}
						>
							<XIcon aria-hidden="true" />
							<span className="conversation-actions-label">Remove project…</span>
						</Menu.Item>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	)
}
