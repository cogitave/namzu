import { Menu } from '@base-ui/react/menu'
import { useRef } from 'react'
import { MessagesSquareIcon, MoreHorizontalIcon, SettingsIcon, TrashIcon } from './icons.js'
import { Button } from './ui/button.js'
import './plugin-actions.css'

export interface PluginActionsProps {
	pluginName: string
	canTry: boolean
	onTry: () => void
	onManage: () => void
	onUninstall?: () => void
}

export function PluginActions({
	pluginName,
	canTry,
	onTry,
	onManage,
	onUninstall,
}: PluginActionsProps) {
	const trigger = useRef<HTMLButtonElement>(null)
	const accepted = useRef(false)
	const restoreOnClose = useRef(false)
	const act = (action: () => void) => {
		accepted.current = true
		action()
	}
	return (
		<Menu.Root
			onOpenChange={(open, details) => {
				if (open) {
					accepted.current = false
					restoreOnClose.current = false
				} else if (details.reason === 'escape-key' || details.reason === 'item-press') {
					restoreOnClose.current = !accepted.current
				}
			}}
			onOpenChangeComplete={(open) => {
				if (open || !restoreOnClose.current || accepted.current) return
				restoreOnClose.current = false
				if (trigger.current?.isConnected && trigger.current.getClientRects().length)
					trigger.current.focus({ preventScroll: true })
			}}
		>
			<Menu.Trigger
				render={
					<Button
						ref={trigger}
						variant="ghost-muted"
						size="icon-sm"
						className="plugins-page-row-action plugin-actions-trigger"
						aria-label={`Actions for ${pluginName}`}
					/>
				}
			>
				<MoreHorizontalIcon />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="plugin-actions-positioner" align="end" sideOffset={4}>
					<Menu.Popup
						className="plugin-actions-menu"
						aria-label={`${pluginName} actions`}
						finalFocus={() => (accepted.current ? false : (trigger.current ?? true))}
					>
						<Menu.Item
							className="plugin-actions-menu-item"
							disabled={!canTry}
							title={
								!canTry ? 'Open a conversation with this plugin enabled to try it.' : undefined
							}
							onClick={() => {
								if (canTry) act(onTry)
							}}
						>
							<MessagesSquareIcon />
							Try now
						</Menu.Item>
						<Menu.Item className="plugin-actions-menu-item" onClick={() => act(onManage)}>
							<SettingsIcon />
							Manage
						</Menu.Item>
						<Menu.Separator className="plugin-actions-menu-separator" />
						<Menu.Item
							className="plugin-actions-menu-item plugin-actions-menu-destructive"
							disabled={!onUninstall}
							title={
								!onUninstall ? 'Uninstall is not available in the desktop app yet.' : undefined
							}
							onClick={() => {
								if (onUninstall) act(onUninstall)
							}}
						>
							<TrashIcon />
							Uninstall
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
