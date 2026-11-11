import { Menu } from '@base-ui/react/menu'
import { Fragment, type ReactNode } from 'react'
import { formatLineCount } from './changes-totals.js'
import { CheckIcon, FileDiffIcon, FileTextIcon, PencilIcon, TerminalIcon } from './icons.js'
import { Button } from './ui/button.js'
import './conversation-bar.css'

/** One open terminal the bar's terminal button can bring forward. */
export interface ConversationBarTerminalEntry {
	id: string
	title: string
	active: boolean
}

export interface ConversationBarTerminals {
	/** Every open terminal of the pane, in strip order. */
	open: readonly ConversationBarTerminalEntry[]
	/** The conversation the terminals sit beside; named in the menu so it can be brought back. */
	conversation?: { title: string; active: boolean; onSelect: () => void }
	/** Why a new terminal cannot be opened here, or undefined when it can. */
	reason?: string
	onNew?: () => void
	onSelect: (id: string) => void
}

export const NEW_TERMINAL_TITLE = 'New terminal (Ctrl+Shift+`)'

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
	/** The completed edits in the conversation; the same number "N changed files" says elsewhere. */
	changes: number
	/** Lines added and removed across those files: the same numbers the result line and the pane show. */
	added?: number
	removed?: number
	onChanges?: () => void
	onFiles?: () => void
	terminals?: ConversationBarTerminals
	disabled?: boolean
	/** The details and overflow buttons, which keep their own menus. */
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
				<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
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

function TerminalControl({
	terminals,
	disabled,
}: { terminals: ConversationBarTerminals; disabled?: boolean }) {
	const { open, conversation } = terminals
	const blocked = disabled || !!terminals.reason || !terminals.onNew
	if (open.length === 0)
		return (
			<Button
				type="button"
				variant="ghost-muted"
				size="icon-sm"
				className="conversation-bar-button"
				aria-label="New terminal"
				title={terminals.reason ?? NEW_TERMINAL_TITLE}
				disabled={blocked}
				onClick={terminals.onNew}
			>
				<TerminalIcon aria-hidden="true" />
			</Button>
		)
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className="conversation-bar-button"
						aria-label={`Terminals, ${open.length} open`}
						title={`Terminals (${open.length})`}
						disabled={disabled}
					/>
				}
			>
				<TerminalIcon aria-hidden="true" />
				<span className="conversation-bar-count" aria-hidden="true">
					{open.length}
				</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="conversation-actions-positioner" align="end" sideOffset={6}>
					<Menu.Popup className="conversation-actions-popup" aria-label="Terminals">
						{conversation && (
							<Fragment>
								<Menu.Item
									className="conversation-actions-item"
									aria-current={conversation.active ? 'true' : undefined}
									onClick={conversation.onSelect}
								>
									<span className="conversation-actions-icon-slot" aria-hidden="true">
										{conversation.active && <CheckIcon />}
									</span>
									<span className="conversation-actions-label" title={conversation.title}>
										{conversation.title}
									</span>
								</Menu.Item>
								<Menu.Separator className="conversation-actions-separator" />
							</Fragment>
						)}
						{open.map((entry) => (
							<Menu.Item
								key={entry.id}
								className="conversation-actions-item"
								data-terminal-entry={entry.id}
								aria-current={entry.active ? 'true' : undefined}
								onClick={() => terminals.onSelect(entry.id)}
							>
								<span className="conversation-actions-icon-slot" aria-hidden="true">
									{entry.active && <CheckIcon />}
								</span>
								<span className="conversation-actions-label" title={entry.title}>
									{entry.title}
								</span>
							</Menu.Item>
						))}
						<Menu.Separator className="conversation-actions-separator" />
						<Menu.Item
							className="conversation-actions-item"
							disabled={blocked}
							title={terminals.reason}
							onClick={terminals.onNew}
						>
							<TerminalIcon aria-hidden="true" />
							<span className="conversation-actions-label">New terminal</span>
						</Menu.Item>
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
	changes,
	added = 0,
	removed = 0,
	onChanges,
	onFiles,
	terminals,
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
				{onChanges && (
					<Button
						type="button"
						variant="ghost-muted"
						size="icon-sm"
						className="conversation-bar-button conversation-bar-changes"
						aria-label={changesButtonLabel(changes, added, removed)}
						title={changesButtonLabel(changes, added, removed)}
						data-has-changes={changes > 0 || undefined}
						onClick={onChanges}
					>
						<FileDiffIcon aria-hidden="true" />
						{changes > 0 && (
							<span className="conversation-bar-lines" aria-hidden="true">
								<span className="conversation-bar-added">+{formatLineCount(added)}</span>
								<span className="conversation-bar-removed">−{formatLineCount(removed)}</span>
							</span>
						)}
					</Button>
				)}
				{drafts && drafts.length > 0 && onSelectDraft && (
					<DraftsControl drafts={drafts} onSelect={onSelectDraft} disabled={disabled} />
				)}
				{terminals && <TerminalControl terminals={terminals} disabled={disabled} />}
				{onFiles && (
					<Button
						type="button"
						variant="ghost-muted"
						size="icon-sm"
						className="conversation-bar-button"
						aria-label="Project files"
						title="Project files"
						onClick={onFiles}
					>
						<FileTextIcon aria-hidden="true" />
					</Button>
				)}
				{children}
			</div>
		</div>
	)
}
