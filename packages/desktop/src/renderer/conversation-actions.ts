import type { AttachmentView, ChatMessage, ConversationView } from '../shared/protocol.js'

export type ConversationActionId =
	| 'rename'
	| 'pin'
	| 'side-chat'
	| 'fork'
	| 'copy'
	| 'copy-reply'
	| 'copy-markdown'
	| 'copy-id'
	| 'copy-path'
	| 'open-in'
	| 'open-editor'
	| 'open-file-manager'
	| 'open-terminal'
	| 'move-right'
	| 'move-window'
	| 'archive'

export type ConversationIconId =
	| 'rename'
	| 'pin'
	| 'unpin'
	| 'side-chat'
	| 'fork'
	| 'copy'
	| 'reply'
	| 'markdown'
	| 'id'
	| 'path'
	| 'open-in'
	| 'editor'
	| 'folder-open'
	| 'terminal'
	| 'move-right'
	| 'move-window'
	| 'archive'

export interface ConversationActionEntry {
	id: ConversationActionId
	label: string
	icon: ConversationIconId
	/** Present when the entry is shown but cannot run; the text says why. */
	reason?: string
	/** Items of a submenu. */
	children?: ConversationActionEntry[]
	destructive?: boolean
}

/** What the host and this window can do; an absent capability hides its item. */
export interface ConversationActionCapabilities {
	rename: boolean
	pin: boolean
	fork: boolean
	markdown: boolean
	copy: boolean
	archive: boolean
	moveRight: boolean
	moveWindow: boolean
	/** The host can open a project folder in an editor, the file manager or a terminal. */
	openIn?: boolean
}

export interface ConversationActionInput {
	view: ConversationView
	isPal: boolean
	running: boolean
	queued: number
	permissions: number
	backgroundRunning: number
	hasMessages: boolean
	hasReply: boolean
	hasProjectPath: boolean
	/** Name of the editor the host opens a folder in; absent when none was found. */
	editorLabel?: string
	/** A pane that holds a single conversation cannot give one of them a split. */
	canMoveRight: boolean
	can: ConversationActionCapabilities
}

export function archiveBlockedReason(
	input: Pick<ConversationActionInput, 'running' | 'queued' | 'permissions' | 'backgroundRunning'>,
): string | undefined {
	if (input.running) return 'Stop the reply before archiving.'
	if (input.permissions > 0) return 'Answer the pending approval first.'
	if (input.queued > 0) return 'Clear the queued messages first.'
	if (input.backgroundRunning > 0) return 'Stop the background work first.'
	return undefined
}

function forkBlockedReason(input: ConversationActionInput): string | undefined {
	if (input.running) return 'Wait for the reply to finish.'
	if (!input.hasMessages) return 'There is nothing to fork yet.'
	return undefined
}

/** The menu as groups; a separator sits between groups. Empty groups are dropped. */
export function conversationActionGroups(
	input: ConversationActionInput,
): ConversationActionEntry[][] {
	const engine = input.view.harness ?? 'namzu'
	const namzu = engine === 'namzu' && !input.isPal
	const groups: ConversationActionEntry[][] = []
	if (!input.isPal) {
		const first: ConversationActionEntry[] = []
		if (namzu && input.can.rename) first.push({ id: 'rename', label: 'Rename…', icon: 'rename' })
		if (input.can.pin)
			first.push({
				id: 'pin',
				label: input.view.pinned ? 'Unpin' : 'Pin',
				icon: input.view.pinned ? 'unpin' : 'pin',
			})
		groups.push(first)
		if (namzu && input.can.fork) {
			const reason = forkBlockedReason(input)
			groups.push([
				{ id: 'side-chat', label: 'New side chat', icon: 'side-chat', reason },
				{
					id: 'fork',
					label: 'Fork',
					icon: 'fork',
					reason,
					children: [
						{
							id: 'fork',
							label: 'Into a new conversation',
							icon: 'fork',
							reason,
						},
					],
				},
			])
		}
		if (input.can.copy) {
			const children: ConversationActionEntry[] = [
				{
					id: 'copy-reply',
					label: 'Last reply',
					icon: 'reply',
					reason: input.hasReply ? undefined : 'There is no reply to copy yet.',
				},
			]
			if (namzu && input.can.markdown)
				children.push({
					id: 'copy-markdown',
					label: 'Conversation as Markdown',
					icon: 'markdown',
					reason: input.hasMessages ? undefined : 'There is nothing to copy yet.',
				})
			children.push({ id: 'copy-id', label: 'Conversation ID', icon: 'id' })
			if (input.hasProjectPath)
				children.push({ id: 'copy-path', label: 'Project path', icon: 'path' })
			groups.push([{ id: 'copy', label: 'Copy', icon: 'copy', children }])
		}
	}
	if (!input.isPal && input.hasProjectPath && input.can.openIn) {
		const children: ConversationActionEntry[] = []
		if (input.editorLabel)
			children.push({ id: 'open-editor', label: input.editorLabel, icon: 'editor' })
		children.push(
			{ id: 'open-file-manager', label: 'Show in folder', icon: 'folder-open' },
			{ id: 'open-terminal', label: 'Open terminal here', icon: 'terminal' },
		)
		groups.push([{ id: 'open-in', label: 'Open in', icon: 'open-in', children }])
	}
	const move: ConversationActionEntry[] = []
	if (input.can.moveRight)
		move.push({
			id: 'move-right',
			label: 'Move to right pane',
			icon: 'move-right',
			reason: input.canMoveRight ? undefined : 'Open another conversation in this pane first.',
		})
	if (input.can.moveWindow)
		move.push({ id: 'move-window', label: 'Move to new window', icon: 'move-window' })
	groups.push(move)
	if (!input.isPal && input.can.archive)
		groups.push([
			{
				id: 'archive',
				label: 'Archive…',
				icon: 'archive',
				reason: archiveBlockedReason(input),
				destructive: true,
			},
		])
	return groups.filter((group) => group.length > 0)
}

// Chords. Rename, pin and side chat use Ctrl+Alt (Cmd+Option on a Mac); archive Ctrl+Shift.
const SHORTCUTS: Partial<
	Record<ConversationActionId, { code: string; alt: boolean; shift: boolean; key: string }>
> = {
	rename: { code: 'KeyR', alt: true, shift: false, key: 'R' },
	pin: { code: 'KeyP', alt: true, shift: false, key: 'P' },
	'side-chat': { code: 'KeyS', alt: true, shift: false, key: 'S' },
	archive: { code: 'KeyA', alt: false, shift: true, key: 'A' },
}

export function shortcutLabel(id: ConversationActionId, mac: boolean): string | undefined {
	const chord = SHORTCUTS[id]
	if (!chord) return undefined
	if (mac) return `${chord.alt ? '⌥' : '⇧'}⌘${chord.key}`
	return `Ctrl+${chord.alt ? 'Alt' : 'Shift'}+${chord.key}`
}

export function ariaShortcut(id: ConversationActionId, mac: boolean): string | undefined {
	const chord = SHORTCUTS[id]
	if (!chord) return undefined
	return `${mac ? 'Meta' : 'Control'}+${chord.alt ? 'Alt' : 'Shift'}+${chord.key}`
}

export interface ShortcutEvent {
	code: string
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
	shiftKey: boolean
	isComposing?: boolean
	keyCode?: number
	getModifierState(key: string): boolean
}

/**
 * The action a key chord asks for. Matching uses the physical key, and an AltGr chord (which
 * many layouts, Turkish Q among them, report as Ctrl+Alt) never counts, so typing a character
 * never runs an action. Nothing fires during IME composition.
 */
export function conversationShortcut(
	event: ShortcutEvent,
	mac: boolean,
): ConversationActionId | null {
	if (event.isComposing || event.keyCode === 229) return null
	if (event.getModifierState('AltGraph')) return null
	const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
	if (!primary) return null
	for (const [id, chord] of Object.entries(SHORTCUTS)) {
		if (!chord || event.code !== chord.code) continue
		if (event.altKey === chord.alt && event.shiftKey === chord.shift)
			return id as ConversationActionId
	}
	return null
}

/** The last completed final answer, which is the text the reply copy control would copy. */
export function lastReplyText(messages: readonly ChatMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (!message || message.role !== 'assistant' || message.status === 'pending') continue
		if (message.phase === 'commentary' || !message.text) continue
		return message.text
	}
	return undefined
}

export interface ConversationSource {
	key: string
	attachment: AttachmentView
}

/** Files and images sent in this conversation, newest first. */
export function conversationSources(messages: readonly ChatMessage[]): ConversationSource[] {
	const sources: ConversationSource[] = []
	for (let index = messages.length - 1; index >= 0; index--) {
		const attachments = messages[index]?.attachments
		if (!attachments) continue
		for (let item = attachments.length - 1; item >= 0; item--) {
			const attachment = attachments[item]
			if (attachment) sources.push({ key: `${index}:${attachment.id}`, attachment })
		}
	}
	return sources
}
