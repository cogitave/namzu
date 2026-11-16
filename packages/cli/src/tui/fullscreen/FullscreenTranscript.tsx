import { Box, type DOMElement, Text, measureElement, useInput } from 'ink'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ClickCounter } from '../../workspaces/selection.js'
import { isAction } from '../keymap.js'
import { type FoundLink, linkHref } from '../links.js'
import { motionAllowed } from '../motion.js'
import {
	type ReplyBaseline,
	baselineOf,
	hasNews,
	newsSince,
	promptAfter,
	replyList,
} from '../new-output.js'
import { terminalLinkTo } from '../terminal-hyperlinks.js'
import { useThemeEpoch } from '../theme-store.js'
import { theme } from '../theme.js'
import type { TranscriptMessage } from '../types.js'
import { cellsOf } from './cells.js'
import {
	DEFAULT_WHEEL,
	WHEEL_FEEL,
	WHEEL_IDLE,
	type WheelState,
	frame,
	notch,
	settle,
} from './glide.js'
import { type UnseenMark, createLayoutCache, layoutTranscript } from './layout.js'
import type { PointerReport, WheelDirection } from './mouse-wheel.js'
import { type Mark, paintRow } from './paint.js'
import { type FindLinks, type RowLink, linkAt, linksOnLine } from './row-links.js'
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
	anchorAt,
	bottomRow,
	hasUnseen,
	holdRow,
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
	/**
	 * Links in the text. `find` reads a line of text for them; `activate` is what a click does:
	 * `hint` for a plain click, `open` for a ctrl-click or alt-click. Absent, nothing is a link.
	 */
	readonly links?: {
		readonly find: FindLinks
		readonly activate: (link: FoundLink, how: 'open' | 'hint') => CopyReport
	}
	/** The terminal takes OSC 8 links: link text is sent as one, so the terminal's own click works too. */
	readonly hyperlinks?: boolean
	/**
	 * Where a short passing note goes (a copy, a link). Absent, the view draws it over its own
	 * last row; present, the owner shows it in the status area and the rows stay as they are.
	 */
	readonly onNote?: (report: CopyReport) => void
	/**
	 * Told when the search line opens or closes: the composer must not take keys while it is open.
	 * `typing` is false once the query was confirmed and the keys step through the matches.
	 */
	readonly onSearchChange?: (open: boolean, typing?: boolean) => void
	/**
	 * The detailed transcript (ctrl+o): every body whole and open, a click folds one, the model's
	 * reasoning and each reply's stamp are drawn, `/` searches and `n` and `N` step through the
	 * matches, and typing never jumps to the end.
	 */
	readonly detailed?: boolean
	/** Screen row (1 is the top) the window starts at, when something is drawn above it. */
	readonly top?: number
	/** Ignores the wheel and the pointer: another view is on screen and has them. */
	readonly inert?: boolean
	/** Takes no room while another view is on screen, keeping its place for when it comes back. */
	readonly yielded?: boolean
	readonly control: { current: FullscreenControl | null }
	/** Rows a slow wheel notch moves (`tui.wheelRows`); 3 when absent. */
	readonly wheelRows?: number
	/** Whether a fast run of notches speeds up (`tui.wheelAccel`); on when absent. */
	readonly wheelAccel?: boolean
	/** Milliseconds a note stays; a test passes its own scheduler. */
	readonly noteMs?: number
	/** The clock the wheel reads and schedules its frames on; a test passes its own. */
	readonly clock?: WheelClock
}

/** What the wheel needs of time: the hour, and a way to run something a moment later. */
export interface WheelClock {
	now(): number
	/** Runs `run` after `ms`; the returned function cancels it. */
	after(run: () => void, ms: number): () => void
}

const REAL_CLOCK: WheelClock = {
	now: () => Date.now(),
	after: (run, ms) => {
		const timer = setTimeout(run, ms)
		return () => clearTimeout(timer)
	},
}

/** Cells of the gutter (glyph and a space) the text starts after. */
const GUTTER = 2
/** Terminal columns left of the window's own columns: rows start in the first column. */
const SCREEN_PADDING = 0
const DOUBLE_CLICK_MS = 400
const NOTE_OK_MS = 2000
const NOTE_FAIL_MS = 4000

const SELECTED: Mark['style'] = { inverse: true }
const FOUND: Mark['style'] = { bold: true, underline: true }
const CURRENT: Mark['style'] = { inverse: true, bold: true }

interface SearchOpen {
	readonly query: string
	/** The query was confirmed: `n` and `N` step through the matches and `/` types again. */
	readonly browsing?: boolean
	readonly cursor: { readonly row: number; readonly from: number } | null
}

/** What the pointer rests on that answers a click: a link (with every row it covers) or a row that opens. */
type Hover =
	| { readonly key: string; readonly link: RowLink }
	| { readonly key: string; readonly row: number }

interface Dragging {
	readonly selection: Selection
	readonly moved: boolean
	readonly pressing: boolean
	readonly copied: boolean
	/** The cell the button went down on. */
	readonly at: { readonly x: number; readonly y: number }
	/** A selection was held when the button went down: that click only lets go of it. */
	readonly replaced: boolean
}

function spanElement(span: StyledSpan, key: number) {
	const linked = span.href !== undefined ? terminalLinkTo(span.text, span.href) : null
	return (
		<Text
			key={key}
			color={span.color}
			bold={span.bold}
			italic={span.italic}
			underline={span.underline}
			inverse={span.inverse}
			{...(span.background !== undefined ? { backgroundColor: span.background } : {})}
		>
			{linked ?? span.text}
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
 * a search field takes the footer row and highlights what it finds. Where the
 * pointer is reported in full, a click on a folded row opens it in place and a
 * click on it again folds it.
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
	links,
	hyperlinks = false,
	onNote,
	onSearchChange,
	detailed = false,
	top = 1,
	inert = false,
	yielded = false,
	control,
	noteMs,
	clock = REAL_CLOCK,
	wheelRows = DEFAULT_WHEEL.rows,
	wheelAccel = DEFAULT_WHEEL.accel,
}: FullscreenTranscriptProps) {
	const cache = useRef(createLayoutCache()).current
	const epoch = useThemeEpoch()
	// A click is a way to open a row only where the pointer is reported in full.
	const click = subscribePointer !== undefined
	// Which rows are open belongs to this view: it is not saved, and a resume starts folded.
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
	const openRef = useRef(open)
	const [view, setView] = useState<ViewState>(FOLLOWING)

	// ---- what is new below a reader who scrolled up
	// Taken while rendering and only while scrolled up (or a rule is still standing),
	// so following costs nothing. `away` is what the transcript held when the reader left.
	const away = useRef<ReplyBaseline | null>(null)
	const markRef = useRef<UnseenMark | null>(null)
	let replies: ReturnType<typeof replyList> | null = null
	if (view.follow) away.current = null
	else {
		replies = replyList(messages, pending, pendingAt)
		away.current ??= baselineOf(replies)
		const count = replies.length - away.current.replies
		const first = count > 0 ? replies[away.current.replies] : undefined
		if (first && (markRef.current?.before !== first.id || markRef.current.count !== count))
			markRef.current = { before: first.id, count }
	}
	// The rule stays after the reader is back at the end, until they send the next message.
	if (markRef.current && promptAfter(messages, markRef.current.before)) markRef.current = null
	const mark = markRef.current

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new theme lays the rows out again.
	const { rows, index } = useMemo(
		() =>
			layoutTranscript(
				messages,
				pending,
				pendingAt,
				columns,
				cache,
				{ click, open, detailed },
				mark,
			),
		[messages, pending, pendingAt, columns, cache, epoch, click, open, detailed, mark],
	)
	// A row that left the conversation (a compaction, a new session) is not open any more.
	useEffect(() => {
		if (open.size === 0) return
		const present = new Set(index.ids)
		const kept = [...open].filter((id) => present.has(id))
		if (kept.length === open.size) return
		const next = new Set(kept)
		openRef.current = next
		setOpen(next)
	}, [open, index])
	const boxRef = useRef<DOMElement>(null)
	// How tall the box and the header really are, read after each frame. With a header, a
	// conversation that is shorter than the box is drawn from its top, so the header opens the screen
	// and the prompt stays at the bottom; once it fills the box the rows sit at the bottom and the
	// top is clipped. Without a header the rows sit at the bottom, as they always did.
	const headerBox = useRef<DOMElement>(null)
	const boxHeight = useRef(maxRows)
	const headerHeight = useRef(0)
	const [, measured] = useState(0)
	useEffect(() => {
		const height = boxRef.current ? measureElement(boxRef.current).height : 0
		const header = headerBox.current ? measureElement(headerBox.current).height : 0
		if ((height > 0 && height !== boxHeight.current) || header !== headerHeight.current) {
			if (height > 0) boxHeight.current = height
			headerHeight.current = header
			measured((n) => n + 1)
		}
	})
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

	const latest = useRef({ synced, index, rows, messages, pending, pendingAt, columns })
	latest.current = { synced, index, rows, messages, pending, pendingAt, columns }
	// Where the view is right now. A render sets it; a move sets it at once, so
	// two notches that arrive before the next render both count.
	const viewNow = useRef<ViewState>(synced)
	viewNow.current = synced

	// ---- the wheel: notches add to a distance, frames spend it
	const wheelState = useRef<WheelState>(WHEEL_IDLE)
	const glideTimer = useRef<(() => void) | null>(null)
	const stopGlide = useCallback(() => {
		glideTimer.current?.()
		glideTimer.current = null
		wheelState.current = settle(wheelState.current)
	}, [])
	useEffect(() => stopGlide, [stopGlide])
	/** Put the view somewhere, ending any glide: a key, a click or a jump is immediate. */
	const place = useCallback(
		(next: ViewState) => {
			stopGlide()
			viewNow.current = next
			setView(next)
		},
		[stopGlide],
	)
	const scroll = useCallback(
		(move: ViewMove) => {
			stopGlide()
			const next = moveView(viewNow.current, move, latest.current.index, room())
			viewNow.current = next
			setView(next)
		},
		[room, stopGlide],
	)
	/** Move the view `rows` (down is positive); false when it did not move. */
	const moveRows = useCallback(
		(rows: number): boolean => {
			const was = viewNow.current
			const next = moveView(
				was,
				rows < 0 ? 'line-up' : 'line-down',
				latest.current.index,
				room(),
				Math.abs(rows),
			)
			if (next === was) return false
			viewNow.current = next
			setView(next)
			return true
		},
		[room],
	)
	const runFrame = useRef<() => void>(() => undefined)
	runFrame.current = () => {
		glideTimer.current = null
		const next = frame(wheelState.current, room())
		wheelState.current = next.state
		// Nothing left to move, or the end reached: the rest of the distance is let go.
		if (next.step !== 0 && (!moveRows(next.step) || viewNow.current.follow))
			wheelState.current = settle(wheelState.current)
		if (wheelState.current.pending !== 0)
			glideTimer.current = clock.after(() => runFrame.current(), WHEEL_FEEL.frameMs)
	}
	const hoverClear = useRef<() => void>(() => undefined)
	const onWheel = useCallback(
		(direction: WheelDirection) => {
			if (inert) return
			// The rows move under a pointer that does not: what it rested on is not known until it moves.
			hoverClear.current()
			wheelState.current = notch(
				wheelState.current,
				direction,
				clock.now(),
				{ rows: wheelRows, accel: wheelAccel },
				room(),
			)
			if (!motionAllowed()) {
				// No glide under reduced motion: the whole distance in one frame.
				const all = wheelState.current.pending
				wheelState.current = settle(wheelState.current)
				if (all !== 0) moveRows(all)
				return
			}
			// The first frame is at once, so scrolling up stops following at the first notch.
			if (glideTimer.current === null) runFrame.current()
		},
		[room, moveRows, wheelRows, wheelAccel, clock, inert],
	)
	useEffect(() => subscribeWheel(onWheel), [subscribeWheel, onWheel])

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
	const showOwnNote = useCallback(
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
	const showNote = onNote ?? showOwnNote
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
		top,
		height: maxRows,
		from: 0,
		to: 0,
		footer: 0,
		left: 1 + SCREEN_PADDING + GUTTER,
		cols: textWidth,
	})

	/**
	 * Open the message that owns `line`, or fold it, keeping that row where it is
	 * on the screen. The rows are laid out again here, for that one message, so
	 * the window can be placed against them before the next frame draws.
	 */
	const toggleAt = useCallback(
		(line: number) => {
			const now = latest.current
			const { id, offset } = anchorAt(now.index, line)
			const next = new Set(openRef.current)
			if (!next.delete(id)) next.add(id)
			const after = layoutTranscript(now.messages, now.pending, now.pendingAt, now.columns, cache, {
				click,
				open: next,
				detailed,
			})
			// A conversation that sits at the top of the window has nothing to hold in place: it
			// keeps following, and grows downward.
			place(
				viewNow.current.follow && geometryRef.current.packed !== undefined
					? FOLLOWING
					: holdRow(viewNow.current, now.index, after.index, id, offset, {
							height: room(),
							footer: geometryRef.current.footer,
							searching: searchRef.current !== null,
						}),
			)
			openRef.current = next
			setOpen(next)
		},
		[cache, click, detailed, room, place],
	)

	// Whether the footer row is the jump hint now, and whether a press began on it.
	const hintRef = useRef(false)
	const hintPress = useRef(false)
	// What is under the pointer. The state changes only when the target does, so a sweep of the
	// pointer over text costs a redraw per link or row it enters, none while it moves inside one.
	const [hover, setHover] = useState<Hover | null>(null)
	const hoverRef = useRef<Hover | null>(null)
	const updateHover = useCallback((next: Hover | null) => {
		if ((hoverRef.current?.key ?? '') === (next?.key ?? '')) return
		hoverRef.current = next
		setHover(next)
	}, [])
	hoverClear.current = () => updateHover(null)
	// A ctrl-click or alt-click that went down on a link: opened when the button comes up on the same cell.
	const linkPress = useRef<{
		readonly link: FoundLink
		readonly x: number
		readonly y: number
	} | null>(null)
	const pointer = useCallback(
		(report: PointerReport) => {
			if (inert) return
			const node = boxRef.current
			const geometry = {
				...geometryRef.current,
				height: node ? measureElement(node).height || geometryRef.current.height : 0,
			}
			const landing = landOn(geometry, report.x, report.y)
			if (report.kind === 'move') {
				let next: Hover | null = null
				if (landing.kind === 'on') {
					const { rows: now } = latest.current
					const found = links
						? linkAt(now, landing.point.line, landing.point.col, links.find)
						: null
					if (found) next = { key: `l:${found.id}`, link: found }
					else if (now[landing.point.line]?.opens === true)
						next = { key: `r:${landing.point.line}`, row: landing.point.line }
				}
				updateHover(next)
				return
			}
			const current = selectionRef.current
			// The hint's row is the bottom row of the window, and answers a click when it is the hint.
			const onHint = hintRef.current && report.y === geometry.top + geometry.height - 1
			if (report.kind === 'press') {
				// A press stops a glide where it is: the row under the pointer is the one that opens.
				stopGlide()
				if (onHint) {
					if (current) updateSelection(null)
					hintPress.current = true
					return
				}
				hintPress.current = false
				if (landing.kind !== 'on') {
					if (current) updateSelection(null)
					return
				}
				// ctrl-click or alt-click on a link opens it; the link is not selected.
				linkPress.current = null
				if (links && (report.ctrl === true || report.alt === true)) {
					const found = linkAt(
						latest.current.rows,
						landing.point.line,
						landing.point.col,
						links.find,
					)
					if (found) {
						if (current) updateSelection(null)
						linkPress.current = { link: found.link, x: report.x, y: report.y }
						return
					}
				}
				const count = clicks.press(report.x, report.y)
				const mode = count === 1 ? 'char' : count === 2 ? 'word' : 'line'
				updateSelection({
					selection: { anchor: landing.point, focus: landing.point, mode },
					moved: mode !== 'char',
					pressing: true,
					copied: false,
					at: { x: report.x, y: report.y },
					replaced: current?.moved === true,
				})
				return
			}
			if (report.kind === 'release' && hintPress.current) {
				hintPress.current = false
				if (onHint) place(FOLLOWING)
				return
			}
			if (report.kind === 'release' && linkPress.current) {
				const pressed = linkPress.current
				linkPress.current = null
				if (links && report.x === pressed.x && report.y === pressed.y)
					showNote(links.activate(pressed.link, 'open'))
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
				// A click that did not move selects nothing. On a row that opens it opens
				// the row, unless it only let go of a selection.
				updateSelection(null)
				const row = landing.kind === 'on' ? latest.current.rows[landing.point.line] : undefined
				// A plain click on a link says how to open it; it opens nothing, and opens no row.
				const found =
					links &&
					landing.kind === 'on' &&
					!current.moved &&
					!current.replaced &&
					report.x === current.at.x &&
					report.y === current.at.y
						? linkAt(latest.current.rows, landing.point.line, landing.point.col, links.find)
						: null
				if (found && links) {
					showNote(links.activate(found.link, 'hint'))
					return
				}
				if (
					click &&
					!current.moved &&
					!current.replaced &&
					row?.opens === true &&
					landing.kind === 'on' &&
					report.x === current.at.x &&
					report.y === current.at.y
				)
					toggleAt(landing.point.line)
				return
			}
			updateSelection(finished)
			if (copyOnSelect) copySelection(finished)
			else showNote({ text: 'Selected. Press ctrl+c to copy it, or esc to let go.', ok: true })
		},
		[
			clicks,
			click,
			copyOnSelect,
			copySelection,
			scroll,
			showNote,
			toggleAt,
			updateSelection,
			updateHover,
			stopGlide,
			place,
			links,
			inert,
		],
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
			const before = searchRef.current
			searchRef.current = next
			setSearch(next)
			const typing = next !== null && next.browsing !== true
			if (
				(before !== null) !== (next !== null) ||
				(before !== null && (before.browsing !== true) !== typing)
			)
				onSearchChange?.(next !== null, typing)
		},
		[onSearchChange],
	)
	const goTo = useCallback(
		(match: Match | undefined) => {
			if (!match) return
			place(revealRow(viewNow.current, latest.current.index, match.row, room()))
		},
		[room, place],
	)
	const openSearch = useCallback(() => {
		// A glide ends where it stands: the view saved is the one the reader sees.
		stopGlide()
		savedView.current = viewNow.current
		updateSearch({ query: '', cursor: null })
	}, [updateSearch, stopGlide])
	const closeSearch = useCallback(() => {
		// Back to where the reader was; a reader who was following is following.
		place(savedView.current.follow ? FOLLOWING : savedView.current)
		updateSearch(null)
	}, [updateSearch, place])

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
				// Confirmed: the keys step through the matches, `/` types the query again, and Esc (taken
				// through the control) closes. Everything else is the owner's.
				if (open.browsing) {
					if (input === '/') updateSearch({ ...open, browsing: false })
					else if (input === 'n' || input === 'N') {
						const found = findMatches(latest.current.rows, open.query)
						const was = found.findIndex(
							(m) => m.row === open.cursor?.row && m.from === open.cursor?.from,
						)
						const to = found[stepMatch(found.length, was, input === 'n' ? 1 : -1)]
						if (to) {
							updateSearch({ ...open, cursor: { row: to.row, from: to.from } })
							goTo(to)
						}
					}
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
				} else if (detailed && edit.kind === 'next' && open.query.length > 0) {
					// Enter confirms the query: from here `n` and `N` step, the way a pager does.
					const found = findMatches(now, open.query)
					const current = found.findIndex(
						(m) => m.row === open.cursor?.row && m.from === open.cursor?.from,
					)
					const to = found[current >= 0 ? current : startMatch(found, bottomRow(state, at))]
					updateSearch({
						...open,
						browsing: true,
						cursor: to ? { row: to.row, from: to.from } : open.cursor,
					})
					goTo(to)
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
			if (isAction('app:searchTranscript', input, key) || (detailed && input === '/')) {
				openSearch()
				return
			}
			if (key.pageDown) scroll('page-down')
			else if (homeEndActive && key.home) scroll('top')
			else if (homeEndActive && key.end) scroll('bottom')
			else if (
				!detailed &&
				!key.pageUp &&
				(key.return || (input.length > 0 && !key.ctrl && !key.meta))
			) {
				// Typing is a reason to look at the end again, and to let go of a selection.
				if (selectionRef.current) updateSelection(null)
				if (!viewNow.current.follow) place(FOLLOWING)
			}
		},
		{ isActive: keysActive },
	)

	const { from, to } = visibleRange(synced, index, maxRows)
	const packedRows =
		header && !hidden && !yielded && synced.follow && from === 0 && !search
			? headerHeight.current + index.total
			: Number.POSITIVE_INFINITY
	const topAligned = packedRows <= boxHeight.current
	const unseen = hasUnseen(synced, index)
	const news =
		!synced.follow && away.current && replies
			? newsSince(away.current, replies, unseen, pending !== null)
			: undefined
	const hint = synced.follow ? null : jumpHint(columns, news)
	// The footer row is the search line, or the jump hint, or the note of a copy
	// in the hint's place. While following there is no footer, and a note must
	// not push the rows up under the reader's pointer: it is drawn over the last
	// row for the moment it stays.
	const noteLine = note
		? { text: note.text, color: note.ok ? theme.text.secondary : theme.status.error }
		: null
	const footer: { text: string; color: string } | null = search
		? {
				text: searchLine(
					search.query,
					currentIndex,
					matches.length,
					columns,
					search.browsing === true,
				),
				color: theme.text.primary,
			}
		: ((noteLine && hint ? noteLine : null) ??
			(hint
				? { text: hint, color: news && hasNews(news) ? theme.text.secondary : theme.text.muted }
				: null))
	const overlay = !search && !hint ? noteLine : null
	hintRef.current = hint !== null && !search && !noteLine
	geometryRef.current = {
		top,
		height: geometryRef.current.height,
		from,
		to,
		footer: footer ? 1 : 0,
		left: 1 + SCREEN_PADDING + GUTTER,
		cols: textWidth,
		...(topAligned ? { packed: headerHeight.current } : {}),
	}

	const range =
		selection?.moved === true
			? selectionRange(rowsSource(rows, textWidth), selection.selection)
			: null
	const marksFor = (row: FsRow, at: number): readonly Mark[] => {
		const marks: Mark[] = []
		// What the pointer can click, under it: a link is underlined, a row that opens is lit.
		// Where the terminal takes links, every link is sent as one as well.
		if (links && row.mark === undefined && (hyperlinks || hover !== null)) {
			for (const found of linksOnLine(rows, at, links.find)) {
				const lit = hover !== null && 'link' in hover && hover.link.id === found.id
				if (!lit && !hyperlinks) continue
				const style: Mark['style'] = {
					...(lit ? { underline: true } : {}),
					...(hyperlinks ? { href: linkHref(found.link) } : {}),
				}
				for (const piece of found.pieces)
					if (piece.row === at) marks.push({ from: piece.from, to: piece.to, style })
			}
		}
		if (hover !== null && 'row' in hover && hover.row === at) {
			const last = cellsOf(row.text).at(-1)
			marks.push({
				from: 0,
				to: last ? last.at + last.width : 0,
				style: { bold: true, underline: true },
			})
		}
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
			flexGrow={yielded ? 0 : 1}
			flexShrink={1}
			flexBasis={0}
			{...(yielded ? { height: 0 } : {})}
			overflowY="hidden"
			justifyContent={topAligned ? 'flex-start' : 'flex-end'}
		>
			{hidden || yielded ? null : (
				<Box flexDirection="column" flexShrink={0}>
					{from === 0 && header ? <Box ref={headerBox}>{header}</Box> : null}
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
						if (row.mark !== undefined) {
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
								<Box key={from + i} flexDirection="row">
									<Box width={2} flexShrink={0} />
									<Text color={theme.text.muted} dimColor wrap="truncate-end">
										{row.mark}
									</Text>
								</Box>
							)
						}
						const marks = marksFor(row, from + i)
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: a window of rows has no identity beyond its position.
							<Box key={from + i} flexDirection="row">
								<Box
									width={2}
									flexShrink={0}
									{...(row.tint !== undefined ? { backgroundColor: row.tint } : {})}
								>
									{row.tint !== undefined ? (
										<Text color={row.glyphColor} dimColor>
											{row.glyph}
										</Text>
									) : (
										<Text color={row.glyphColor} bold={row.plainMark !== true}>
											{row.glyph}
										</Text>
									)}
								</Box>
								{row.spans === undefined && marks.length === 0 ? (
									<Text
										color={row.color}
										wrap="truncate-end"
										{...(row.tint !== undefined ? { backgroundColor: row.tint } : {})}
									>
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
