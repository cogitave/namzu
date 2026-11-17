import { Menu } from '@base-ui/react/menu'
import type { ReactNode } from 'react'
import { formatLineCount } from './changes-totals.js'
import {
	FileDiffIcon,
	FileTextIcon,
	GlobeIcon,
	PanelRightIcon,
	PencilIcon,
	TerminalIcon,
} from './icons.js'
import type { PaneKind } from './pane-grid.js'
import { Button } from './ui/button.js'
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
	/** The pane buttons and the conversation's own menu, drawn at the right edge. */
	children?: ReactNode
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
	children,
}: ConversationBarProps) {
	return (
		<div className="conversation-bar">
			<h2 className="conversation-bar-title" title={title} data-conversation-title>
				{title}
			</h2>
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
	mac: boolean
	disabled?: boolean
	/** The conversation's own "…" menu, last in the row. */
	more?: ReactNode
}

const ICONS = {
	session: PanelRightIcon,
	terminal: TerminalIcon,
	changes: FileDiffIcon,
	browser: GlobeIcon,
	files: FileTextIcon,
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
					: kind[0]?.toUpperCase() + kind.slice(1)
		return (
			<Button
				key={kind}
				type="button"
				variant="ghost-muted"
				size="icon-sm"
				className="pane-button"
				aria-label={name}
				aria-pressed={open[kind]}
				title={reason ?? paneTooltip(kind, open[kind], mac)}
				disabled={disabled || Boolean(reason)}
				data-pane-button={kind}
				data-open={open[kind] || undefined}
				data-testid={kind === 'session' ? 'session-panel-toggle' : undefined}
				onClick={() => onToggle(kind)}
			>
				<Icon aria-hidden="true" />
			</Button>
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
			{more}
		</div>
	)
}
