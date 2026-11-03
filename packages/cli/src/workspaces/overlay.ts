import stringWidth from 'string-width'
import { ATTR_BOLD, ATTR_DIM, ATTR_INVERSE } from '../terminal/host/cell.js'
import type { CellStyle, Frame, Rect } from '../terminal/host/frame.js'
import type { Palette } from './palette.js'

/** The size of the terminal an overlay is placed on. */
export interface Screen {
	readonly cols: number
	readonly rows: number
}

export type ModalAction = 'confirm' | 'cancel' | 'clear'

/** Where an overlay's parts are, so the same numbers draw it and find what a click lands on. */
export interface Surface {
	readonly rect: Rect
	readonly buttons: readonly { readonly rect: Rect; readonly action: ModalAction }[]
	readonly rows: readonly { readonly rect: Rect; readonly index: number }[]
}

export type Hit =
	| { readonly kind: 'outside' }
	| { readonly kind: 'inside' }
	| { readonly kind: 'button'; readonly action: ModalAction }
	| { readonly kind: 'row'; readonly index: number }

function within(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/** What a press at a cell lands on: a button, a row, the overlay's body, or outside it. */
export function hitSurface(surface: Surface, x: number, y: number): Hit {
	for (const b of surface.buttons)
		if (within(b.rect, x, y)) return { kind: 'button', action: b.action }
	for (const r of surface.rows) if (within(r.rect, x, y)) return { kind: 'row', index: r.index }
	return within(surface.rect, x, y) ? { kind: 'inside' } : { kind: 'outside' }
}

/** A square box in one colour. */
/** The text cursor of a field: a block in the text colour, or reversed where there is no colour. */
function caret(palette: Palette): CellStyle {
	return palette.mono ? { attrs: ATTR_INVERSE } : { bg: palette.text }
}

export function drawBox(frame: Frame, rect: Rect, fg: number, bg?: number): void {
	if (rect.width < 2 || rect.height < 2) return
	const style = { fg, ...(bg !== undefined ? { bg } : {}) }
	const right = rect.x + rect.width - 1
	const bottom = rect.y + rect.height - 1
	const across = '─'.repeat(rect.width - 2)
	frame.writeText({ ...rect, height: 1 }, 0, `╭${across}╮`, style)
	frame.writeText({ ...rect, y: bottom, height: 1 }, 0, `╰${across}╯`, style)
	for (let y = rect.y + 1; y < bottom; y++) {
		frame.writeText({ x: rect.x, y, width: 1, height: 1 }, 0, '│', style)
		frame.writeText({ x: right, y, width: 1, height: 1 }, 0, '│', style)
	}
}

/** Dims everything drawn so far, so the overlay on top stands out. */
export function dimFrame(frame: Frame): void {
	for (let i = 0; i < frame.cells.length; i++) {
		const cell = frame.cells[i]
		if (cell && cell.width > 0) frame.cells[i] = { ...cell, attrs: cell.attrs | ATTR_DIM }
	}
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value))
}

function centred(screen: Screen, width: number, height: number): Rect {
	const w = Math.min(width, screen.cols)
	const h = Math.min(height, screen.rows)
	return {
		x: Math.floor((screen.cols - w) / 2),
		y: Math.floor((screen.rows - h) / 2),
		width: w,
		height: h,
	}
}

// --- question and name modals ----------------------------------------------

export interface ModalButton {
	readonly label: string
	readonly action: ModalAction
	/** The button enter presses: filled in the modal's colour. */
	readonly primary?: boolean
}

export interface ModalSpec {
	readonly title: string
	/** A destructive question: its border, title and main button are red. */
	readonly danger?: boolean
	readonly lines?: readonly string[]
	/** A text field, shown with its text and a cursor. */
	readonly input?: { readonly value: string }
	readonly error?: string
	readonly buttons: readonly ModalButton[]
}

export interface ModalLayout extends Surface {
	readonly inputRect: Rect | undefined
}

const BUTTON_GAP = 2

function buttonWidth(button: ModalButton): number {
	return stringWidth(button.label) + 2
}

/** The buttons that fit in `room` columns: the optional ones (neither primary nor cancel) go first, then the label of the rest is kept whole. */
export function fittingButtons(buttons: readonly ModalButton[], room: number): ModalButton[] {
	const total = (list: readonly ModalButton[]) =>
		list.reduce((sum, b) => sum + buttonWidth(b), 0) + BUTTON_GAP * Math.max(0, list.length - 1)
	const kept = [...buttons]
	for (let i = kept.length - 1; i >= 0 && total(kept) > room; i--) {
		const b = kept[i]
		if (b && !b.primary && b.action !== 'cancel') kept.splice(i, 1)
	}
	return kept
}

export function layoutModal(screen: Screen, fullSpec: ModalSpec): ModalLayout {
	const spec: ModalSpec = {
		...fullSpec,
		buttons: fittingButtons(fullSpec.buttons, screen.cols - 4),
	}
	const buttonsWidth =
		spec.buttons.reduce((sum, b) => sum + buttonWidth(b), 0) +
		BUTTON_GAP * Math.max(0, spec.buttons.length - 1)
	const content = Math.max(
		stringWidth(spec.title),
		buttonsWidth,
		...(spec.lines ?? []).map((l) => stringWidth(l)),
	)
	const width = Math.min(screen.cols - 2, Math.max(spec.input ? 56 : 40, content + 6))
	const body = (spec.lines?.length ?? 0) + (spec.input ? 2 + (spec.error ? 1 : 0) : 0)
	// Border, title, body, a blank row, the buttons, border.
	const rect = centred(screen, width, body + 5)
	const inner = rect.width - 2
	let y = rect.y + 2 + (spec.lines?.length ?? 0)
	let inputRect: Rect | undefined
	if (spec.input) {
		inputRect = { x: rect.x + 1, y: y + 1, width: inner, height: 1 }
		y += 2 + (spec.error ? 1 : 0)
	}
	const buttons: { rect: Rect; action: ModalAction }[] = []
	let x = rect.x + 1 + Math.max(1, Math.floor((inner - buttonsWidth) / 2))
	const by = rect.y + rect.height - 2
	for (const b of spec.buttons) {
		buttons.push({ rect: { x, y: by, width: buttonWidth(b), height: 1 }, action: b.action })
		x += buttonWidth(b) + BUTTON_GAP
	}
	return { rect, buttons, rows: [], inputRect }
}

export function drawModal(
	frame: Frame,
	layout: ModalLayout,
	spec: ModalSpec,
	palette: Palette,
): void {
	const { rect } = layout
	const tone = spec.danger ? palette.danger : palette.focus
	frame.fillRect(rect, { bg: palette.base })
	drawBox(frame, rect, tone, palette.base)
	const inner = { x: rect.x + 2, y: rect.y, width: rect.width - 4, height: rect.height }
	frame.writeText(inner, 1, spec.title, {
		fg: spec.danger ? palette.danger : palette.text,
		bg: palette.base,
		attrs: ATTR_BOLD,
	})
	;(spec.lines ?? []).forEach((line, i) =>
		frame.writeText(inner, 2 + i, line, { fg: palette.subtext, bg: palette.base }),
	)
	if (layout.inputRect && spec.input) {
		const field = layout.inputRect
		frame.fillRect(field, { bg: palette.surface })
		const room = Math.max(0, field.width - 3)
		let shown = spec.input.value
		while (stringWidth(shown) > room) shown = shown.slice(1)
		const used = frame.writeText({ ...field, x: field.x + 1, width: field.width - 1 }, 0, shown, {
			fg: palette.text,
			bg: palette.surface,
		})
		frame.writeText({ ...field, x: field.x + 1 + used, width: 1 }, 0, ' ', caret(palette))
		if (spec.error)
			frame.writeText(inner, field.y - rect.y + 1, spec.error, {
				fg: palette.danger,
				bg: palette.base,
			})
	}
	spec.buttons.forEach((b) => {
		const at = layout.buttons.find((l) => l.action === b.action)?.rect
		if (!at) return
		const style: CellStyle = !b.primary
			? { fg: palette.text, bg: palette.surface }
			: palette.mono
				? { attrs: ATTR_BOLD | ATTR_INVERSE }
				: { fg: palette.ink, bg: tone, attrs: ATTR_BOLD }
		frame.fillRect(at, style)
		frame.writeText({ ...at, x: at.x + 1, width: at.width - 1 }, 0, b.label, style)
	})
}

// --- lists in a modal --------------------------------------------------------

export interface ListRow {
	readonly text: string
	/** Columns the row is pushed right, for a tree. */
	readonly indent?: number
	readonly dot?: { readonly glyph: string; readonly fg: number }
	/** A group heading: drawn bold, never chosen. */
	readonly heading?: boolean
	/** The keys of a help row, drawn in the accent colour before the text. */
	readonly keys?: string
	/** Dim text, for a row that is context rather than a choice. */
	readonly muted?: boolean
}

export interface ListSpec {
	readonly title: string
	readonly input?: { readonly value: string }
	readonly rows: readonly ListRow[]
	/** The chosen row, or -1 when nothing is chosen (a help screen). */
	readonly index: number
	readonly scroll: number
	readonly footer: string
	readonly width: number
}

export interface ListLayout extends Surface {
	readonly inputRect: Rect | undefined
	/** The first row shown. */
	readonly top: number
	/** How many rows fit. */
	readonly capacity: number
}

export function layoutList(screen: Screen, spec: ListSpec): ListLayout {
	// Border, title, [field, blank | blank], the rows, a blank, the hints, border.
	const head = spec.input ? 4 : 3
	const chrome = head + 3
	const wanted = Math.max(1, spec.rows.length) + chrome
	const height = Math.min(screen.rows - 2, wanted)
	const rect = centred(screen, Math.min(screen.cols - 2, spec.width), Math.max(chrome + 1, height))
	const capacity = Math.max(1, rect.height - chrome)
	const most = Math.max(0, spec.rows.length - capacity)
	let top = clamp(spec.scroll, 0, most)
	if (spec.index >= 0) {
		if (spec.index < top) top = spec.index
		else if (spec.index >= top + capacity) top = spec.index - capacity + 1
		top = clamp(top, 0, most)
	}
	const first = rect.y + head
	const rows: { rect: Rect; index: number }[] = []
	for (let i = 0; i < capacity && top + i < spec.rows.length; i++) {
		const row = spec.rows[top + i]
		if (row?.heading) continue
		rows.push({
			rect: { x: rect.x + 1, y: first + i, width: rect.width - 2, height: 1 },
			index: top + i,
		})
	}
	const inputRect = spec.input
		? { x: rect.x + 1, y: rect.y + 2, width: rect.width - 2, height: 1 }
		: undefined
	return { rect, buttons: [], rows, inputRect, top, capacity }
}

export function drawList(frame: Frame, layout: ListLayout, spec: ListSpec, palette: Palette): void {
	const { rect } = layout
	frame.fillRect(rect, { bg: palette.base })
	drawBox(frame, rect, palette.focus, palette.base)
	const inner = { x: rect.x + 2, y: rect.y, width: rect.width - 4, height: rect.height }
	frame.writeText(inner, 1, spec.title, { fg: palette.text, bg: palette.base, attrs: ATTR_BOLD })
	if (layout.inputRect && spec.input) {
		const field = layout.inputRect
		frame.fillRect(field, { bg: palette.surface })
		const room = Math.max(0, field.width - 3)
		let shown = spec.input.value
		while (stringWidth(shown) > room) shown = shown.slice(1)
		const used = frame.writeText({ ...field, x: field.x + 1, width: field.width - 1 }, 0, shown, {
			fg: palette.text,
			bg: palette.surface,
		})
		frame.writeText({ ...field, x: field.x + 1 + used, width: 1 }, 0, ' ', caret(palette))
	}
	const first = rect.y + (spec.input ? 4 : 3)
	for (let i = 0; i < layout.capacity; i++) {
		const row = spec.rows[layout.top + i]
		if (!row) break
		const area = { x: rect.x + 1, y: first + i, width: rect.width - 2, height: 1 }
		const chosen = layout.top + i === spec.index
		const bg = chosen ? palette.cursorRow : palette.base
		const mark = chosen && palette.mono ? ATTR_INVERSE : 0
		frame.fillRect(area, { bg, ...(mark ? { attrs: mark } : {}) })
		let x = 1 + (row.indent ?? 0)
		const put = (text: string, style: { fg: number; attrs?: number }): void => {
			x += frame.writeText(
				{ ...area, x: area.x + x, width: Math.max(0, area.width - x) },
				0,
				text,
				{
					...style,
					bg,
					attrs: (style.attrs ?? 0) | mark,
				},
			)
		}
		if (row.dot) {
			put(row.dot.glyph, { fg: row.dot.fg })
			x += 1
		}
		if (row.keys !== undefined) {
			put(row.keys.padEnd(12), { fg: palette.accent, attrs: ATTR_BOLD })
			x += 1
		}
		put(row.text, {
			fg: row.heading
				? palette.dim
				: row.muted
					? palette.dim
					: chosen
						? palette.text
						: palette.subtext,
			...(row.heading || chosen ? { attrs: ATTR_BOLD } : {}),
		})
	}
	frame.writeText({ ...inner, y: rect.y + rect.height - 2, height: 1 }, 0, spec.footer, {
		fg: palette.dim,
		bg: palette.base,
	})
}

// --- small popups ------------------------------------------------------------

/** The box a menu or a context menu draws: rows of text at a point of the screen. */
export function layoutPopup(
	screen: Screen,
	at: { readonly x: number; readonly y: number },
	items: readonly string[],
	minWidth = 14,
): Surface {
	const width = Math.min(
		screen.cols,
		Math.max(minWidth, ...items.map((i) => stringWidth(i) + 4)) + 2,
	)
	const height = items.length + 2
	const x = clamp(at.x, 0, Math.max(0, screen.cols - width))
	const y = clamp(at.y, 0, Math.max(0, screen.rows - height))
	const rect = { x, y, width, height }
	return {
		rect,
		buttons: [],
		rows: items.map((_, i) => ({
			rect: { x: x + 1, y: y + 1 + i, width: width - 2, height: 1 },
			index: i,
		})),
	}
}

export function drawPopup(
	frame: Frame,
	surface: Surface,
	items: readonly string[],
	index: number,
	palette: Palette,
): void {
	frame.fillRect(surface.rect, { bg: palette.base })
	drawBox(frame, surface.rect, palette.focus, palette.base)
	items.forEach((item, i) => {
		const row = surface.rows[i]?.rect
		if (!row) return
		const chosen = i === index
		const style: CellStyle = !chosen
			? { fg: palette.subtext, bg: palette.base }
			: palette.mono
				? { attrs: ATTR_BOLD | ATTR_INVERSE }
				: { fg: palette.ink, bg: palette.accent, attrs: ATTR_BOLD }
		frame.fillRect(row, style)
		frame.writeText({ ...row, x: row.x + 1, width: row.width - 1 }, 0, item, style)
	})
}
