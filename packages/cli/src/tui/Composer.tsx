/**
 * Single-line composer with input history and slash-command autocomplete.
 * Ink `useInput` covers all keys we need; no extra `ink-text-input` dep.
 *
 * Keys: Enter submits (or runs the highlighted command while the
 * autocomplete dropdown is open), Tab completes the highlighted command,
 * Esc clears / closes the dropdown, ↑/↓ navigate the dropdown when open
 * else browse history, Backspace deletes.
 */

import type { MessageAttachment } from '@namzu/sdk'
import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { readClipboardImage } from '../integrations/clipboard/image.js'
import type { UserCommand } from '../user-commands/store.js'
import { matchSlashCommands } from './slashCommands.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export interface ComposerProps {
	readonly disabled?: boolean
	readonly onSubmit: (value: string, attachments?: readonly MessageAttachment[]) => void
	readonly history: readonly string[]
	/** Operator-defined commands, offered in the dropdown alongside builtins. */
	readonly userCommands?: readonly UserCommand[]
	/**
	 * Draw nothing, but stay mounted and keep the draft.
	 *
	 * The permission overlay takes the composer's place on screen. Rendering it
	 * in a ternary against this component unmounted it, and the draft lives in
	 * this component's own state — so a prompt arriving mid-sentence took the
	 * sentence with it, along with any paste chips and pasted images, without
	 * the operator touching a key.
	 */
	readonly hidden?: boolean
	/**
	 * Whether Esc belongs to something more urgent than the draft.
	 *
	 * While a turn runs, the status bar tells the operator that Esc interrupts
	 * it. Both handlers fire on the same keypress, so following that instruction
	 * also cleared the composer — the draft was collateral damage from the
	 * documented way to stop a turn. Esc still clears an idle composer, which is
	 * what it is for when nothing more urgent is happening.
	 */
	readonly escapeInterrupts?: boolean
	/**
	 * Say something to the operator that is not a message to the agent.
	 *
	 * The composer has no transcript of its own, so without this a key it
	 * advertises can fail with nowhere to report it. Optional so the component
	 * stays usable in isolation, but a caller that omits it re-creates the
	 * silence this exists to end.
	 */
	readonly onNotice?: (text: string) => void
	/** Empty-composer Esc ×2 asks App to select a durable prompt to edit. */
	readonly onEditPrevious?: () => void
	/** One-shot prompt restored after App has created a source-preserving fork. */
	readonly draftToRestore?: ComposerDraft | null
	/** Lets App clear the one-shot value without racing the local state update. */
	readonly onDraftRestored?: (token: number) => void
}

export interface ComposerDraft {
	readonly token: number
	readonly text: string
	readonly attachments?: readonly MessageAttachment[]
}

const MAX_SUGGESTIONS = 6
// A single keypress longer than this (with no newline) is treated as a paste.
const PASTE_THRESHOLD = 80
// A recalled or branch-restored prompt can be much larger than anything the
// operator typed one key at a time. Keep the exact source in state, but never
// hand an unbounded string to Ink's wrapping engine. Eight logical tail lines
// preserve the only edit position this composer exposes: the cursor at the end.
const COMPOSER_DISPLAY_CODE_UNITS = 2048
const COMPOSER_DISPLAY_LINES = 8

function composerDisplayValue(source: string): string {
	let start = Math.max(0, source.length - COMPOSER_DISPLAY_CODE_UNITS)

	// Do not begin the view with the low half of a split surrogate pair. Dropping
	// that one half is display-only; the complete pair stays in `source`.
	if (
		start > 0 &&
		source.charCodeAt(start) >= 0xdc00 &&
		source.charCodeAt(start) <= 0xdfff &&
		source.charCodeAt(start - 1) >= 0xd800 &&
		source.charCodeAt(start - 1) <= 0xdbff
	) {
		start += 1
	}

	let newlineCount = 0
	for (let index = source.length - 1; index >= start; index -= 1) {
		if (source.charCodeAt(index) !== 0x0a) continue
		newlineCount += 1
		if (newlineCount === COMPOSER_DISPLAY_LINES) {
			start = index + 1
			break
		}
	}

	const visible = terminalDisplayText(source.slice(start))
	return start > 0 ? `… ${visible}` : visible
}

export function Composer({
	disabled = false,
	onSubmit,
	history,
	userCommands = [],
	hidden = false,
	escapeInterrupts = false,
	onNotice,
	onEditPrevious,
	draftToRestore = null,
	onDraftRestored,
}: ComposerProps) {
	const [value, setValue] = useState<string>('')
	const [historyIndex, setHistoryIndex] = useState<number>(-1)
	const [selected, setSelected] = useState<number>(0)
	// Large pastes are held as attachments (shown as chips) instead of being
	// dumped into the input, then folded into the message on submit.
	const [pastes, setPastes] = useState<readonly string[]>([])
	// Pasted images and restored durable attachments, shown as chips and sent
	// back in the exact SDK union on submit.
	const [attachments, setAttachments] = useState<readonly MessageAttachment[]>([])
	const [editPreviousArmed, setEditPreviousArmed] = useState(false)
	const restoredTokenRef = useRef<number | null>(null)

	const suggestions = matchSlashCommands(value, userCommands).slice(0, MAX_SUGGESTIONS)
	const showSuggestions = suggestions.length > 0
	const selIdx = Math.min(selected, Math.max(0, suggestions.length - 1))
	const displayValue = composerDisplayValue(value)

	const reset = useCallback(() => {
		setValue('')
		setHistoryIndex(-1)
		setSelected(0)
		setPastes([])
		setAttachments([])
		setEditPreviousArmed(false)
	}, [])

	useEffect(() => {
		if (!draftToRestore || restoredTokenRef.current === draftToRestore.token) return
		restoredTokenRef.current = draftToRestore.token
		setValue(draftToRestore.text)
		setHistoryIndex(-1)
		setSelected(0)
		setPastes([])
		setAttachments(draftToRestore.attachments ? [...draftToRestore.attachments] : [])
		setEditPreviousArmed(false)
		onDraftRestored?.(draftToRestore.token)
	}, [draftToRestore, onDraftRestored])

	useInput(
		(input, key) => {
			// Hidden means the screen belongs to something else, so a keypress
			// aimed at that must not also land here.
			//
			// `hidden` is REDUNDANT with `disabled` today and is kept anyway.
			// The only caller sets `hidden` when a permission prompt is open,
			// and that same event sets `awaiting-permission`, which already puts
			// `disabled` true — so removing this clause changes no behaviour and
			// kills no test, which was confirmed by trying it. It stays because
			// the two say different things: `disabled` is "the composer may not
			// be used", `hidden` is "the composer is not on screen", and a
			// component that draws nothing must not consume input on the
			// strength of a second flag happening to agree with it.
			if (disabled || hidden) return
			if (!key.escape && editPreviousArmed) setEditPreviousArmed(false)
			if (key.return) {
				if (showSuggestions) {
					// Run the highlighted command.
					onSubmit(`/${suggestions[selIdx]?.name ?? ''}`)
					reset()
					return
				}
				const message = [value, ...pastes].map((s) => s.trim()).filter(Boolean).join('\n\n')
				if (message.length === 0 && attachments.length === 0) return
				onSubmit(message, attachments.length > 0 ? attachments : undefined)
				reset()
				return
			}
			if (key.tab) {
				if (showSuggestions) {
					// Complete to the highlighted command, ready for arguments.
					setValue(`/${suggestions[selIdx]?.name ?? ''} `)
					setSelected(0)
				}
				return
			}
			if (key.escape) {
				// A running turn owns Esc. App aborts it on this same keypress,
				// and clearing the draft too would punish the operator for
				// following the hint the status bar is showing them.
				if (escapeInterrupts) return
				const empty = value.length === 0 && pastes.length === 0 && attachments.length === 0
				if (empty && onEditPrevious) {
					if (editPreviousArmed) {
						setEditPreviousArmed(false)
						onEditPrevious()
					} else setEditPreviousArmed(true)
					return
				}
				reset()
				return
			}
			if (key.backspace || key.delete) {
				// Backspace on an empty line removes the last durable attachment first,
				// then pasted text.
				if (value.length === 0 && attachments.length > 0) {
					setAttachments((p) => p.slice(0, -1))
					return
				}
				if (value.length === 0 && pastes.length > 0) {
					setPastes((p) => p.slice(0, -1))
					return
				}
				setValue((v) => v.slice(0, -1))
				return
			}
			if (key.upArrow) {
				if (showSuggestions) {
					setSelected((i) => Math.max(0, i - 1))
					return
				}
				if (history.length === 0) return
				const next = Math.min(historyIndex + 1, history.length - 1)
				setHistoryIndex(next)
				setValue(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.downArrow) {
				if (showSuggestions) {
					setSelected((i) => Math.min(suggestions.length - 1, i + 1))
					return
				}
				if (historyIndex <= 0) {
					reset()
					return
				}
				const next = historyIndex - 1
				setHistoryIndex(next)
				setValue(history[history.length - 1 - next] ?? '')
				return
			}
			// Ctrl+V: pull an image off the clipboard and hold it as an attachment.
			//
			// Every outcome says something. The status bar advertises this key, so
			// a press that produces no chip and no words is indistinguishable from
			// a key that was never wired up — and the operator's next move differs
			// per reason: copy an image, install a tool, or stop pressing it.
			if (key.ctrl && input === 'v') {
				const read = readClipboardImage()
				if (read.kind === 'image') {
					setAttachments((p) => [...p, read.image])
				} else if (read.kind === 'empty') {
					onNotice?.('No image on the clipboard. Copy one, then press Ctrl+V.')
				} else {
					onNotice?.(`Cannot read images from the clipboard here — ${read.detail}.`)
				}
				return
			}
			if (key.ctrl || key.meta) return
			if (input.length === 0) return
			// A multi-line or large chunk arriving in one keypress is a paste —
			// hold it as an attachment chip instead of flooding the input.
			if (input.includes('\n') || input.length > PASTE_THRESHOLD) {
				setPastes((p) => [...p, input])
				return
			}
			setSelected(0)
			setValue((v) => v + input)
		},
		{ isActive: true },
	)

	// After every hook, so the component keeps its state while it is off screen.
	// This is the whole fix: React preserves a mounted component's state, and
	// preserving it is what an unmounting ternary could not do.
	if (hidden) return null

	const promptGlyph = disabled ? '…' : '>'
	const showPlaceholder = !disabled && value.length === 0 && !editPreviousArmed
	return (
		<Box flexDirection="column">
			{pastes.length > 0 || attachments.length > 0 ? (
				<Box flexDirection="column" paddingX={1} paddingBottom={1}>
					{attachments.map((attachment, i) => (
						<Text key={`attachment-${i}`} color={theme.accent.tool}>
							⎘ {attachmentLabel(attachment, i)}
						</Text>
					))}
					{pastes.map((p, i) => (
						<Text key={`paste-${i}`} color={theme.text.secondary}>
							⎘ Pasted text #{i + 1} (+{p.split('\n').length} lines)
						</Text>
					))}
				</Box>
			) : null}
			<Box paddingX={1}>
				<Box width={2} flexShrink={0}>
					<Text color={disabled ? theme.text.muted : theme.accent.user} bold>
						{promptGlyph}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{showPlaceholder ? (
						<Text color={theme.text.muted}>Type a message… (/help for commands)</Text>
					) : editPreviousArmed ? (
						<Text color={theme.text.muted}>Press Esc again to edit a previous prompt</Text>
					) : (
						<Text color={disabled ? theme.text.muted : theme.text.primary} wrap="wrap">
							{displayValue}
							{disabled ? null : <Text color={theme.border.focus}>▏</Text>}
						</Text>
					)}
				</Box>
			</Box>
			{showSuggestions ? (
				<Box flexDirection="column" paddingX={1} paddingTop={1}>
					{suggestions.map((cmd, i) => (
						<Box key={cmd.name}>
							<Box width={12} flexShrink={0}>
								<Text
									color={i === selIdx ? theme.accent.user : theme.text.secondary}
									bold={i === selIdx}
								>
									{i === selIdx ? '› ' : '  '}/{cmd.name}
								</Text>
							</Box>
							<Text color={theme.text.muted}>{cmd.description}</Text>
						</Box>
					))}
				</Box>
			) : null}
		</Box>
	)
}

function attachmentLabel(attachment: MessageAttachment, index: number): string {
	if (attachment.type === 'stored') {
		const kind = attachment.kind === 'image' ? 'Image' : 'Document'
		return `${kind} #${index + 1}${attachment.name ? ` — ${attachment.name}` : ''} (stored)`
	}
	const size = `${Math.round((attachment.data.length * 3) / 4 / 1024)} KB`
	if (attachment.type === 'document') {
		return `Document #${index + 1}${attachment.name ? ` — ${attachment.name}` : ''} (${size})`
	}
	return `Image #${index + 1} (${size})`
}
