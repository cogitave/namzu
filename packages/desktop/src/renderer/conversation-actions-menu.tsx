import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu } from '@base-ui/react/menu'
import {
	Fragment,
	type MutableRefObject,
	type ReactElement,
	type ReactNode,
	type Ref,
	useRef,
} from 'react'
import {
	type ConversationActionEntry,
	type ConversationActionId,
	type ConversationActionInput,
	type ConversationIconId,
	ariaShortcut,
	conversationActionGroups,
	shortcutLabel,
} from './conversation-actions.js'
import { CodeIcon, ExternalLinkIcon } from './file-panel/file-icons.js'
import {
	AppWindowIcon,
	ArchiveIcon,
	ChevronRightIcon,
	ConversationIcon,
	CopyIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
	GitForkIcon,
	HashIcon,
	type IconComponent,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	SideChatIcon,
	SplitRightIcon,
	TerminalIcon,
} from './icons.js'
import './conversation-actions-menu.css'

const ICONS: Record<ConversationIconId, IconComponent> = {
	rename: PencilIcon,
	pin: PinIcon,
	unpin: PinOffIcon,
	'side-chat': SideChatIcon,
	fork: GitForkIcon,
	copy: CopyIcon,
	reply: ConversationIcon,
	markdown: FileTextIcon,
	id: HashIcon,
	path: FolderIcon,
	'open-in': ExternalLinkIcon,
	editor: CodeIcon,
	'folder-open': FolderOpenIcon,
	terminal: TerminalIcon,
	'move-right': SplitRightIcon,
	'move-window': AppWindowIcon,
	archive: ArchiveIcon,
}

// These open a dialog or change which pane shows the conversation, and so own focus afterwards.
const TAKES_FOCUS = new Set<ConversationActionId>([
	'rename',
	'archive',
	'side-chat',
	'fork',
	'move-right',
	'move-window',
])

function EntryItem({
	entry,
	mac,
	busy,
	onSelect,
}: {
	entry: ConversationActionEntry
	mac: boolean
	busy: boolean
	onSelect: (id: ConversationActionId) => void
}) {
	const Icon = ICONS[entry.icon]
	const keys = shortcutLabel(entry.id, mac)
	const body = (
		<>
			<Icon aria-hidden="true" />
			<span className="conversation-actions-label">{entry.label}</span>
		</>
	)
	if (entry.children)
		return (
			<Menu.SubmenuRoot>
				<Menu.SubmenuTrigger
					className="conversation-actions-item"
					disabled={busy || !!entry.reason}
					title={entry.reason}
					aria-description={entry.reason}
				>
					{body}
					<ChevronRightIcon className="conversation-actions-chevron" aria-hidden="true" />
				</Menu.SubmenuTrigger>
				<Menu.Portal>
					<Menu.Positioner
						className="conversation-actions-positioner"
						sideOffset={4}
						alignOffset={-6}
					>
						<Menu.Popup className="conversation-actions-popup" aria-label={entry.label}>
							{entry.children.map((child) => (
								<EntryItem key={child.id} entry={child} mac={mac} busy={busy} onSelect={onSelect} />
							))}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.SubmenuRoot>
		)
	return (
		<Menu.Item
			className="conversation-actions-item"
			data-destructive={entry.destructive || undefined}
			disabled={busy || !!entry.reason}
			title={entry.reason}
			aria-description={entry.reason}
			// The hint is announced through aria-keyshortcuts, not read again as part of the name.
			aria-label={entry.label}
			aria-keyshortcuts={ariaShortcut(entry.id, mac)}
			onClick={() => onSelect(entry.id)}
		>
			{body}
			{keys && <kbd className="conversation-actions-keys">{keys}</kbd>}
		</Menu.Item>
	)
}

function ActionGroups({
	groups,
	mac,
	busy,
	afterMove,
	onSelect,
}: {
	/** A function is read only when this renders, which a closed menu never does. */
	groups: ConversationActionEntry[][] | (() => ConversationActionEntry[][])
	mac: boolean
	busy: boolean
	afterMove?: ReactNode
	onSelect: (id: ConversationActionId) => void
}) {
	const resolved = typeof groups === 'function' ? groups() : groups
	return resolved.map((group, index) => (
		<Fragment key={group[0]?.id ?? index}>
			{index > 0 && <Menu.Separator className="conversation-actions-separator" />}
			{group.map((entry) => (
				<EntryItem key={entry.id} entry={entry} mac={mac} busy={busy} onSelect={onSelect} />
			))}
			{afterMove && group.some((entry) => entry.id === 'move-window') && afterMove}
		</Fragment>
	))
}

/**
 * The same menu, opened by right-click, long-press or the keyboard's context-menu key
 * (Shift+F10) on the element it wraps. `render` supplies that element.
 */
export function ConversationContextMenu({
	getInput,
	mac,
	busy = false,
	label,
	render,
	children,
	restoreFocus,
	onOpenChange,
	onAction,
}: {
	/** Read when the menu opens, so a closed row computes nothing. */
	getInput: () => ConversationActionInput
	mac: boolean
	busy?: boolean
	label: string
	render: ReactElement
	children: ReactNode
	/** Where focus returns when the menu closes without an action that moves it. */
	restoreFocus: () => HTMLElement | null
	onOpenChange?: (open: boolean) => void
	onAction: (id: ConversationActionId) => void
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
						<ActionGroups
							groups={() => conversationActionGroups(getInput())}
							mac={mac}
							busy={busy}
							onSelect={(id) => {
								if (TAKES_FOCUS.has(id)) accepted.current = true
								onAction(id)
							}}
						/>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	)
}

/**
 * One menu for a conversation, used by the header and by each tab. The caller supplies the
 * trigger button and performs the actions; this component only decides what is offered.
 */
export function ConversationActionsMenu({
	input,
	mac,
	busy = false,
	trigger,
	triggerRef,
	label,
	align = 'end',
	leading,
	afterMove,
	acceptedRef,
	onAction,
}: {
	input: ConversationActionInput
	mac: boolean
	busy?: boolean
	/** The button the menu opens from; its accessible name is the caller's. */
	trigger: ReactElement
	triggerRef?: Ref<HTMLElement>
	label: string
	align?: 'start' | 'center' | 'end'
	/** Items that belong to one surface only, above the shared items. */
	leading?: ReactNode
	/** Extra items that continue the move group, such as a tab's "Split down". */
	afterMove?: ReactNode
	/** Set by the caller's own items so focus is not pulled back to the trigger after them. */
	acceptedRef?: MutableRefObject<boolean>
	onAction: (id: ConversationActionId, trigger: HTMLElement | null) => void
}) {
	const ownAccepted = useRef(false)
	const accepted = acceptedRef ?? ownAccepted
	const opener = useRef<HTMLElement | null>(null)
	const groups = conversationActionGroups(input)
	return (
		<Menu.Root
			onOpenChange={(open) => {
				if (open) accepted.current = false
			}}
		>
			<Menu.Trigger
				render={trigger}
				ref={(node: HTMLElement | null) => {
					opener.current = node
					if (typeof triggerRef === 'function') triggerRef(node)
					else if (triggerRef) (triggerRef as { current: HTMLElement | null }).current = node
				}}
			/>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align={align} sideOffset={6}>
					<Menu.Popup
						className="conversation-actions-popup"
						aria-label={label}
						finalFocus={() => (accepted.current ? false : (opener.current ?? true))}
					>
						{leading && (
							<>
								{leading}
								<Menu.Separator className="conversation-actions-separator" />
							</>
						)}
						<ActionGroups
							groups={groups}
							mac={mac}
							busy={busy}
							afterMove={afterMove}
							onSelect={(id) => {
								if (TAKES_FOCUS.has(id)) accepted.current = true
								onAction(id, opener.current)
							}}
						/>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
