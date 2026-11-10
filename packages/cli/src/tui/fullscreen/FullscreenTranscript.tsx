import { Box, type DOMElement, Text, measureElement, useInput } from 'ink'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ClickCounter } from '../../workspaces/selection.js'
import { isAction } from '../keymap.js'
import { useThemeEpoch } from '../theme-store.js'
import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { createLayoutCache, layoutTranscript } from './layout.js'
import type { PointerReport, WheelDirection } from './mouse-wheel.js'
import { type Mark, paintRow } from './paint.js'
import type { FsRow, StyledSpan } from './rows.js'
import { type Match, editSearch, findMatches, searchLine, startMatch, stepMatch } from './search.js'
import {
	type Geometry,
	type Selection,
	landOn,
	rowCells,
	rowsSource,
	selectedText,
	selectionRange,
} from './selection.js'
import {
	FOLLOWING,
	type ViewMove,
	type ViewState,
	bottomRow,
	hasUnseen,
	jumpHint,
	moveView,
	revealRow,
	syncView,
	visibleRange,
} from './viewport.js'

/** What the owner of the screen can ask of the view. */
export interface FullscreenControl {
	scroll(move: ViewMove): void
	/**
	 * Escape closes the search or lets go of a selection. True when it did, so
	 * the owner leaves the key alone; false when there was nothing to close.
	 */
	takeEscape(): boolean
	/**
	 * The copy key, when selections are not copied on release: copies what is
	 * selected. True when it did.
	 */
	takeCopy(): boolean
}

/** What a copy reports back: a line to show, and whether it worked. */
export interface CopyReport {
	readonly text: string
	readonly ok: boolean
}

export interface FullscreenTranscriptProps {
	/** Finalized messages, oldest first. */
	readonly messages: readonly TranscriptMessage[]
	/** The reply that is still streaming, drawn where it stands. */
	readonly pending: TranscriptMessage | null
	readonly pendingAt?: number
	/** Columns the rows are laid out in, glyph gutter included. */
	readonly columns: number
	/** The tallest the view can be: rows drawn above this are never needed. */
	readonly maxRows: number
	/** Rows shown only when the view is scrolled to the very top. */
	readonly header?: ReactNode
	/** A lifecycle surface owns the screen: keep the room, draw nothing. */
	readonly hidden?: boolean
	/** Page Down, Home and End scroll only while this is on. */
	readonly keysActive: boolean
	/** Home and End move the composer's cursor while it has text. */
	readonly homeEndActive: boolean
	readonly subscribeWheel: (listener: (direction: WheelDirection) => void) => () => void
	/** Left-button reports; absent where the terminal was asked for the wheel only. */
	readonly subscribePointer?: (listener: (report: PointerReport) => void) => () => void
	/** Puts text on the clipboard. Resolves null when the copy was dropped. */
	readonly copy?: (text: string) => Promise<CopyReport | null>
	/** Whether a selection is copied the moment the button is released. */
	readonly copyOnSelect?: boolean
	/** Told when the search line opens or closes: the composer must not take keys while it is open. */
	readonly onSearchChange?: (open: boolean) => void
	readonly control: { current: FullscreenControl | null }
	/** Milliseconds a note stays; a test passes its own scheduler. */
	readonly noteMs?: number
}

/** Cells of the gutter (glyph and a space) the text starts after. */
const GUTTER = 2
/** Terminal columns left of the window's own columns: the screen's padding. */
const SCREEN_PADDING = 1
const DOUBLE_CLICK_MS = 400
const NOTE_OK_MS = 2000
const NOTE_FAIL_MS = 4000

const SELECTED: Mark['style'] = { inverse: true }
const FOUND: Mark['style'] = { bold: true, underline: true }
const CURRENT: Mark['style'] = { inverse: true, bold: true }

interface SearchOpen {
	readonly query: string
	readonly cursor: { readonly row: number; readonly from: number } | null
}

interface Dragging {
	readonly selection: Selection
	readonly moved: boolean
	readonly pressing: boolean
	readonly copied: boolean
}

function spanElement(span: StyledSpan, key: number) {
	return (
		<Text
			key={key}
			color={span.color}
			bold={span.bold}
			italic={span.italic}
			underline={span.underline}
			inverse={span.inverse}
		>
			{span.text}
		</Text>
	)
}

/**
 * The conversation on the alternate screen: a window onto the rows, not the
 * rows themselves.
 *
 * The box takes whatever height the live region (spinner, composer, footer)
 * leaves and clips from the top. Only the rows that can be on screen are
 * built into elements, so the cost of a frame follows the terminal's height,
 * not the conversation's. Scrolled up, one row above the composer says how to
 * get back; the view holds still while output arrives.
 *
 * Replies are rendered Markdown. A drag selects text and a release copies it;
 * a search field takes the footer row and highlights what it finds.
 */
export function FullscreenTranscript({
	messages,
	pending,
	pendingAt,
	columns,
	maxRows,
	header,
	hidden = false,
	keysActive,
	homeEndActive,
	subscribeWheel,
	subscribePointer,
	copy,
	copyOnSelect = true,
	onSearchChange,
	control,
	noteMs,
}: FullscreenTranscriptProps) {
	const cache = useRef(createLayoutCache()).current
	const epoch = useThemeEpoch()
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new theme lays the rows out again.
	const { rows, index } = useMemo(
		() => layoutTranscript(messages, pending, pendingAt, columns, cache),
		[messages, pending, pendingAt, columns, cache, epoch],
	)
	const [view, setView] = useState<ViewState>(FOLLOWING)
	const boxRef = useRef<DOMElement>(null)
	// Pages and the top clamp want the room actually on screen. It is only read
	// when the reader acts, so it needs no state of its own.
	const roomRef = useRef(maxRows)
	const room = useCallback((): number => {
		const node = boxRef.current
		if (node) {
			const measured = measureElement(node).height
			if (measured > 0) roomRef.current = measured
		}
		// Scrolled up, the jump hint takes one of those rows.
		return Math.max(1, Math.min(roomRef.current, maxRows) - 1)
	}, [maxRows])

	const synced = syncView(view, index, Math.max(1, roomRef.current - 1))
	useEffect(() => {
		if (synced !== view) setView(synced)
	}, [synced, view])

	const latest = useRef({ synced, index, rows })
	latest.current = { synced, index, rows }
	const scroll = useCallback(
		(move: ViewMove) => {
			const { synced: state, index: now } = latest.current
			setView(moveView(state, move, now, room()))
		},
		[room],
	)
	useEffect(
		() => subscribeWheel((direction) => scroll(direction === 'up' ? 'line-up' : 'line-down')),
		[subscribeWheel, scroll],
	)

	const textWidth = Math.max(1, columns - GUTTER)

	// ---- selection and copy
	const [selection, setSelection] = useState<Dragging | null>(null)
	const selectionRef = useRef<Dragging | null>(null)
	const updateSelection = useCallback((next: Dragging | null) => {
		selectionRef.current = next
		setSelection(next)
	}, [])
	const [note, setNote] = useState<CopyReport | null>(null)
	const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const showNote = useCallback(
		(report: CopyReport) => {
			setNote(report)
			if (noteTimer.current) clearTimeout(noteTimer.current)
			noteTimer.current = setTimeout(
				() => {
					noteTimer.current = null
					setNote(null)
				},
				noteMs ?? (report.ok ? NOTE_OK_MS : NOTE_FAIL_MS),
			)
		},
		[noteMs],
	)
	useEffect(
		() => () => {
			if (noteTimer.current) clearTimeout(noteTimer.current)
		},
		[],
	)
	// The same rows at another width are other text: a selection does not carry over.
	const widthRef = useRef(textWidth)
	useEffect(() => {
		if (widthRef.current === textWidth) return
		widthRef.current = textWidth
		if (selectionRef.current) updateSelection(null)
	}, [textWidth, updateSelection])

	const copySelection = useCallback(
		(dragging: Dragging) => {
			const { rows: now } = latest.current
			const text = selectedText(now, textWidth, dragging.selection)
			if (text.trim() === '' || !copy) return
			updateSelection({ ...dragging, copied: true })
			void copy(text).then((report) => {
				if (report) showNote(report)
			})
		},
		[copy, showNote, textWidth, updateSelection],
	)

	const clicks = useRef(new ClickCounter(() => Date.now(), DOUBLE_CLICK_MS)).current
	// Where the window is on the screen, read when the pointer reports.
	const geometryRef = useRef<Geometry>({
		top: 1,
		height: maxRows,
		from: 0,
		to: 0,
		footer: 0,
		left: 1 + SCREEN_PADDING + GUTTER,
		cols: textWidth,
	})

	const pointer = useCallback(
		(report: PointerReport) => {
			const node = boxRef.current
			const geometry = {
				...geometryRef.current,
				height: node ? measureElement(node).height || geometryRef.current.height : 0,
			}
			const landing = landOn(geometry, report.x, report.y)
			const current = selectionRef.current
			if (report.kind === 'press') {
				if (landing.kind !== 'on') {
					if (current) updateSelection(null)
					return
				}
				const count = clicks.press(report.x, report.y)
				const mode = count === 1 ? 'char' : count === 2 ? 'word' : 'line'
				updateSelection({
					selection: { anchor: landing.point, focus: landing.point, mode },
					moved: mode !== 'char',
					pressing: true,
					copied: false,
				})
				return
			}
			if (!current?.pressing) return
			if (report.kind === 'drag') {
				if (landing.kind === 'outside') return
				// Past the top or bottom edge the window follows the pointer.
				if (landing.kind === 'above') scroll('line-up')
				else if (landing.kind === 'below') scroll('line-down')
				const focus = landing.point
				updateSelection({
					...current,
					moved: true,
					selection: { ...current.selection, focus },
				})
				return
			}
			// Release.
			const finished: Dragging = { ...current, pressing: false }
			const a = current.selection.anchor
			const f = current.selection.focus
			if (
				!current.moved ||
				(current.selection.mode === 'char' && a.line === f.line && a.col === f.col)
			) {
				// A click that did not move selects nothing.
				updateSelection(null)
				return
			}
			updateSelection(finished)
			if (copyOnSelect) copySelection(finished)
			else showNote({ text: 'Selected. Press ctrl+c to copy it, or esc to let go.', ok: true })
		},
		[clicks, copyOnSelect, copySelection, scroll, showNote, updateSelection],
	)
	useEffect(
		() => (subscribePointer ? subscribePointer(pointer) : undefined),
		[subscribePointer, pointer],
	)

	// ---- search
	const [search, setSearch] = useState<SearchOpen | null>(null)
	const searchRef = useRef<SearchOpen | null>(null)
	const savedView = useRef<ViewState>(FOLLOWING)
	const matches = useMemo<readonly Match[]>(
		() => (search ? findMatches(rows, search.query) : []),
		[rows, search],
	)
	const currentIndex = search?.cursor
		? matches.findIndex((m) => m.row === search.cursor?.row && m.from === search.cursor?.from)
		: -1
	const updateSearch = useCallback(
		(next: SearchOpen | null) => {
			const was = searchRef.current !== null
			searchRef.current = next
			setSearch(next)
			if (was !== (next !== null)) onSearchChange?.(next !== null)
		},
		[onSearchChange],
	)
	const goTo = useCallback(
		(match: Match | undefined) => {
			if (!match) return
			const { synced: state, index: now } = latest.current
			setView(revealRow(state, now, match.row, room()))
		},
		[room],
	)
	const openSearch = useCallback(() => {
		savedView.current = latest.current.synced
		updateSearch({ query: '', cursor: null })
	}, [updateSearch])
	const closeSearch = useCallback(() => {
		// Back to where the reader was; a reader who was following is following.
		setView(savedView.current.follow ? FOLLOWING : savedView.current)
		updateSearch(null)
	}, [updateSearch])

	useEffect(() => {
		control.current = {
			scroll,
			takeEscape: () => {
				if (searchRef.current) {
					closeSearch()
					return true
				}
				const held = selectionRef.current
				if (held) {
					updateSelection(null)
					// A selection already copied is only a highlight: letting go of it
					// must not cost the Esc that interrupts a running turn.
					return !held.copied
				}
				return false
			},
			takeCopy: () => {
				const current = selectionRef.current
				if (copyOnSelect || !current?.moved || current.pressing) return false
				if (current.copied) updateSelection(null)
				else copySelection(current)
				return true
			},
		}
		return () => {
			control.current = null
		}
	}, [control, scroll, closeSearch, updateSelection, copyOnSelect, copySelection])

	// A search closes when the keys stop being the view's to take.
	useEffect(() => {
		if (!keysActive && searchRef.current) closeSearch()
	}, [keysActive, closeSearch])

	useInput(
		(input, key) => {
			const open = searchRef.current
			if (open) {
				if (key.pageUp) {
					scroll('page-up')
					return
				}
				if (key.pageDown) {
					scroll('page-down')
					return
				}
				const edit = editSearch(open.query, input, key)
				const { rows: now, synced: state, index: at } = latest.current
				// Escape is taken through the control, so the owner can tell a key that
				// closed the search from one that is still its own.
				if (edit.kind === 'query') {
					const found = findMatches(now, edit.query)
					const first = found[startMatch(found, bottomRow(state, at))]
					updateSearch({
						query: edit.query,
						cursor: first ? { row: first.row, from: first.from } : null,
					})
					goTo(first)
				} else if (edit.kind === 'next' || edit.kind === 'previous') {
					const found = findMatches(now, open.query)
					const was = found.findIndex(
						(m) => m.row === open.cursor?.row && m.from === open.cursor?.from,
					)
					const to = found[stepMatch(found.length, was, edit.kind === 'next' ? 1 : -1)]
					if (to) {
						updateSearch({ ...open, cursor: { row: to.row, from: to.from } })
						goTo(to)
					}
				}
				return
			}
			if (isAction('app:searchTranscript', input, key)) {
				openSearch()
				return
			}
			if (key.pageDown) scroll('page-down')
			else if (homeEndActive && key.home) scroll('top')
			else if (homeEndActive && key.end) scroll('bottom')
			else if (!key.pageUp && (key.return || (input.length > 0 && !key.ctrl && !key.meta))) {
				// Typing is a reason to look at the end again, and to let go of a selection.
				if (selectionRef.current) updateSelection(null)
				if (!latest.current.synced.follow) setView(FOLLOWING)
			}
		},
		{ isActive: keysActive },
	)

	const { from, to } = visibleRange(synced, index, maxRows)
	const unseen = hasUnseen(synced, index)
	const hint = synced.follow ? null : jumpHint(columns, unseen)
	// The footer row is the search line, or the jump hint, or the note of a copy
	// in the hint's place. While following there is no footer, and a note must
	// not push the rows up under the reader's pointer: it is drawn over the last
	// row for the moment it stays.
	const noteLine = note
		? { text: note.text, color: note.ok ? theme.text.secondary : theme.status.error }
		: null
	const footer: { text: string; color: string } | null = search
		? {
				text: searchLine(search.query, currentIndex, matches.length, columns),
				color: theme.text.primary,
			}
		: ((noteLine && hint ? noteLine : null) ??
			(hint ? { text: hint, color: unseen ? theme.text.secondary : theme.text.muted } : null))
	const overlay = !search && !hint ? noteLine : null
	geometryRef.current = {
		top: 1,
		height: geometryRef.current.height,
		from,
		to,
		footer: footer ? 1 : 0,
		left: 1 + SCREEN_PADDING + GUTTER,
		cols: textWidth,
	}

	const range =
		selection?.moved === true
			? selectionRange(rowsSource(rows, textWidth), selection.selection)
			: null
	const marksFor = (row: FsRow, at: number): readonly Mark[] => {
		const marks: Mark[] = []
		if (search) {
			matches.forEach((match, i) => {
				if (match.row !== at) return
				marks.push({
					from: match.from,
					to: match.to,
					style: i === currentIndex ? CURRENT : FOUND,
				})
			})
		}
		if (range) {
			const cells = rowCells(range, at, row.text, textWidth)
			if (cells) marks.push({ from: cells[0], to: cells[1], style: SELECTED })
		}
		return marks
	}

	return (
		<Box
			ref={boxRef}
			flexDirection="column"
			flexGrow={1}
			flexShrink={1}
			flexBasis={0}
			overflowY="hidden"
			justifyContent="flex-end"
		>
			{hidden ? null : (
				<Box flexDirection="column" flexShrink={0}>
					{from === 0 && header ? <Box>{header}</Box> : null}
					{rows.slice(from, to).map((row, i) => {
						if (overlay && from + i === to - 1) {
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
								<Box key={from + i} flexDirection="row">
									<Box width={2} flexShrink={0} />
									<Text color={overlay.color} wrap="truncate-end">
										{overlay.text}
									</Text>
								</Box>
							)
						}
						const marks = marksFor(row, from + i)
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
							<Box key={from + i} flexDirection="row">
								<Box width={2} flexShrink={0}>
									<Text color={row.glyphColor} bold>
										{row.glyph}
									</Text>
								</Box>
								{row.spans === undefined && marks.length === 0 ? (
									<Text color={row.color} wrap="truncate-end">
										{row.text.length > 0 ? row.text : ' '}
									</Text>
								) : (
									// The spans carry their own colours; one on the row would tint the blanks between them.
									<Text wrap="truncate-end">
										{row.text.length > 0 ? paintRow(row, marks).map(spanElement) : ' '}
									</Text>
								)}
							</Box>
						)
					})}
					{footer ? (
						<Box justifyContent={search ? 'flex-start' : 'center'}>
							<Text color={footer.color} wrap="truncate-end">
								{footer.text}
							</Text>
						</Box>
					) : null}
				</Box>
			)}
		</Box>
	)
}
