import { Menu } from '@base-ui/react/menu'
import { type ReactNode, cloneElement, useEffect, useRef, useState } from 'react'
import { formatLineCount } from './changes-totals.js'
import {
	FileDiffIcon,
	FileTextIcon,
	GlobeIcon,
	ListTodoIcon,
	MoreHorizontalIcon,
	PanelRightIcon,
	PencilIcon,
	SideChatIcon,
	TerminalIcon,
} from './icons.js'
import type { PaneKind } from './pane-grid.js'
import { Button } from './ui/button.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './conversation-bar.css'
import { MENU_OFFSET } from './menu-metrics.js'

/** The name of the changes button: it says the count, so a number is never the only signal. */
export function changesButtonLabel(count: number, added = 0, removed = 0): string {
	if (count <= 0) return 'Changes'
	const lines =
		added + removed > 0
			? `, ${formatLineCount(added)} added, ${formatLineCount(removed)} removed`
			: ''
	return `Changes, ${count} changed ${count === 1 ? 'file' : 'files'}${lines}`
}

/** A blank conversation kept open for unsent work: it has no sidebar row, so the bar names it. */
export interface ConversationBarDraft {
	id: string
	/** What the person left in it: words, attachments, or a bare "New conversation". */
	title: string
}

export interface ConversationBarProps {
	/** Blank conversations kept open out of sight; the bar lists them so they can be reached. */
	drafts?: readonly ConversationBarDraft[]
	onSelectDraft?: (id: string) => void
	title: string
	project?: string
	disabled?: boolean
	/** Saves a new name; an empty one asks for the automatic title. Absent: the title is not editable. */
	onRename?: (title: string) => Promise<void> | void
	/** The "∨" menu right after the title: the conversation's actions. */
	actions?: ReactNode
	/** The pane buttons, drawn at the right edge. */
	children?: ReactNode
}

/**
 * The title as text; a click turns it into a field. Enter saves, Escape puts the old name back and
 * leaving the field saves, so a name is never lost to a stray click.
 */
function EditableTitle({
	title,
	onRename,
	disabled,
}: {
	title: string
	onRename?: ((title: string) => Promise<void> | void) | undefined
	disabled?: boolean | undefined
}) {
	const [editing, setEditing] = useState(false)
	const [value, setValue] = useState(title)
	const field = useRef<HTMLInputElement>(null)
	// One edit ends once: Enter saves and the blur that follows the field's removal must not save again.
	const ended = useRef(false)
	useEffect(() => {
		if (!editing) return
		field.current?.focus()
		field.current?.select()
	}, [editing])
	if (!onRename || disabled)
		return (
			<h2 className="conversation-bar-title" title={title} data-conversation-title>
				{title}
			</h2>
		)
	const finish = (save: boolean) => {
		if (ended.current) return
		ended.current = true
		setEditing(false)
		const next = value.trim()
		if (save && next !== title.trim()) void onRename(next)
	}
	if (editing)
		return (
			<h2 className="conversation-bar-title" data-editing data-conversation-title>
				<input
					ref={field}
					className="conversation-bar-rename"
					aria-label="Conversation name"
					maxLength={200}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onBlur={() => finish(true)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							finish(true)
						} else if (event.key === 'Escape') {
							event.preventDefault()
							event.stopPropagation()
							finish(false)
						}
					}}
				/>
			</h2>
		)
	return (
		<h2 className="conversation-bar-title" data-conversation-title>
			<button
				type="button"
				className="conversation-bar-title-text"
				title={title}
				onClick={() => {
					ended.current = false
					setValue(title)
					setEditing(true)
				}}
			>
				{title}
			</button>
		</h2>
	)
}

function DraftsControl({
	drafts,
	onSelect,
	disabled,
}: {
	drafts: readonly ConversationBarDraft[]
	onSelect: (id: string) => void
	disabled?: boolean
}) {
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="conversation-bar-button"
						data-kept-drafts
						aria-label={`Unsent drafts, ${drafts.length} kept open`}
						title={`Unsent drafts (${drafts.length})`}
						disabled={disabled}
					/>
				}
			>
				<PencilIcon aria-hidden="true" />
				<span className="conversation-bar-count" aria-hidden="true">
					{drafts.length}
				</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					align="end"
					sideOffset={MENU_OFFSET}
				>
					<Menu.Popup className="conversation-actions-popup" aria-label="Unsent drafts">
						{drafts.map((draft) => (
							<Menu.Item
								key={draft.id}
								className="conversation-actions-item"
								data-kept-draft={draft.id}
								onClick={() => onSelect(draft.id)}
							>
								<span className="conversation-actions-label" title={draft.title}>
									{draft.title}
								</span>
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

/**
 * The one 40 px bar above a conversation: its title and project, and the buttons
 * for the panels beside it. It stands where the strip of tabs stood.
 */
export function ConversationBar({
	title,
	project,
	drafts,
	onSelectDraft,
	disabled,
	onRename,
	actions,
	children,
}: ConversationBarProps) {
	return (
		<div className="conversation-bar">
			<EditableTitle title={title} onRename={onRename} disabled={disabled} />
			{actions}
			{project && (
				<span className="conversation-bar-project" title={project} data-project-label>
					{project}
				</span>
			)}
			<div className="conversation-bar-spacer" aria-hidden="true" />
			<div className="conversation-bar-buttons">
				{drafts && drafts.length > 0 && onSelectDraft && (
					<DraftsControl drafts={drafts} onSelect={onSelectDraft} disabled={disabled} />
				)}
				{children}
			</div>
		</div>
	)
}

/** The keys that toggle a pane, as the tooltip says them; the window listens for the same chords. */
export function paneShortcut(kind: PaneKind, mac: boolean): string | undefined {
	const primary = mac ? 'Cmd' : 'Ctrl'
	if (kind === 'terminal') return `${primary}+'`
	if (kind === 'browser') return `${primary}+Shift+B`
	if (kind === 'files') return `${primary}+Shift+F`
	return undefined
}

const PANE_WORD: Record<PaneKind, string> = {
	session: 'session panel',
	terminal: 'terminal',
	changes: 'changes',
	browser: 'browser',
	files: 'files',
	tasks: 'background tasks',
}

/** "Show terminal (Ctrl+')" while it is closed, "Hide terminal (Ctrl+')" while it is open. */
export function paneTooltip(kind: PaneKind, open: boolean, mac: boolean): string {
	const keys = paneShortcut(kind, mac)
	return `${open ? 'Hide' : 'Show'} ${PANE_WORD[kind]}${keys ? ` (${keys})` : ''}`
}

export interface PaneButtonsProps {
	open: Record<PaneKind, boolean>
	onToggle: (kind: PaneKind) => void
	/** A pane that cannot open here, with the reason: its button is disabled and says why. */
	unavailable?: Partial<Record<PaneKind, string>>
	/** Changes shows how many files changed in its name, so a number is never the only signal. */
	changes: { files: number; added: number; removed: number }
	/**
	 * The Background tasks button: drawn only while the conversation has tasks or the pane is open, with
	 * how many run. Absent where there is no such pane.
	 */
	tasks?: { show: boolean; running: number }
	mac: boolean
	disabled?: boolean
	/** The conversation's own "…" menu, last in the row. */
	more?: ReactNode
}

/**
 * A top-bar button's tooltip. It sits to the left of the button, in the bar, so it never lies over a
 * pane's header; a press hides it, and it stays hidden until the pointer has left and come back.
 * A button that cannot be pressed keeps a plain title, which is also how its reason is said.
 */
function PaneButtonTip({
	tip,
	plain,
	children,
}: { tip: string; plain: boolean; children: React.ReactElement<Record<string, unknown>> }) {
	const [open, setOpen] = useState(false)
	const pressed = useRef(false)
	if (plain) return cloneElement(children, { title: tip })
	return (
		<Tooltip
			open={open}
			onOpenChange={(next) => {
				if (next && pressed.current) return
				setOpen(next)
			}}
		>
			<TooltipTrigger
				render={cloneElement(children, {
					onPointerDown: () => {
						pressed.current = true
						setOpen(false)
					},
					onPointerLeave: () => {
						pressed.current = false
					},
				})}
			/>
			<TooltipPopup side="left" align="center" sideOffset={8}>
				{tip}
			</TooltipPopup>
		</Tooltip>
	)
}

const ICONS = {
	session: PanelRightIcon,
	terminal: TerminalIcon,
	changes: FileDiffIcon,
	browser: GlobeIcon,
	files: FileTextIcon,
	tasks: ListTodoIcon,
} as const

/**
 * Session | Terminal, Changes, Browser, Files, "…". Each one toggles its pane: pressed is a filled
 * rounded square behind the icon and means the pane is open; pressing again closes it.
 */
export function PaneButtons({
	open,
	onToggle,
	unavailable,
	changes,
	tasks,
	mac,
	disabled,
	more,
}: PaneButtonsProps) {
	const button = (kind: PaneKind) => {
		const Icon = ICONS[kind]
		const reason = unavailable?.[kind]
		const name =
			kind === 'changes'
				? changesButtonLabel(changes.files, changes.added, changes.removed)
				: kind === 'session'
					? 'Session'
					: kind === 'tasks'
						? 'Background tasks'
						: kind[0]?.toUpperCase() + kind.slice(1)
		const running = kind === 'tasks' ? (tasks?.running ?? 0) : 0
		return (
			<PaneButtonTip
				key={kind}
				tip={reason ?? paneTooltip(kind, open[kind], mac)}
				plain={Boolean(reason) || Boolean(disabled)}
			>
				<Button
					type="button"
					variant="ghost-muted"
					size="icon-sm"
					className="pane-button"
					aria-label={running > 0 ? `${name}, ${running} running` : name}
					aria-pressed={open[kind]}
					disabled={disabled || Boolean(reason)}
					data-pane-button={kind}
					data-open={open[kind] || undefined}
					data-testid={kind === 'session' ? 'session-panel-toggle' : undefined}
					onClick={() => onToggle(kind)}
				>
					<Icon aria-hidden="true" />
					{running > 0 && (
						<span className="conversation-bar-count" aria-hidden="true">
							{running}
						</span>
					)}
				</Button>
			</PaneButtonTip>
		)
	}
	return (
		<div className="pane-buttons" role="toolbar" aria-label="Panes">
			{button('session')}
			<span className="pane-buttons-divider" aria-hidden="true" />
			{button('terminal')}
			{button('changes')}
			{button('browser')}
			{button('files')}
			{tasks?.show && button('tasks')}
			{more}
		</div>
	)
}

export interface ViewOptionsProps {
	/** Opens a side chat; absent or disabled where the conversation cannot be forked. */
	onSideChat?: (() => void) | undefined
	sideChatReason?: string | undefined
	mac: boolean
	/** Items after Side chat, set off by a rule: "Keep computer awake". */
	children?: ReactNode
}

/** "…" at the end of the pane buttons: a small card with Side chat and the switches for this session. */
export function ViewOptionsMenu({ onSideChat, sideChatReason, mac, children }: ViewOptionsProps) {
	return (
		<Menu.Root>
			<PaneButtonTip tip="View options" plain={false}>
				<Menu.Trigger
					render={
						<Button
							type="button"
							variant="ghost-muted"
							size="icon-sm"
							className="pane-button"
							aria-label="View options"
						/>
					}
				>
					<MoreHorizontalIcon aria-hidden="true" />
				</Menu.Trigger>
			</PaneButtonTip>
			<Menu.Portal>
				<Menu.Positioner
					className="conversation-actions-positioner"
					align="end"
					sideOffset={MENU_OFFSET}
				>
					<Menu.Popup className="conversation-actions-popup" aria-label="View options">
						{onSideChat && (
							<Menu.Item
								className="conversation-actions-item"
								disabled={Boolean(sideChatReason)}
								title={sideChatReason}
								aria-keyshortcuts={mac ? 'Meta+;' : 'Control+;'}
								onClick={onSideChat}
							>
								<SideChatIcon aria-hidden="true" />
								<span className="conversation-actions-label">Side chat</span>
								<kbd className="conversation-actions-keys">{mac ? '⌘;' : 'Ctrl+;'}</kbd>
							</Menu.Item>
						)}
						{onSideChat && children && (
							<Menu.Separator className="conversation-actions-separator" />
						)}
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}
