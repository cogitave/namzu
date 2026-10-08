import { Menu } from '@base-ui/react/menu'
import type { ReactElement } from 'react'
import { FolderIcon, FolderPlusIcon } from './icons.js'

export const ADD_PROJECT_LABEL = 'Add new project'
export const START_FROM_SCRATCH_LABEL = 'Start from scratch'
export const USE_EXISTING_FOLDER_LABEL = 'Use an existing folder'

/**
 * The two ways to add a project. A surface that is already a menu lists these two items
 * itself; a single button wraps itself in `AddProjectMenu` so the choice looks the same
 * everywhere.
 */
export function AddProjectItems({
	onCreate,
	onOpen,
	disabled,
	itemClassName = 'window-titlebar-item',
}: {
	onCreate?: () => void
	onOpen: () => void
	disabled?: boolean
	itemClassName?: string
}) {
	return (
		<>
			{onCreate && (
				<Menu.Item className={itemClassName} onClick={onCreate} disabled={disabled}>
					<FolderPlusIcon className="size-4" aria-hidden="true" />
					<span>{START_FROM_SCRATCH_LABEL}</span>
				</Menu.Item>
			)}
			<Menu.Item className={itemClassName} onClick={onOpen} disabled={disabled}>
				<FolderIcon className="size-4" aria-hidden="true" />
				<span>{USE_EXISTING_FOLDER_LABEL}</span>
			</Menu.Item>
		</>
	)
}

/** `trigger` is the button to wrap; it keeps its own look and gains the menu. */
export function AddProjectMenu({
	trigger,
	onCreate,
	onOpen,
	disabled,
	align = 'start',
}: {
	trigger: ReactElement
	onCreate?: () => void
	onOpen: () => void
	disabled?: boolean
	align?: 'start' | 'end'
}) {
	return (
		<Menu.Root>
			<Menu.Trigger render={trigger} disabled={disabled} />
			<Menu.Portal>
				<Menu.Positioner className="z-[150] outline-none" align={align} sideOffset={4}>
					<Menu.Popup
						aria-label={ADD_PROJECT_LABEL}
						data-add-project-menu
						className="window-titlebar-popup dropdown-glass min-w-52 rounded-lg p-1 text-sm text-popover-foreground shadow-xl outline-none"
					>
						<AddProjectItems onCreate={onCreate} onOpen={onOpen} />
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
