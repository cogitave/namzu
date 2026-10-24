/**
 * Single-line composer with input history and slash-command autocomplete.
 * Ink `useInput` covers all keys we need; no extra `ink-text-input` dep.
 *
 * Keys: Enter submits/steers (or runs the highlighted command while the
 * autocomplete dropdown is open), tab completes that command or queues the
 * draft, Esc clears / closes the dropdown, ↑/↓ navigate the dropdown when open
 * else browse history, Ctrl+R/Ctrl+S search history, Ctrl+W rubs out a word,
 * Ctrl+G edits the draft in VISUAL/EDITOR, Alt+Up recalls the latest queued
 * message into an empty composer, Backspace deletes, Alt+W drops or
 * arms the composer trigger nearest the cursor (`./triggers/`).
 */

import type { MessageAttachment } from '@namzu/sdk'
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { readClipboardImage } from '../integrations/clipboard/image.js'
import type { UserCommand } from '../user-commands/store.js'
import { QUEUED_HINT, QUEUED_HINT_LIMIT } from './composer-hints.js'
import { fitHints } from './key-hints.js'
import { activeFileMention, matchMentionableFiles, mentionText } from './mentions.js'
import { parseModelSelectionIntent } from './model-selection-intent.js'
import {
	attachmentChip,
	chipBefore,
	expandChips,
	isChipPaste,
	pasteChip,
	stripAttachmentChips,
} from './paste-chips.js'
import { explainFailure } from './plain-failure.js'
import { type SlashCommand, matchSlashCommands } from './slashCommands.js'
import { wrapChoiceText } from './terminal-choice-text.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import { tagRow } from './triggers/copy.js'
import {
	type Detection,
	EMPTY_DETECTION,
	type TriggerContext,
	type TriggerHit,
	detectTriggers,
} from './triggers/detect.js'
import {
	type EditOrigin,
	type Span,
	type TriggerOverride,
	applyEdit,
	diffEdit,
	overrideMap,
	replaceAll,
	shiftOverrides,
} from './triggers/provenance.js'
import type { TriggerId, TriggerRegistry } from './triggers/registry.js'

export interface ComposerProps {
	readonly disabled?: boolean
	/** A bounded text editor for a child conversation, without host commands or image attachments. */
	readonly plainText?: boolean
	readonly placeholder?: string
	/** Keep an operator draft when the host changes which child it displays. */
	readonly onDraftChange?: (draft: Omit<ComposerDraft, 'token'>) => void
	readonly reasoningEffortLevels?: readonly string[]
	readonly onSubmit: (
		value: string,
		attachments: readonly MessageAttachment[] | undefined,
		mode: ComposerSubmitMode,
		meta: SubmitMeta,
	) => void
	readonly history: readonly string[]
	/** Operator-defined commands, offered in the dropdown alongside builtins. */
	readonly userCommands?: readonly UserCommand[]
	/** The command vocabulary actually available in this session. */
	readonly builtins?: readonly SlashCommand[]
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
	/**
	 * Empty-composer ↓ opens the currently active delegated-work panel.
	 *
	 * The result is deliberately not read here. Opening may have to wait on a
	 * read of what finished children left on disk, so whether anything opened
	 * is the host's answer to give, not a value this key press can hold.
	 */
	readonly onOpenAgentPanel?: () => void
	/**
	 * `←` on an empty composer: open the agents. Anything typed, pasted or
	 * attached keeps `←` as cursor movement, so editing is never taken over.
	 */
	readonly onOpenAgents?: () => void
	/** Page up at the composer: open the scrollable transcript. */
	readonly onScrollTranscript?: () => void
	/** Recall the latest operator-authored next-turn message into an empty draft. */
	readonly onRecallQueued?: () => Omit<ComposerDraft, 'token'> | null
	/**
	 * Messages typed while a reply runs and still waiting. Up on an empty
	 * draft chooses the newest editable one, Up/Down move, Enter loads the
	 * chosen one into the draft, Esc (handled by the host) leaves the choice.
	 */
	readonly queuedEdit?: {
		/** At least one waiting message can be loaded back for editing. */
		readonly available: boolean
		/** A waiting message is chosen right now. */
		readonly selected: boolean
		/** Returns whether the key was used; false lets Up fall through to prompt history. */
		readonly onMove: (direction: 'up' | 'down') => boolean
		readonly onLoad: () => Omit<ComposerDraft, 'token'> | null
		readonly onLeave: () => void
	}
	/** ctrl+x ctrl+s: deliver the waiting messages now instead of at the next boundary. */
	readonly onSendNow?: () => void
	/** Shift+Tab. Absent means the key does nothing, which the composer footer then does not advertise. */
	readonly onCycleMode?: () => void
	/**
	 * Composer triggers (`./triggers/`). Absent means the feature is off: no
	 * highlight, no tag row, and every submit carries no triggers.
	 */
	readonly triggers?: ComposerTriggerSettings
	/** A turn is running, so Enter steers into it; the tag row says what that means for a trigger. */
	readonly turnActive?: boolean
}

export interface ComposerTriggerSettings {
	readonly registry: TriggerRegistry
	/** Show suggestions (`composerTriggers.suggest`). */
	readonly suggest: boolean
	readonly context: TriggerContext
	/** The model's highest published effort level, named in the tag row by the max-effort trigger. */
	readonly highestEffort?: string
	/** The level hypermode pins on this model (`xhigh`, or the nearest below it), named in its tag. */
	readonly hypermodeEffort?: string
}

/** Return addresses the active turn; Tab deliberately addresses the follow-up queue. */
export type ComposerSubmitMode = 'submit' | 'queue'

/**
 * Where a submitted line came from. Every caller of the App's submit path
 * names one; none is optional, so a new caller cannot inherit the operator's
 * authority by leaving an argument out.
 *
 * - `composer`: the operator's own keys in this composer, sent with Enter or Tab.
 * - `composer-dropdown`: a command the operator ran from the slash dropdown.
 * - `command-picker`: a command a picker or menu re-entered through the command path.
 * - `operator-loop`: a `/loop` the operator made, firing.
 * - `model-loop`: a loop the model made with `session_loop`, firing. Its text
 *   is always a plain prompt: never a `/` command, a `!` shell line, a `#`
 *   memory note or a model switch, and never an entry in composer history.
 * - `launch-message`: the `--message` text of this launch, sent once. Like a loop's text it is a
 *   plain prompt (a leading `/`, `!` or `#` is not a command), but it is the operator's own
 *   words, so it is kept in history.
 */
export type SubmitSource =
	| 'composer'
	| 'composer-dropdown'
	| 'command-picker'
	| 'operator-loop'
	| 'model-loop'
	| 'launch-message'

/**
 * A trigger armed when the operator pressed Enter or Tab, with its words'
 * offsets in the message as sent (the trimmed text `onSubmit` receives).
 */
export interface ArmedTrigger {
	readonly id: TriggerId
	readonly start: number
	readonly end: number
}

/**
 * Only the composer's own submit can carry triggers: the type has no
 * `triggers` for any other source, so a loop, a picker or a menu cannot arm
 * one by passing an argument.
 */
export type SubmitMeta =
	| {
			readonly source: 'composer'
			readonly triggers: readonly ArmedTrigger[]
			/**
			 * The message is nothing but armed triggers and filler words, with no
			 * paste chip or attachment: a standalone trigger runs its command.
			 */
			readonly onlyTriggers: boolean
	  }
	| { readonly source: Exclude<SubmitSource, 'composer'> }

export interface ComposerDraft {
	readonly token: number
	readonly text: string
	readonly attachments?: readonly MessageAttachment[]
	/** Keep a queued message's explicit trigger decisions when it is recalled. */
	readonly triggers?: readonly TriggerId[]
}

const MIN_SUGGESTIONS = 6
const MAX_SUGGESTIONS = 12
const SUGGESTION_FURNITURE_ROWS = 12
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
	/** The window of the source drawn, `[start, end)`. */
	readonly start: number
	readonly end: number
}

/** A run of the drawn draft, styled when it is a trigger's words. */
interface DisplaySegment {
	readonly text: string
	readonly style?: 'armed' | 'unavailable'
}

/**
 * `source[from, to)` cut at trigger words, each piece made terminal-safe on
 * its own. Escaping after cutting, never before, is what keeps the highlight
 * on the right cells: `terminalDisplayText` turns one unsafe code point into
 * several characters, and offsets into the source would miss them.
 */
function displaySegments(
	source: string,
	from: number,
	to: number,
	styled: readonly {
		readonly start: number
		readonly end: number
		readonly style: 'armed' | 'unavailable'
	}[],
): DisplaySegment[] {
	const segments: DisplaySegment[] = []
	let at = from
	for (const span of styled) {
		const start = Math.max(from, span.start)
		const end = Math.min(to, span.end)
		if (end <= start || start < at) continue
		if (start > at) segments.push({ text: terminalDisplayText(source.slice(at, start)) })
		segments.push({ text: terminalDisplayText(source.slice(start, end)), style: span.style })
		at = end
	}
	if (to > at) segments.push({ text: terminalDisplayText(source.slice(at, to)) })
	return segments
}

function renderSegments(segments: readonly DisplaySegment[]) {
	return segments.map((segment, index) =>
		segment.style ? (
			<Text
				// biome-ignore lint/suspicious/noArrayIndexKey: segments of one draft, in order.
				key={index}
				color={segment.style === 'armed' ? theme.accent.trigger : theme.status.warn}
				bold={segment.style === 'armed'}
				underline={segment.style === 'armed'}
			>
				{segment.text}
			</Text>
		) : (
			segment.text
		),
	)
}

interface SavedDraft {
	readonly value: string
	readonly cursor: number
	/** Which of its characters were not typed here (`./triggers/provenance.ts`). */
	readonly spans: readonly Span[]
}

interface HistorySearchState {
	readonly draft: SavedDraft
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

/**
 * A command's description in at most two lines at this width.
 *
 * The menu budgets two rows for each option, and a description that wraps to
 * four at 40 columns pushed the menu past the top of the screen. The last line
 * ends in `…` where the description goes on, so nothing is cut without saying so.
 */
export function clampDescription(description: string, width: number): readonly string[] {
	const lines = wrapChoiceText(description, width)
	if (lines.length <= 2) return lines
	const second = lines[1] ?? ''
	const room = Math.max(1, width - 1)
	const cut =
		second.length > room
			? second.slice(0, room).replace(/\s+\S*$/, '') || second.slice(0, room)
			: second
	return [lines[0] ?? '', `${cut.trimEnd()}…`]
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

function composerDisplayValue(
	source: string,
	cursor: number,
	codeUnits = COMPOSER_DISPLAY_CODE_UNITS,
	lines = COMPOSER_DISPLAY_LINES,
): ComposerDisplay {
	let start = Math.max(0, cursor - Math.floor(codeUnits / 2))
	let end = Math.min(source.length, start + codeUnits)
	if (end === source.length) start = Math.max(0, end - codeUnits)
	if (cursor > end) {
		end = cursor
		start = Math.max(0, end - codeUnits)
	}

	let afterBreaks = 0
	for (let index = cursor; index < end; index += 1) {
		if (source.charCodeAt(index) !== 0x0a) continue
		afterBreaks += 1
		if (afterBreaks === Math.min(3, lines - 1)) {
			end = index
			break
		}
	}
	let beforeBreaks = 0
	const beforeBudget = lines - afterBreaks
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
		start,
		end,
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
	plainText = false,
	placeholder = 'Type a message… (/help for commands)',
	onDraftChange,
	reasoningEffortLevels,
	onSubmit,
	history,
	userCommands = [],
	builtins,
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
	onOpenAgents,
	onScrollTranscript,
	onRecallQueued,
	queuedEdit,
	onSendNow,
	onCycleMode,
	triggers,
	turnActive = false,
}: ComposerProps) {
	const terminal = useWindowSize()
	const [value, setValueState] = useState<string>('')
	const valueRef = useRef('')
	const [cursor, setCursorState] = useState(0)
	const cursorRef = useRef(0)
	const [, setHistoryIndexState] = useState<number>(-1)
	const historyIndexRef = useRef(-1)
	const historyDraftRef = useRef<SavedDraft | null>(null)
	// Characters of the draft not typed here, and Alt+W decisions. Refs, so
	// submit reads what the last key left; `triggerVersion` re-renders when
	// only an Alt+W decision changed.
	const spansRef = useRef<readonly Span[]>([])
	const overridesRef = useRef<readonly TriggerOverride[]>([])
	const [triggerVersion, setTriggerVersion] = useState(0)
	const [historySearch, setHistorySearchState] = useState<HistorySearchState | null>(null)
	const historySearchRef = useRef<HistorySearchState | null>(null)
	const verticalColumnRef = useRef<number | null>(null)
	const killBufferRef = useRef('')
	const [selected, setSelected] = useState<number>(0)
	const selectedRef = useRef(0)
	// A large paste stands in the text as a chip such as `[Pasted text #1 +40 lines]`;
	// what it stands for is held here and put back when the message is sent.
	const pasteStoreRef = useRef<Map<number, string>>(new Map())
	const nextPasteIdRef = useRef(1)
	const queuedHintEpisodeRef = useRef({ active: false, show: false })
	const queuedHintShownRef = useRef(0)
	const [queuedHintShow, setQueuedHintShow] = useState(false)
	const clearPastes = useCallback(() => {
		pasteStoreRef.current = new Map()
		nextPasteIdRef.current = 1
	}, [])
	// Pasted images and restored durable attachments, shown as chips and sent
	// back in the exact SDK union on submit.
	const [attachments, setAttachments] = useState<readonly MessageAttachment[]>([])
	const attachmentsRef = useRef<readonly MessageAttachment[]>([])
	// A chip's number is the attachment's own id, fixed when it joins: deleting
	// an earlier chip never renumbers the ones that stay, and a new one never
	// reuses a label still in the text.
	const attachmentIdsRef = useRef<WeakMap<MessageAttachment, number>>(new WeakMap())
	const nextAttachmentIdRef = useRef(1)
	const idFor = useCallback((attachment: MessageAttachment): number => {
		let id = attachmentIdsRef.current.get(attachment)
		if (id === undefined) {
			id = nextAttachmentIdRef.current
			nextAttachmentIdRef.current += 1
			attachmentIdsRef.current.set(attachment, id)
		}
		return id
	}, [])
	const replaceAttachments = useCallback(
		(
			next:
				| readonly MessageAttachment[]
				| ((previous: readonly MessageAttachment[]) => readonly MessageAttachment[]),
		) => {
			const resolved = typeof next === 'function' ? next(attachmentsRef.current) : next
			attachmentsRef.current = resolved
			// With nothing left attached the numbering starts over.
			if (resolved.length === 0) nextAttachmentIdRef.current = 1
			setAttachments(resolved)
		},
		[],
	)
	const [editPreviousArmed, setEditPreviousArmed] = useState(false)
	const restoredTokenRef = useRef<number | null>(null)
	const draftPresenceRef = useRef(false)
	useEffect(() => {
		onDraftChange?.({
			text: expandChips(value, pasteStoreRef.current),
			...(attachments.length ? { attachments } : {}),
		})
	}, [attachments, onDraftChange, value])

	// An attachment whose chip left the text by any route (Backspace, Ctrl+W,
	// Ctrl+U, a selection delete) is no longer part of the draft.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger; the check reads the ref.
	useEffect(() => {
		// Read the ref, not the render's value: a restore sets both in one step.
		const current = valueRef.current
		const kept = attachmentsRef.current.filter((attachment) =>
			current.includes(chipFor(attachment, idFor(attachment))),
		)
		if (kept.length !== attachmentsRef.current.length) replaceAttachments(kept)
	}, [idFor, replaceAttachments, value])

	useEffect(() => {
		const hasDraft = value.trim().length > 0 || attachments.length > 0
		if (hasDraft === draftPresenceRef.current) return
		draftPresenceRef.current = hasDraft
		onDraftPresenceChange?.(hasDraft)
	}, [attachments.length, onDraftPresenceChange, value])

	// Keep the complete match set. The six-row limit belongs to the rendered
	// window, not to navigation: slicing here made every later command
	// unreachable no matter how many times the operator pressed Down.
	const commandSuggestions = plainText ? [] : matchSlashCommands(value, userCommands, builtins)
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
	const displayValue = plainText
		? composerDisplayValue(
				value,
				cursor,
				Math.max(1, Math.floor(((terminal.columns ?? 80) - 12) / 2)),
				2,
			)
		: composerDisplayValue(value, cursor)
	const commandColumnWidth = Math.min(
		24,
		Math.max(10, ...visibleCommandSuggestions.map((command) => command.name.length + 4)),
	)
	// The menu sits inside the message frame: its border and padding take four
	// columns and the menu's own padding two more.
	const menuTextWidth = Math.max(1, (terminal.columns ?? 80) - 6)
	const descriptionWidth = Math.max(8, menuTextWidth - commandColumnWidth - 1)

	/**
	 * Replace the whole draft. `spans` says which characters were not typed
	 * here; absent, the whole text counts as `origin`. Alt+W decisions belong
	 * to the text they were made on and go with it.
	 */
	const setBuffer = useCallback(
		(
			nextValue: string,
			nextCursor = nextValue.length,
			origin: EditOrigin = 'recalled',
			spans?: readonly Span[],
		) => {
			valueRef.current = nextValue
			cursorRef.current = nextCursor
			spansRef.current = spans ?? replaceAll(nextValue.length, origin)
			overridesRef.current = []
			setValueState(nextValue)
			setCursorState(nextCursor)
		},
		[],
	)

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

	/** The triggers `draft` names, read with this draft's provenance and Alt+W decisions. */
	const detect = (draft: string): Detection =>
		triggers
			? detectTriggers(draft, triggers.registry, triggers.context, {
					nonTyped: spansRef.current,
					overrides: overrideMap(overridesRef.current),
					suggest: triggers.suggest,
				})
			: EMPTY_DETECTION

	const setOverride = (hit: TriggerHit, state: TriggerOverride['state'] | null) => {
		const others = overridesRef.current.filter(
			(override) => !(override.id === hit.id && override.start === hit.start),
		)
		overridesRef.current =
			state === null ? others : [...others, { id: hit.id, start: hit.start, end: hit.end, state }]
		setTriggerVersion((version) => version + 1)
	}

	/** Alt+W: the trigger nearest the cursor changes state. */
	const toggleNearestTrigger = () => {
		const cursor = cursorRef.current
		const distance = (hit: TriggerHit) =>
			cursor < hit.start ? hit.start - cursor : cursor > hit.end ? cursor - hit.end : 0
		const nearest = [...detect(valueRef.current).hits].sort((a, b) => distance(a) - distance(b))[0]
		if (!nearest) return
		const decided = overridesRef.current.some(
			(override) => override.id === nearest.id && override.start === nearest.start,
		)
		if (decided) setOverride(nearest, null)
		else if (nearest.state === 'suggested') setOverride(nearest, 'armed')
		else setOverride(nearest, 'dropped')
	}

	/**
	 * One edit of the draft, by the operator (`typed`) or not. The characters
	 * it inserts are remembered as typed or not, and the draft's other spans
	 * and Alt+W decisions move with it.
	 */
	const editBuffer = useCallback(
		(nextValue: string, nextCursor = nextValue.length, origin: EditOrigin = 'typed') => {
			verticalColumnRef.current = null
			historyDraftRef.current = null
			setHistorySearch(null)
			setHistoryIndex(-1)
			const edit = diffEdit(valueRef.current, nextValue, cursorRef.current)
			const spans = applyEdit(spansRef.current, edit, origin)
			const overrides = shiftOverrides(overridesRef.current, edit)
			setBuffer(nextValue, nextCursor, origin, spans)
			overridesRef.current = overrides
		},
		[setBuffer, setHistoryIndex, setHistorySearch],
	)

	const reset = useCallback(() => {
		verticalColumnRef.current = null
		historyDraftRef.current = null
		setHistorySearch(null)
		setBuffer('', 0, 'typed')
		setHistoryIndex(-1)
		setSelectedIndex(0)
		clearPastes()
		replaceAttachments([])
		setEditPreviousArmed(false)
	}, [
		clearPastes,
		replaceAttachments,
		setBuffer,
		setHistoryIndex,
		setHistorySearch,
		setSelectedIndex,
	])

	const sendNowChordRef = useRef(false)
	/** Restore synchronously when Alt+Up is pressed, before the next typed key. */
	const restoreDraft = useCallback(
		(draft: Omit<ComposerDraft, 'token'>) => {
			// A stored image has no chip in text that never showed it: add one.
			let restoredText = draft.text
			const restoredAttachments = draft.attachments ? [...draft.attachments] : []
			nextAttachmentIdRef.current = 1
			attachmentIdsRef.current = new WeakMap()
			restoredAttachments.forEach((attachment) => {
				const chip = chipFor(attachment, idFor(attachment))
				if (!restoredText.includes(chip))
					restoredText = `${chip}${restoredText ? ' ' : ''}${restoredText}`
			})
			clearPastes()
			setBuffer(restoredText, restoredText.length, 'restored')
			if (triggers && draft.triggers?.length) {
				const selected = new Set(draft.triggers)
				const hits = detectTriggers(draft.text, triggers.registry, triggers.context, {
					nonTyped: spansRef.current,
					suggest: true,
				}).hits
				overridesRef.current = hits
					.filter((hit) => selected.has(hit.id))
					.map((hit) => ({ id: hit.id, start: hit.start, end: hit.end, state: 'armed' as const }))
				setTriggerVersion((version) => version + 1)
			}
			setHistoryIndex(-1)
			setSelectedIndex(0)
			verticalColumnRef.current = null
			historyDraftRef.current = null
			setHistorySearch(null)
			replaceAttachments(restoredAttachments)
			setEditPreviousArmed(false)
		},
		[
			idFor,
			clearPastes,
			replaceAttachments,
			setBuffer,
			setHistoryIndex,
			setHistorySearch,
			setSelectedIndex,
			triggers,
		],
	)

	useLayoutEffect(() => {
		if (!draftToRestore || restoredTokenRef.current === draftToRestore.token) return
		restoredTokenRef.current = draftToRestore.token
		restoreDraft(draftToRestore)
		onDraftRestored?.(draftToRestore.token)
	}, [draftToRestore, onDraftRestored, restoreDraft])

	/** Hold a large paste beside the draft and return the chip that stands for it. */
	const holdPaste = (text: string): string => {
		const id = nextPasteIdRef.current
		nextPasteIdRef.current += 1
		pasteStoreRef.current.set(id, text)
		return pasteChip(id, text)
	}

	// Bracketed paste is one event even when the terminal splits its bytes.
	// Its newlines are content, never Enter/shortcut events.
	usePaste(
		(text) => {
			if (disabled || hidden) return
			const normalized = text.replace(/\r\n?/g, '\n')
			if (normalized.length === 0) return
			const position = cursorRef.current
			setSelectedIndex(0)
			const inserted = isChipPaste(normalized, terminal.rows ?? 24)
				? holdPaste(normalized)
				: normalized
			editBuffer(
				valueRef.current.slice(0, position) + inserted + valueRef.current.slice(position),
				position + inserted.length,
				'pasted',
			)
		},
		{ isActive: !disabled && !hidden },
	)

	useInput(
		(input, key) => {
			// Hidden means the screen belongs to something else, so a keypress
			// aimed at that must not also land here.
			if (disabled || hidden) return
			// ctrl+x ctrl+s, a two-key chord: any other key in between drops it.
			const chordArmed = sendNowChordRef.current
			sendNowChordRef.current = false
			if (key.ctrl && input === 'x') {
				sendNowChordRef.current = true
				return
			}
			if (chordArmed && key.ctrl && input === 's' && onSendNow) {
				onSendNow()
				return
			}
			if (queuedEdit) {
				const empty = valueRef.current.length === 0 && attachmentsRef.current.length === 0
				// Read from the host's ref, not the last render: Up then Enter can arrive together.
				if (empty && key.return && !key.shift && !key.meta) {
					const loaded = queuedEdit.onLoad()
					if (loaded) {
						restoreDraft(loaded)
						return
					}
				}
				if (queuedEdit.selected) {
					if (key.upArrow && !key.meta && !key.shift) {
						queuedEdit.onMove('up')
						return
					}
					if (key.downArrow && !key.shift) {
						queuedEdit.onMove('down')
						return
					}
					// Esc is the host's: it clears the choice on the same keypress.
					if (key.escape) return
					// Anything else is the operator going back to typing.
					queuedEdit.onLeave()
				} else if (empty && key.upArrow && !key.meta && !key.shift && queuedEdit.onMove('up')) {
					return
				}
			}
			const liveCommandSuggestions = plainText
				? []
				: matchSlashCommands(valueRef.current, userCommands, builtins)
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
					const completed = `/${liveCommandSuggestions[liveSelection]?.name ?? ''} `
					editBuffer(completed, completed.length, 'completion')
					setSelectedIndex(0)
					return true
				}
				if (liveSuggestionKind === 'file' && liveMention) {
					const path = liveFileSuggestions[liveSelection]
					if (!path) return false
					const replacement = `${mentionText(path)} `
					// A quoted token the person closed already: the closing quote
					// belongs to the mention being replaced, not to the text after it.
					const isQuoted = valueRef.current[liveMention.start + 1] === '"'
					const end =
						isQuoted && valueRef.current[liveMention.end] === '"'
							? liveMention.end + 1
							: liveMention.end
					editBuffer(
						valueRef.current.slice(0, liveMention.start) +
							replacement +
							valueRef.current.slice(end),
						liveMention.start + replacement.length,
						'completion',
					)
					setSelectedIndex(0)
					return true
				}
				return false
			}
			if (key.meta && key.upArrow && onRecallQueued) {
				if (valueRef.current.length > 0 || attachmentsRef.current.length > 0) {
					onNotice?.('Send or clear the current draft before recalling a queued message.')
					return
				}
				const recalled = onRecallQueued()
				if (recalled) restoreDraft(recalled)
				return
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
				const pastes = pasteStoreRef.current
				// Chips become the words they stand for; image chips go, the image travels beside.
				const toMessage = (draft: string) => expandChips(stripAttachmentChips(draft), pastes)
				const message = toMessage(valueRef.current).trim()
				// An image whose chip was deleted from the text is not sent.
				const currentAttachments = attachmentsRef.current.filter((attachment) =>
					valueRef.current.includes(chipFor(attachment, idFor(attachment))),
				)
				if (message.length === 0 && currentAttachments.length === 0) return false
				const submittedAttachments = currentAttachments.length > 0 ? currentAttachments : undefined
				// Read again from what the last key left, not from the last render.
				const detection = detect(valueRef.current)
				// The message is the draft trimmed: offsets move by what the trim took.
				const whole = toMessage(valueRef.current)
				const lead = whole.length - whole.trimStart().length
				const armed = detection.hits
					.filter((hit) => hit.state === 'armed')
					.map((hit) => ({
						id: hit.id,
						start: toMessage(valueRef.current.slice(0, hit.start)).length - lead,
						end: toMessage(valueRef.current.slice(0, hit.end)).length - lead,
					}))
				onSubmit(message, submittedAttachments, mode, {
					source: 'composer',
					triggers: armed,
					onlyTriggers:
						armed.length > 0 && detection.onlyTriggers && currentAttachments.length === 0,
				})
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
							spans: spansRef.current,
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
				if (position < 0) setBuffer(next.draft.value, next.draft.cursor, 'typed', next.draft.spans)
				else setBuffer(next.matches[position] ?? next.draft.value, undefined, 'recalled')
				return
			}
			if (key.return) {
				if (liveSuggestionKind === 'command') {
					// Run the highlighted command.
					onSubmit(`/${liveCommandSuggestions[liveSelection]?.name ?? ''}`, undefined, 'submit', {
						source: 'composer-dropdown',
					})
					reset()
					return
				}
				if (acceptSuggestion()) return
				submit('submit')
				return
			}
			if (key.tab && key.shift) {
				// Shift+Tab cycles the permission mode. Before the plain-Tab
				// branch below, which would otherwise queue the draft.
				onCycleMode?.()
				return
			}
			if (key.tab) {
				if (plainText) return
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
					setBuffer(
						activeSearch.draft.value,
						activeSearch.draft.cursor,
						'typed',
						activeSearch.draft.spans,
					)
					setHistorySearch(null)
					return
				}
				const empty = valueRef.current.length === 0 && attachmentsRef.current.length === 0
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
				const position = cursorRef.current
				// A chip goes whole: half a chip would send its brackets as text.
				const chip = chipBefore(valueRef.current, position)
				if (chip) {
					const gone = attachmentsRef.current.findIndex(
						(attachment) => chipFor(attachment, idFor(attachment)) === chip.chip,
					)
					if (gone >= 0) replaceAttachments((p) => p.filter((_, index) => index !== gone))
					editBuffer(
						valueRef.current.slice(0, chip.start) + valueRef.current.slice(position),
						chip.start,
					)
					return
				}
				// Right after an armed keyword, Backspace drops the trigger first
				// and deletes nothing; the next Backspace deletes as usual.
				const keyword = detect(valueRef.current).hits.find(
					(hit) => hit.state === 'armed' && hit.id === 'hypermode' && hit.end === position,
				)
				if (keyword && keyword.end - keyword.start === 'hypermode'.length) {
					setOverride(keyword, 'dropped')
					return
				}
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
			if (
				key.leftArrow &&
				!key.shift &&
				onOpenAgents &&
				valueRef.current.length === 0 &&
				attachmentsRef.current.length === 0
			) {
				onOpenAgents()
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
			if (key.pageUp && !hasLiveSuggestions && onScrollTranscript) {
				onScrollTranscript()
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
						spans: spansRef.current,
					}
				}
				const next = Math.min(historyIndexRef.current + 1, history.length - 1)
				setHistoryIndex(next)
				setBuffer(history[history.length - 1 - next] ?? '', undefined, 'recalled')
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
					if (valueRef.current.length === 0 && attachmentsRef.current.length === 0) {
						onOpenAgentPanel?.()
					}
					return
				}
				if (historyIndexRef.current === 0) {
					const draft = historyDraftRef.current
					historyDraftRef.current = null
					setHistoryIndex(-1)
					setBuffer(draft?.value ?? '', draft?.cursor ?? 0, 'typed', draft?.spans ?? [])
					return
				}
				const next = historyIndexRef.current - 1
				setHistoryIndex(next)
				setBuffer(history[history.length - 1 - next] ?? '', undefined, 'recalled')
				return
			}
			if (key.ctrl && input === 'g') {
				if (!onExternalEdit) {
					onNotice?.('External editor support is unavailable in this terminal.')
					return
				}
				const seed = expandChips(valueRef.current, pasteStoreRef.current).trim()
				void onExternalEdit(seed)
					.then((edited) => {
						// An image the editor text no longer names stays attached: its chip goes back.
						let cleaned = edited.trimEnd()
						attachmentsRef.current.forEach((attachment) => {
							const chip = chipFor(attachment, idFor(attachment))
							if (!cleaned.includes(chip)) cleaned += `${cleaned ? ' ' : ''}${chip}`
						})
						clearPastes()
						setHistoryIndex(-1)
						setHistorySearch(null)
						setSelectedIndex(0)
						historyDraftRef.current = null
						verticalColumnRef.current = null
						setBuffer(cleaned, cleaned.length, 'editor')
					})
					.catch((error: unknown) => {
						onNotice?.(
							// The editor module words its own refusals for a person ("set VISUAL or EDITOR…").
							error instanceof Error && error.name === 'ExternalEditorError'
								? `Cannot open your editor: ${error.message}.`
								: explainFailure(error, 'Cannot open your editor.'),
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
				if (plainText) {
					onNotice?.(
						'Messages to a child accept text. Paste text using the terminal paste command.',
					)
					return
				}
				const read = readClipboardImage()
				if (read.kind === 'image') {
					const position = cursorRef.current
					const chip = chipFor(read.image, idFor(read.image))
					replaceAttachments((p) => [...p, read.image])
					editBuffer(
						valueRef.current.slice(0, position) + chip + valueRef.current.slice(position),
						position + chip.length,
						'pasted',
					)
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
					'yank',
				)
				return
			}
			// Alt+W: drop the trigger nearest the cursor, or bring one back, or
			// arm one the row only suggested.
			if (key.meta && input === 'w') {
				toggleNearestTrigger()
				return
			}
			if (key.ctrl || key.meta) return
			if (input.length === 0) return
			// A multi-line chunk arriving in one keypress is a paste — hold it as
			// an attachment chip instead of flooding the input. A long chunk on
			// ONE line is not: it is what typing looks like when keystrokes queue
			// up behind a busy render and arrive in a single read. Held as a chip
			// it was joined back to the typed text with a paragraph break, which
			// split the word it landed in two ("subag" / "ents") in the message
			// the model received. A real paste reaches `usePaste` above, where a
			// long one is still a chip.
			if (input.includes('\n')) {
				const position = cursorRef.current
				const inserted = isChipPaste(input, terminal.rows ?? 24) ? holdPaste(input) : input
				setSelectedIndex(0)
				editBuffer(
					valueRef.current.slice(0, position) + inserted + valueRef.current.slice(position),
					position + inserted.length,
					'pasted',
				)
				return
			}
			setSelectedIndex(0)
			const position = cursorRef.current
			// One grapheme is a key. More in one chunk is queued keys or a paste
			// without bracketed-paste markers; nothing here can tell which, so it
			// does not count as typed.
			let graphemes = 0
			for (const _ of graphemeSegmenter.segment(input)) if (++graphemes > 1) break
			editBuffer(
				valueRef.current.slice(0, position) + input + valueRef.current.slice(position),
				position + input.length,
				graphemes > 1 ? 'burst' : 'typed',
			)
		},
		// A text prompt hides the composer without disabling it. Keep this
		// listener attached across that transition: Ink installs it in an
		// effect after painting, so reattaching on unhide can lose the first key.
		// The guard above ignores keys while another prompt owns the screen.
		{ isActive: !disabled },
	)

	// After every hook, so the component keeps its state while it is off screen.
	// This is the whole fix: React preserves a mounted component's state, and
	// preserving it is what an unmounting ternary could not do.
	if (hidden) return null

	const modelIntent =
		!plainText && !attachments.length ? parseModelSelectionIntent(value) : undefined
	const effortIntent =
		!plainText && !attachments.length ? /^\/effort\s+([a-z]+)$/.exec(value.trim())?.[1] : undefined
	const effortAvailable =
		effortIntent === 'default' ||
		(effortIntent !== undefined && reasoningEffortLevels?.includes(effortIntent))
	void triggerVersion
	const detection = !modelIntent && !effortIntent && !disabled ? detect(value) : EMPTY_DETECTION
	const triggerRow = triggers
		? tagRow(detection, {
				columns: Math.max(1, (terminal.columns ?? 80) - 4),
				turnActive,
				highestEffort: triggers.highestEffort,
				hypermodeEffort: triggers.hypermodeEffort,
				standaloneAllowed: attachments.length === 0,
			})
		: null
	const styledSpans = detection.hits.flatMap((hit) =>
		hit.state === 'armed' || hit.state === 'unavailable'
			? [{ start: hit.start, end: hit.end, style: hit.state }]
			: [],
	)
	const beforeSegments = displaySegments(value, displayValue.start, cursor, styledSpans)
	const afterSegments = displaySegments(value, cursor, displayValue.end, styledSpans)
	const promptGlyph = disabled ? '…' : '❯'
	const showPlaceholder = !disabled && value.length === 0 && !editPreviousArmed
	// The queued-messages hint is offered for the first few times it would show,
	// then the plain placeholder takes over. One decision per appearance.
	const queuedHintWanted = showPlaceholder && queuedEdit?.available === true
	useEffect(() => {
		const episode = queuedHintEpisodeRef.current
		if (queuedHintWanted && !episode.active) {
			const show = queuedHintShownRef.current < QUEUED_HINT_LIMIT
			if (show) queuedHintShownRef.current += 1
			queuedHintEpisodeRef.current = { active: true, show }
			setQueuedHintShow(show)
		} else if (!queuedHintWanted && episode.active) {
			queuedHintEpisodeRef.current = { active: false, show: false }
			setQueuedHintShow(false)
		}
	}, [queuedHintWanted])
	const historySearchQuery = historySearch
		? composerDisplayValue(historySearch.query, historySearch.query.length)
		: null
	return (
		<Box flexDirection="column">
			{effortIntent ? (
				<Box>
					<Text color={effortAvailable ? theme.accent.tool : theme.status.warn}>
						Effort: {effortIntent} · {effortAvailable ? 'requested' : 'unavailable for this model'}
					</Text>
				</Box>
			) : null}
			{modelIntent ? (
				<Box>
					<Text color={theme.accent.tool}>Model: {modelIntent.query} · requested</Text>
				</Box>
			) : null}
			{triggerRow ? (
				<Box>
					<Text
						color={
							detection.hits.some((hit) => hit.state === 'armed')
								? theme.accent.trigger
								: theme.text.muted
						}
						wrap="truncate-end"
					>
						{triggerRow}
					</Text>
				</Box>
			) : null}
			<Box>
				<Box width={2} flexShrink={0}>
					<Text color={theme.text.muted}>{promptGlyph}</Text>
				</Box>
				<Box flexGrow={1}>
					{showPlaceholder ? (
						<Text color={theme.text.muted}>
							{queuedHintWanted && queuedHintShow ? QUEUED_HINT : placeholder}
						</Text>
					) : editPreviousArmed ? (
						<Text color={theme.text.muted}>Press Esc again to edit a previous prompt</Text>
					) : (
						<Text color={disabled ? theme.text.muted : theme.text.primary} wrap="wrap">
							{displayValue.leadingEllipsis ? '… ' : ''}
							{renderSegments(beforeSegments)}
							{disabled ? null : <Text color={theme.border.focus}>▏</Text>}
							{renderSegments(afterSegments)}
							{displayValue.trailingEllipsis ? ' …' : ''}
						</Text>
					)}
				</Box>
			</Box>
			{historySearch && historySearchQuery ? (
				<Box paddingTop={1}>
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
				<Box flexDirection="column" paddingTop={1} width="100%">
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
								<Box flexGrow={1} minWidth={0} flexDirection="column">
									{clampDescription(cmd.description, descriptionWidth).map((line, at) => (
										<Text key={`${cmd.name}:${at}`} color={theme.text.muted} wrap="truncate-end">
											{line}
										</Text>
									))}
								</Box>
							</Box>
						)
					})}
					<Text color={theme.text.muted}>
						{fitHints(
							[
								{ text: `${selIdx + 1}/${commandSuggestions.length}`, rank: 5 },
								{ text: '↑↓ select', rank: 5 },
								{ text: 'PgUp/PgDn jump', short: 'PgUp/PgDn', rank: 1 },
								{ text: 'enter run', rank: 5 },
								{ text: 'tab complete', rank: 3 },
							],
							menuTextWidth,
						)}
					</Text>
				</Box>
			) : suggestionKind === 'file' ? (
				<Box flexDirection="column" paddingTop={1} width="100%">
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
						{fitHints(
							[
								{ text: `${selIdx + 1}/${fileSuggestions.length}`, rank: 5 },
								{ text: '↑↓ select', rank: 5 },
								{ text: 'PgUp/PgDn jump', short: 'PgUp/PgDn', rank: 1 },
								{ text: 'enter / tab insert', short: 'enter insert', rank: 4 },
							],
							menuTextWidth,
						)}
					</Text>
				</Box>
			) : null}
		</Box>
	)
}

/** The chip that stands for the attachment with this stable `id` in the draft text. */
function chipFor(attachment: MessageAttachment, id: number): string {
	const isDocument =
		attachment.type === 'document' || (attachment.type === 'stored' && attachment.kind !== 'image')
	return attachmentChip(isDocument ? 'Document' : 'Image', id)
}
