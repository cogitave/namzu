/**
 * Single-line composer with input history and slash-command autocomplete.
 * Ink `useInput` covers all keys we need; no extra `ink-text-input` dep.
 *
 * Keys: Enter submits/steers (or runs the highlighted command while the
 * autocomplete dropdown is open), Tab completes that command or queues the
 * draft, Esc clears / closes the dropdown, ↑/↓ navigate the dropdown when open
 * else browse history, Ctrl+W rubs out a word, Backspace deletes.
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
	readonly onSubmit: (
		value: string,
		attachments?: readonly MessageAttachment[],
		mode?: ComposerSubmitMode,
	) => void
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

/** Return addresses the active turn; Tab deliberately addresses the follow-up queue. */
export type ComposerSubmitMode = 'submit' | 'queue'

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
// hand an unbounded string to Ink's wrapping engine. The bounded view follows
// the real cursor rather than assuming every edit happens at the end.
const COMPOSER_DISPLAY_CODE_UNITS = 2048
const COMPOSER_DISPLAY_LINES = 8
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

interface ComposerDisplay {
	readonly before: string
	readonly after: string
	readonly leadingEllipsis: boolean
	readonly trailingEllipsis: boolean
}

function graphemeBoundaries(source: string): number[] {
	const boundaries = [0]
	for (const segment of graphemeSegmenter.segment(source)) {
		const end = segment.index + segment.segment.length
		if (end > (boundaries[boundaries.length - 1] ?? -1)) boundaries.push(end)
	}
	return boundaries
}

function previousGraphemeBoundary(source: string, cursor: number): number {
	let previous = 0
	for (const boundary of graphemeBoundaries(source)) {
		if (boundary >= cursor) break
		previous = boundary
	}
	return previous
}

function nextGraphemeBoundary(source: string, cursor: number): number {
	for (const boundary of graphemeBoundaries(source)) {
		if (boundary > cursor) return boundary
	}
	return source.length
}

function lineStart(source: string, cursor: number): number {
	return cursor <= 0 ? 0 : source.lastIndexOf('\n', cursor - 1) + 1
}

function composerDisplayValue(source: string, cursor: number): ComposerDisplay {
	let start = Math.max(0, cursor - Math.floor(COMPOSER_DISPLAY_CODE_UNITS / 2))
	let end = Math.min(source.length, start + COMPOSER_DISPLAY_CODE_UNITS)
	if (end === source.length) start = Math.max(0, end - COMPOSER_DISPLAY_CODE_UNITS)
	if (cursor > end) {
		end = cursor
		start = Math.max(0, end - COMPOSER_DISPLAY_CODE_UNITS)
	}

	let afterBreaks = 0
	for (let index = cursor; index < end; index += 1) {
		if (source.charCodeAt(index) !== 0x0a) continue
		afterBreaks += 1
		if (afterBreaks === Math.min(3, COMPOSER_DISPLAY_LINES - 1)) {
			end = index
			break
		}
	}
	let beforeBreaks = 0
	const beforeBudget = COMPOSER_DISPLAY_LINES - afterBreaks
	for (let index = cursor - 1; index >= start; index -= 1) {
		if (source.charCodeAt(index) !== 0x0a) continue
		beforeBreaks += 1
		if (beforeBreaks === beforeBudget) {
			start = index + 1
			break
		}
	}

	// Only the view is rounded to complete grapheme boundaries. The exact source
	// remains untouched even when the cap lands inside a combining sequence.
	const boundaries = graphemeBoundaries(source)
	start = boundaries.find((boundary) => boundary >= start) ?? source.length
	end = [...boundaries].reverse().find((boundary) => boundary <= end) ?? 0
	return {
		before: terminalDisplayText(source.slice(start, cursor)),
		after: terminalDisplayText(source.slice(cursor, end)),
		leadingEllipsis: start > 0,
		trailingEllipsis: end < source.length,
	}
}

/**
 * Terminal Ctrl+W / Unix word-rubout semantics.
 *
 * Punctuation is part of the word: `hello-world` disappears as one unit. The
 * boundary is whitespace, matching the reference composer and the shell habit
 * operators already bring to this key.
 */
export function deletePreviousWord(source: string): string {
	return deletePreviousWordAt(source, source.length).value
}

function deletePreviousWordAt(
	source: string,
	cursor: number,
): { readonly value: string; readonly cursor: number } {
	let start = cursor
	while (start > 0) {
		const previous = previousGraphemeBoundary(source, start)
		if (!/\s/u.test(source.slice(previous, start))) break
		start = previous
	}
	while (start > 0) {
		const previous = previousGraphemeBoundary(source, start)
		if (/\s/u.test(source.slice(previous, start))) break
		start = previous
	}
	return { value: source.slice(0, start) + source.slice(cursor), cursor: start }
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
	const [value, setValueState] = useState<string>('')
	const valueRef = useRef('')
	const [cursor, setCursorState] = useState(0)
	const cursorRef = useRef(0)
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

	// Keep the complete match set. The six-row limit belongs to the rendered
	// window, not to navigation: slicing here made every later command
	// unreachable no matter how many times the operator pressed Down.
	const suggestions = matchSlashCommands(value, userCommands)
	const showSuggestions = suggestions.length > 0
	const selIdx = Math.min(selected, Math.max(0, suggestions.length - 1))
	const suggestionStart = Math.min(
		Math.max(0, selIdx - MAX_SUGGESTIONS + 1),
		Math.max(0, suggestions.length - MAX_SUGGESTIONS),
	)
	const visibleSuggestions = suggestions.slice(suggestionStart, suggestionStart + MAX_SUGGESTIONS)
	const displayValue = composerDisplayValue(value, cursor)
	const commandColumnWidth = Math.min(
		24,
		Math.max(10, ...visibleSuggestions.map((command) => command.name.length + 4)),
	)

	const setBuffer = useCallback((nextValue: string, nextCursor = nextValue.length) => {
		valueRef.current = nextValue
		cursorRef.current = nextCursor
		setValueState(nextValue)
		setCursorState(nextCursor)
	}, [])

	const reset = useCallback(() => {
		setBuffer('', 0)
		setHistoryIndex(-1)
		setSelected(0)
		setPastes([])
		setAttachments([])
		setEditPreviousArmed(false)
	}, [setBuffer])

	useEffect(() => {
		if (!draftToRestore || restoredTokenRef.current === draftToRestore.token) return
		restoredTokenRef.current = draftToRestore.token
		setBuffer(draftToRestore.text)
		setHistoryIndex(-1)
		setSelected(0)
		setPastes([])
		setAttachments(draftToRestore.attachments ? [...draftToRestore.attachments] : [])
		setEditPreviousArmed(false)
		onDraftRestored?.(draftToRestore.token)
	}, [draftToRestore, onDraftRestored, setBuffer])

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
			const submit = (mode: ComposerSubmitMode): boolean => {
				const message = [valueRef.current, ...pastes]
					.map((s) => s.trim())
					.filter(Boolean)
					.join('\n\n')
				if (message.length === 0 && attachments.length === 0) return false
				const submittedAttachments = attachments.length > 0 ? attachments : undefined
				if (mode === 'queue') onSubmit(message, submittedAttachments, mode)
				else onSubmit(message, submittedAttachments)
				reset()
				return true
			}
			if (key.return) {
				if (showSuggestions) {
					// Run the highlighted command.
					onSubmit(`/${suggestions[selIdx]?.name ?? ''}`)
					reset()
					return
				}
				submit('submit')
				return
			}
			if (key.tab) {
				if (showSuggestions) {
					// Complete to the highlighted command, ready for arguments.
					setBuffer(`/${suggestions[selIdx]?.name ?? ''} `)
					setSelected(0)
					return
				}
				submit('queue')
				return
			}
			if (key.escape) {
				// A running turn owns Esc. App aborts it on this same keypress,
				// and clearing the draft too would punish the operator for
				// following the hint the status bar is showing them.
				if (escapeInterrupts) return
				const empty =
					valueRef.current.length === 0 && pastes.length === 0 && attachments.length === 0
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
			if (key.backspace) {
				// Backspace on an empty line removes the last durable attachment first,
				// then pasted text.
				if (valueRef.current.length === 0 && attachments.length > 0) {
					setAttachments((p) => p.slice(0, -1))
					return
				}
				if (valueRef.current.length === 0 && pastes.length > 0) {
					setPastes((p) => p.slice(0, -1))
					return
				}
				const position = cursorRef.current
				const previous = previousGraphemeBoundary(valueRef.current, position)
				setBuffer(
					valueRef.current.slice(0, previous) + valueRef.current.slice(position),
					previous,
				)
				return
			}
			if (key.delete) {
				const position = cursorRef.current
				const next = nextGraphemeBoundary(valueRef.current, position)
				setBuffer(
					valueRef.current.slice(0, position) + valueRef.current.slice(next),
					position,
				)
				return
			}
			if (key.leftArrow || (key.ctrl && input === 'b')) {
				const previous = previousGraphemeBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = previous
				setCursorState(previous)
				return
			}
			if (key.rightArrow || (key.ctrl && input === 'f')) {
				const next = nextGraphemeBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = next
				setCursorState(next)
				return
			}
			if (key.home || (key.ctrl && input === 'a')) {
				const start = lineStart(valueRef.current, cursorRef.current)
				cursorRef.current = start
				setCursorState(start)
				return
			}
			if (key.end || (key.ctrl && input === 'e')) {
				const newline = valueRef.current.indexOf('\n', cursorRef.current)
				const end = newline < 0 ? valueRef.current.length : newline
				cursorRef.current = end
				setCursorState(end)
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
				setBuffer(history[history.length - 1 - next] ?? '')
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
				setBuffer(history[history.length - 1 - next] ?? '')
				return
			}
			// Ctrl+V / Alt+V: pull an image off the clipboard and hold it as an attachment.
			//
			// Every outcome says something. The status bar advertises this key, so
			// a press that produces no chip and no words is indistinguishable from
			// a key that was never wired up — and the operator's next move differs
			// per reason: copy an image, install a tool, or stop pressing it.
			if ((key.ctrl || key.meta) && input === 'v') {
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
			if (key.ctrl && input === 'w') {
				const result = deletePreviousWordAt(valueRef.current, cursorRef.current)
				setBuffer(result.value, result.cursor)
				return
			}
			if (key.ctrl && input === 'u') {
				const position = cursorRef.current
				const start = lineStart(valueRef.current, position)
				setBuffer(valueRef.current.slice(0, start) + valueRef.current.slice(position), start)
				return
			}
			if (key.ctrl && input === 'k') {
				const position = cursorRef.current
				const newline = valueRef.current.indexOf('\n', position)
				const end = newline < 0 ? valueRef.current.length : newline
				setBuffer(valueRef.current.slice(0, position) + valueRef.current.slice(end), position)
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
			const position = cursorRef.current
			setBuffer(
				valueRef.current.slice(0, position) + input + valueRef.current.slice(position),
				position + input.length,
			)
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
							{displayValue.leadingEllipsis ? '… ' : ''}
							{displayValue.before}
							{disabled ? null : <Text color={theme.border.focus}>▏</Text>}
							{displayValue.after}
							{displayValue.trailingEllipsis ? ' …' : ''}
						</Text>
					)}
				</Box>
			</Box>
			{showSuggestions ? (
				<Box flexDirection="column" paddingX={1} paddingTop={1} width="100%">
					{visibleSuggestions.map((cmd, i) => {
						const absoluteIndex = suggestionStart + i
						return (
							<Box key={cmd.name} width="100%" flexDirection="row">
								<Box width={commandColumnWidth} flexShrink={0}>
									<Text
										color={absoluteIndex === selIdx ? theme.accent.user : theme.text.secondary}
										bold={absoluteIndex === selIdx}
									>
										{absoluteIndex === selIdx ? '› ' : '  '}/{cmd.name}
									</Text>
								</Box>
								<Box flexGrow={1} minWidth={0}>
									<Text color={theme.text.muted} wrap="wrap">
										{cmd.description}
									</Text>
								</Box>
							</Box>
						)
					})}
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
