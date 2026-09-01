/**
 * Single-line composer with input history and slash-command autocomplete.
 * Ink `useInput` covers all keys we need; no extra `ink-text-input` dep.
 *
 * Keys: Enter submits/steers (or runs the highlighted command while the
 * autocomplete dropdown is open), Tab completes that command or queues the
 * draft, Esc clears / closes the dropdown, ↑/↓ navigate the dropdown when open
 * else browse history, Ctrl+R/Ctrl+S search history, Ctrl+W rubs out a word,
 * Ctrl+G edits the draft in VISUAL/EDITOR, Backspace deletes.
 */

import type { MessageAttachment } from '@namzu/sdk'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { readClipboardImage } from '../integrations/clipboard/image.js'
import type { UserCommand } from '../user-commands/store.js'
import { activeFileMention, matchMentionableFiles } from './mentions.js'
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
	/** Project-relative paths admitted once by App for `@` completion. */
	readonly mentionCandidates?: readonly string[]
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
	/** Step through the active model's published reasoning menu. */
	readonly onStepReasoningEffort?: (direction: 'lower' | 'raise') => void
	/** Open the complete text draft in an operator-owned external editor. */
	readonly onExternalEdit?: (seed: string) => Promise<string>
	/** Empty-composer Esc ×2 asks App to select a durable prompt to edit. */
	readonly onEditPrevious?: () => void
	/** One-shot prompt restored after App has created a source-preserving fork. */
	readonly draftToRestore?: ComposerDraft | null
	/** Lets App clear the one-shot value without racing the local state update. */
	readonly onDraftRestored?: (token: number) => void
	/**
	 * Reports only empty ↔ actionable transitions, never text or cursor changes.
	 * App uses this to reveal active-turn controls without re-rendering the
	 * transcript on every keypress.
	 */
	readonly onDraftPresenceChange?: (hasDraft: boolean) => void
	/** Empty-composer ↓ opens the currently active delegated-work panel. */
	readonly onOpenAgentPanel?: () => boolean
}

/** Return addresses the active turn; Tab deliberately addresses the follow-up queue. */
export type ComposerSubmitMode = 'submit' | 'queue'

export interface ComposerDraft {
	readonly token: number
	readonly text: string
	readonly attachments?: readonly MessageAttachment[]
}

const MIN_SUGGESTIONS = 6
const MAX_SUGGESTIONS = 12
const SUGGESTION_FURNITURE_ROWS = 12
// A single keypress longer than this (with no newline) is treated as a paste.
const PASTE_THRESHOLD = 80
// A recalled or branch-restored prompt can be much larger than anything the
// operator typed one key at a time. Keep the exact source in state, but never
// hand an unbounded string to Ink's wrapping engine. The bounded view follows
// the real cursor rather than assuming every edit happens at the end.
const COMPOSER_DISPLAY_CODE_UNITS = 2048
const COMPOSER_DISPLAY_LINES = 8
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: 'grapheme',
})

interface ComposerDisplay {
	readonly before: string
	readonly after: string
	readonly leadingEllipsis: boolean
	readonly trailingEllipsis: boolean
}

interface HistorySearchState {
	readonly draft: { readonly value: string; readonly cursor: number }
	readonly query: string
	readonly matches: readonly string[]
	/** -1 is the original draft; zero is the newest matching history entry. */
	readonly position: number
}

/**
 * Visible rows in a completion menu for this terminal height.
 *
 * Each option is budgeted as two rows because a description may wrap. The
 * composer, borders, footer and status area retain twelve rows before the
 * menu grows. A short/unknown terminal keeps the established six-row window;
 * a tall terminal uses the space it actually has, capped so the menu never
 * takes over the whole conversation view.
 */
export function suggestionWindowSize(rows: number | undefined): number {
	if (rows === undefined || !Number.isFinite(rows)) return MIN_SUGGESTIONS
	return Math.min(
		MAX_SUGGESTIONS,
		Math.max(MIN_SUGGESTIONS, Math.floor((rows - SUGGESTION_FURNITURE_ROWS) / 2)),
	)
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

function lineEnd(source: string, cursor: number): number {
	const newline = source.indexOf('\n', cursor)
	return newline < 0 ? source.length : newline
}

function graphemeColumn(source: string, start: number, cursor: number): number {
	let column = 0
	for (const _segment of graphemeSegmenter.segment(source.slice(start, cursor))) column += 1
	return column
}

function cursorAtGraphemeColumn(
	source: string,
	start: number,
	end: number,
	column: number,
): number {
	let current = 0
	for (const segment of graphemeSegmenter.segment(source.slice(start, end))) {
		if (current === column) return start + segment.index
		current += 1
	}
	return end
}

function verticalCursor(
	source: string,
	cursor: number,
	direction: -1 | 1,
	preferredColumn?: number,
): { readonly cursor: number; readonly column: number } | null {
	const currentStart = lineStart(source, cursor)
	const currentEnd = lineEnd(source, cursor)
	const column = preferredColumn ?? graphemeColumn(source, currentStart, cursor)
	if (direction === -1) {
		if (currentStart === 0) return null
		const previousEnd = currentStart - 1
		const previousStart = lineStart(source, previousEnd)
		return {
			cursor: cursorAtGraphemeColumn(source, previousStart, previousEnd, column),
			column,
		}
	}
	if (currentEnd === source.length) return null
	const nextStart = currentEnd + 1
	return {
		cursor: cursorAtGraphemeColumn(source, nextStart, lineEnd(source, nextStart), column),
		column,
	}
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

function previousWordBoundary(source: string, cursor: number): number {
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
	return start
}

function nextWordBoundary(source: string, cursor: number): number {
	let end = cursor
	while (end < source.length) {
		const next = nextGraphemeBoundary(source, end)
		if (!/\s/u.test(source.slice(end, next))) break
		end = next
	}
	while (end < source.length) {
		const next = nextGraphemeBoundary(source, end)
		if (/\s/u.test(source.slice(end, next))) break
		end = next
	}
	return end
}

function deletePreviousWordAt(
	source: string,
	cursor: number,
): { readonly value: string; readonly cursor: number } {
	const start = previousWordBoundary(source, cursor)
	return {
		value: source.slice(0, start) + source.slice(cursor),
		cursor: start,
	}
}

function deleteNextWordAt(
	source: string,
	cursor: number,
): { readonly value: string; readonly cursor: number } {
	const end = nextWordBoundary(source, cursor)
	return { value: source.slice(0, cursor) + source.slice(end), cursor }
}

export function Composer({
	disabled = false,
	onSubmit,
	history,
	userCommands = [],
	mentionCandidates = [],
	hidden = false,
	escapeInterrupts = false,
	onNotice,
	onStepReasoningEffort,
	onExternalEdit,
	onEditPrevious,
	draftToRestore = null,
	onDraftRestored,
	onDraftPresenceChange,
	onOpenAgentPanel,
}: ComposerProps) {
	const terminal = useWindowSize()
	const [value, setValueState] = useState<string>('')
	const valueRef = useRef('')
	const [cursor, setCursorState] = useState(0)
	const cursorRef = useRef(0)
	const [, setHistoryIndexState] = useState<number>(-1)
	const historyIndexRef = useRef(-1)
	const historyDraftRef = useRef<{
		readonly value: string
		readonly cursor: number
	} | null>(null)
	const [historySearch, setHistorySearchState] = useState<HistorySearchState | null>(null)
	const historySearchRef = useRef<HistorySearchState | null>(null)
	const verticalColumnRef = useRef<number | null>(null)
	const killBufferRef = useRef('')
	const [selected, setSelected] = useState<number>(0)
	const selectedRef = useRef(0)
	// Large pastes are held as attachments (shown as chips) instead of being
	// dumped into the input, then folded into the message on submit.
	const [pastes, setPastes] = useState<readonly string[]>([])
	// Pasted images and restored durable attachments, shown as chips and sent
	// back in the exact SDK union on submit.
	const [attachments, setAttachments] = useState<readonly MessageAttachment[]>([])
	const [editPreviousArmed, setEditPreviousArmed] = useState(false)
	const restoredTokenRef = useRef<number | null>(null)
	const draftPresenceRef = useRef(false)

	useEffect(() => {
		const hasDraft =
			value.trim().length > 0 ||
			pastes.some((paste) => paste.trim().length > 0) ||
			attachments.length > 0
		if (hasDraft === draftPresenceRef.current) return
		draftPresenceRef.current = hasDraft
		onDraftPresenceChange?.(hasDraft)
	}, [attachments.length, onDraftPresenceChange, pastes, value])

	// Keep the complete match set. The six-row limit belongs to the rendered
	// window, not to navigation: slicing here made every later command
	// unreachable no matter how many times the operator pressed Down.
	const commandSuggestions = matchSlashCommands(value, userCommands)
	const activeMention = activeFileMention(value, cursor)
	const fileSuggestions = activeMention
		? matchMentionableFiles(activeMention.query, mentionCandidates)
		: []
	const suggestionKind =
		commandSuggestions.length > 0 ? 'command' : fileSuggestions.length > 0 ? 'file' : null
	const suggestionCount =
		suggestionKind === 'command' ? commandSuggestions.length : fileSuggestions.length
	const suggestionWindow = suggestionWindowSize(terminal.rows)
	const selIdx = Math.min(selected, Math.max(0, suggestionCount - 1))
	const suggestionStart = Math.min(
		Math.max(0, selIdx - suggestionWindow + 1),
		Math.max(0, suggestionCount - suggestionWindow),
	)
	const visibleCommandSuggestions = commandSuggestions.slice(
		suggestionStart,
		suggestionStart + suggestionWindow,
	)
	const visibleFileSuggestions = fileSuggestions.slice(
		suggestionStart,
		suggestionStart + suggestionWindow,
	)
	const displayValue = composerDisplayValue(value, cursor)
	const commandColumnWidth = Math.min(
		24,
		Math.max(10, ...visibleCommandSuggestions.map((command) => command.name.length + 4)),
	)

	const setBuffer = useCallback((nextValue: string, nextCursor = nextValue.length) => {
		valueRef.current = nextValue
		cursorRef.current = nextCursor
		setValueState(nextValue)
		setCursorState(nextCursor)
	}, [])

	const setHistoryIndex = useCallback((next: number) => {
		historyIndexRef.current = next
		setHistoryIndexState(next)
	}, [])

	const setHistorySearch = useCallback((next: HistorySearchState | null) => {
		historySearchRef.current = next
		setHistorySearchState(next)
	}, [])

	const setSelectedIndex = useCallback((next: number | ((current: number) => number)) => {
		const resolved = typeof next === 'function' ? next(selectedRef.current) : next
		selectedRef.current = resolved
		setSelected(resolved)
	}, [])

	const editBuffer = useCallback(
		(nextValue: string, nextCursor = nextValue.length) => {
			verticalColumnRef.current = null
			historyDraftRef.current = null
			setHistorySearch(null)
			setHistoryIndex(-1)
			setBuffer(nextValue, nextCursor)
		},
		[setBuffer, setHistoryIndex, setHistorySearch],
	)

	const reset = useCallback(() => {
		verticalColumnRef.current = null
		historyDraftRef.current = null
		setHistorySearch(null)
		setBuffer('', 0)
		setHistoryIndex(-1)
		setSelectedIndex(0)
		setPastes([])
		setAttachments([])
		setEditPreviousArmed(false)
	}, [setBuffer, setHistoryIndex, setHistorySearch, setSelectedIndex])

	useEffect(() => {
		if (!draftToRestore || restoredTokenRef.current === draftToRestore.token) return
		restoredTokenRef.current = draftToRestore.token
		setBuffer(draftToRestore.text)
		setHistoryIndex(-1)
		setSelectedIndex(0)
		verticalColumnRef.current = null
		historyDraftRef.current = null
		setHistorySearch(null)
		setPastes([])
		setAttachments(draftToRestore.attachments ? [...draftToRestore.attachments] : [])
		setEditPreviousArmed(false)
		onDraftRestored?.(draftToRestore.token)
	}, [
		draftToRestore,
		onDraftRestored,
		setBuffer,
		setHistoryIndex,
		setHistorySearch,
		setSelectedIndex,
	])

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
			const liveCommandSuggestions = matchSlashCommands(valueRef.current, userCommands)
			const liveMention = activeFileMention(valueRef.current, cursorRef.current)
			const liveFileSuggestions = liveMention
				? matchMentionableFiles(liveMention.query, mentionCandidates)
				: []
			const liveSuggestionKind =
				liveCommandSuggestions.length > 0
					? 'command'
					: liveFileSuggestions.length > 0
						? 'file'
						: null
			const liveSuggestionCount =
				liveSuggestionKind === 'command'
					? liveCommandSuggestions.length
					: liveFileSuggestions.length
			const hasLiveSuggestions = liveSuggestionKind !== null
			const liveSelection = Math.min(selectedRef.current, Math.max(0, liveSuggestionCount - 1))
			const acceptSuggestion = (): boolean => {
				if (liveSuggestionKind === 'command') {
					editBuffer(`/${liveCommandSuggestions[liveSelection]?.name ?? ''} `)
					setSelectedIndex(0)
					return true
				}
				if (liveSuggestionKind === 'file' && liveMention) {
					const path = liveFileSuggestions[liveSelection]
					if (!path) return false
					const replacement = `@${path} `
					editBuffer(
						valueRef.current.slice(0, liveMention.start) +
							replacement +
							valueRef.current.slice(liveMention.end),
						liveMention.start + replacement.length,
					)
					setSelectedIndex(0)
					return true
				}
				return false
			}
			if (
				!hasLiveSuggestions &&
				onStepReasoningEffort &&
				((key.shift && key.downArrow) || (key.meta && input === ','))
			) {
				onStepReasoningEffort('lower')
				return
			}
			if (
				!hasLiveSuggestions &&
				onStepReasoningEffort &&
				((key.shift && key.upArrow) || (key.meta && input === '.'))
			) {
				onStepReasoningEffort('raise')
				return
			}
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
			if ((key.return && (key.shift || key.meta)) || input === '\n') {
				const position = cursorRef.current
				editBuffer(
					valueRef.current.slice(0, position) + '\n' + valueRef.current.slice(position),
					position + 1,
				)
				return
			}
			if (key.ctrl && (input === 'r' || input === 's')) {
				verticalColumnRef.current = null
				const browsedHistoryDraft = historyDraftRef.current
				historyDraftRef.current = null
				setHistoryIndex(-1)
				let search = historySearchRef.current
				if (!search) {
					const query = valueRef.current
					const normalizedQuery = query.toLowerCase()
					search = {
						draft: browsedHistoryDraft ?? {
							value: query,
							cursor: cursorRef.current,
						},
						query,
						matches: [...history]
							.reverse()
							.filter((entry) => entry.toLowerCase().includes(normalizedQuery)),
						position: -1,
					}
				}
				const position =
					input === 'r'
						? Math.min(search.position + 1, search.matches.length - 1)
						: Math.max(search.position - 1, -1)
				const next = { ...search, position }
				setHistorySearch(next)
				if (position < 0) setBuffer(next.draft.value, next.draft.cursor)
				else setBuffer(next.matches[position] ?? next.draft.value)
				return
			}
			if (key.return) {
				if (liveSuggestionKind === 'command') {
					// Run the highlighted command.
					onSubmit(`/${liveCommandSuggestions[liveSelection]?.name ?? ''}`)
					reset()
					return
				}
				if (acceptSuggestion()) return
				submit('submit')
				return
			}
			if (key.tab) {
				if (acceptSuggestion()) return
				submit('queue')
				return
			}
			if (key.escape) {
				// A running turn owns Esc. App aborts it on this same keypress,
				// and clearing the draft too would punish the operator for
				// following the hint the status bar is showing them.
				if (escapeInterrupts) return
				const activeSearch = historySearchRef.current
				if (activeSearch) {
					setBuffer(activeSearch.draft.value, activeSearch.draft.cursor)
					setHistorySearch(null)
					return
				}
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
			if (key.backspace && (key.meta || key.ctrl)) {
				const source = valueRef.current
				const position = cursorRef.current
				const start = previousWordBoundary(source, position)
				if (start < position) killBufferRef.current = source.slice(start, position)
				const result = deletePreviousWordAt(valueRef.current, cursorRef.current)
				editBuffer(result.value, result.cursor)
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
				editBuffer(valueRef.current.slice(0, previous) + valueRef.current.slice(position), previous)
				return
			}
			if (key.delete || (key.ctrl && input === 'd')) {
				const position = cursorRef.current
				const next = nextGraphemeBoundary(valueRef.current, position)
				editBuffer(valueRef.current.slice(0, position) + valueRef.current.slice(next), position)
				return
			}
			if ((key.leftArrow && (key.meta || key.ctrl)) || (key.meta && input === 'b')) {
				verticalColumnRef.current = null
				const previous = previousWordBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = previous
				setCursorState(previous)
				return
			}
			if ((key.rightArrow && (key.meta || key.ctrl)) || (key.meta && input === 'f')) {
				verticalColumnRef.current = null
				const next = nextWordBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = next
				setCursorState(next)
				return
			}
			if (key.leftArrow || (key.ctrl && input === 'b')) {
				verticalColumnRef.current = null
				const previous = previousGraphemeBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = previous
				setCursorState(previous)
				return
			}
			if (key.rightArrow || (key.ctrl && input === 'f')) {
				verticalColumnRef.current = null
				const next = nextGraphemeBoundary(valueRef.current, cursorRef.current)
				cursorRef.current = next
				setCursorState(next)
				return
			}
			if (hasLiveSuggestions && (key.home || key.end || key.pageUp || key.pageDown)) {
				if (key.home) setSelectedIndex(0)
				else if (key.end) setSelectedIndex(liveSuggestionCount - 1)
				else if (key.pageUp) setSelectedIndex((index) => Math.max(0, index - suggestionWindow))
				else
					setSelectedIndex((index) => Math.min(liveSuggestionCount - 1, index + suggestionWindow))
				return
			}
			if (key.home || (key.ctrl && input === 'a')) {
				verticalColumnRef.current = null
				const start = lineStart(valueRef.current, cursorRef.current)
				cursorRef.current = start
				setCursorState(start)
				return
			}
			if (key.end || (key.ctrl && input === 'e')) {
				verticalColumnRef.current = null
				const end = lineEnd(valueRef.current, cursorRef.current)
				cursorRef.current = end
				setCursorState(end)
				return
			}
			if (key.upArrow || (key.ctrl && input === 'p')) {
				if (hasLiveSuggestions) {
					setSelectedIndex((i) => Math.max(0, i - 1))
					return
				}
				const vertical = verticalCursor(
					valueRef.current,
					cursorRef.current,
					-1,
					verticalColumnRef.current ?? undefined,
				)
				if (vertical) {
					verticalColumnRef.current = vertical.column
					cursorRef.current = vertical.cursor
					setCursorState(vertical.cursor)
					return
				}
				verticalColumnRef.current = null
				if (history.length === 0) return
				if (historyIndexRef.current < 0) {
					historyDraftRef.current = {
						value: valueRef.current,
						cursor: cursorRef.current,
					}
				}
				const next = Math.min(historyIndexRef.current + 1, history.length - 1)
				setHistoryIndex(next)
				setBuffer(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.downArrow || (key.ctrl && input === 'n')) {
				if (hasLiveSuggestions) {
					setSelectedIndex((i) => Math.min(liveSuggestionCount - 1, i + 1))
					return
				}
				const vertical = verticalCursor(
					valueRef.current,
					cursorRef.current,
					1,
					verticalColumnRef.current ?? undefined,
				)
				if (vertical) {
					verticalColumnRef.current = vertical.column
					cursorRef.current = vertical.cursor
					setCursorState(vertical.cursor)
					return
				}
				verticalColumnRef.current = null
				if (historyIndexRef.current < 0) {
					if (valueRef.current.length === 0 && pastes.length === 0 && attachments.length === 0) {
						onOpenAgentPanel?.()
					}
					return
				}
				if (historyIndexRef.current === 0) {
					const draft = historyDraftRef.current
					historyDraftRef.current = null
					setHistoryIndex(-1)
					setBuffer(draft?.value ?? '', draft?.cursor ?? 0)
					return
				}
				const next = historyIndexRef.current - 1
				setHistoryIndex(next)
				setBuffer(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.ctrl && input === 'g') {
				if (!onExternalEdit) {
					onNotice?.('External editor support is unavailable in this terminal.')
					return
				}
				const seed = [valueRef.current, ...pastes]
					.map((part) => part.trim())
					.filter(Boolean)
					.join('\n\n')
				void onExternalEdit(seed)
					.then((edited) => {
						const cleaned = edited.trimEnd()
						setPastes([])
						setHistoryIndex(-1)
						setHistorySearch(null)
						setSelectedIndex(0)
						editBuffer(cleaned, cleaned.length)
					})
					.catch((error: unknown) => {
						onNotice?.(
							`Cannot open external editor: ${error instanceof Error ? error.message : String(error)}`,
						)
					})
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
				const source = valueRef.current
				const position = cursorRef.current
				const start = previousWordBoundary(source, position)
				if (start < position) killBufferRef.current = source.slice(start, position)
				const result = deletePreviousWordAt(valueRef.current, cursorRef.current)
				editBuffer(result.value, result.cursor)
				return
			}
			if (key.ctrl && input === 'u') {
				const position = cursorRef.current
				const start = lineStart(valueRef.current, position)
				if (start < position) killBufferRef.current = valueRef.current.slice(start, position)
				editBuffer(valueRef.current.slice(0, start) + valueRef.current.slice(position), start)
				return
			}
			if (key.ctrl && input === 'k') {
				const position = cursorRef.current
				const end = lineEnd(valueRef.current, position)
				if (position < end) killBufferRef.current = valueRef.current.slice(position, end)
				editBuffer(valueRef.current.slice(0, position) + valueRef.current.slice(end), position)
				return
			}
			if (key.meta && input === 'd') {
				const source = valueRef.current
				const position = cursorRef.current
				const end = nextWordBoundary(source, position)
				if (position < end) killBufferRef.current = source.slice(position, end)
				const result = deleteNextWordAt(valueRef.current, cursorRef.current)
				editBuffer(result.value, result.cursor)
				return
			}
			if (key.ctrl && input === 'y') {
				const killed = killBufferRef.current
				if (killed.length === 0) return
				const position = cursorRef.current
				editBuffer(
					valueRef.current.slice(0, position) + killed + valueRef.current.slice(position),
					position + killed.length,
				)
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
			setSelectedIndex(0)
			const position = cursorRef.current
			editBuffer(
				valueRef.current.slice(0, position) + input + valueRef.current.slice(position),
				position + input.length,
			)
		},
		{ isActive: !disabled && !hidden },
	)

	// After every hook, so the component keeps its state while it is off screen.
	// This is the whole fix: React preserves a mounted component's state, and
	// preserving it is what an unmounting ternary could not do.
	if (hidden) return null

	const promptGlyph = disabled ? '…' : '>'
	const showPlaceholder = !disabled && value.length === 0 && !editPreviousArmed
	const historySearchQuery = historySearch
		? composerDisplayValue(historySearch.query, historySearch.query.length)
		: null
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
			{historySearch && historySearchQuery ? (
				<Box paddingX={1} paddingTop={1}>
					<Text color={theme.text.muted}>
						history “{historySearchQuery.leadingEllipsis ? '… ' : ''}
						{historySearchQuery.before}” ·{' '}
						{historySearch.position < 0
							? `draft · ${historySearch.matches.length} match${historySearch.matches.length === 1 ? '' : 'es'}`
							: `${historySearch.position + 1}/${historySearch.matches.length}`}{' '}
						· Ctrl+R older · Ctrl+S newer · Esc restore
					</Text>
				</Box>
			) : null}
			{suggestionKind === 'command' ? (
				<Box flexDirection="column" paddingX={1} paddingTop={1} width="100%">
					{visibleCommandSuggestions.map((cmd, i) => {
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
					<Text color={theme.text.muted}>
						{selIdx + 1}/{commandSuggestions.length} · ↑↓ navigate · PgUp/PgDn jump · Enter run ·
						Tab complete
					</Text>
				</Box>
			) : suggestionKind === 'file' ? (
				<Box flexDirection="column" paddingX={1} paddingTop={1} width="100%">
					{visibleFileSuggestions.map((path, i) => {
						const absoluteIndex = suggestionStart + i
						return (
							<Text
								key={path}
								color={absoluteIndex === selIdx ? theme.accent.user : theme.text.secondary}
								bold={absoluteIndex === selIdx}
							>
								{absoluteIndex === selIdx ? '› ' : '  '}@{path}
							</Text>
						)
					})}
					<Text color={theme.text.muted}>
						{selIdx + 1}/{fileSuggestions.length} · ↑↓ navigate · PgUp/PgDn jump · Enter/Tab insert
					</Text>
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
