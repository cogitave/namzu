/**
 * The `/context` view as data: a grid of cells that stands for the window,
 * the legend beside it, the lists below, and the advice.
 *
 * Pure. `context-usage.ts` gathers the sizes and `ContextGridRow` draws what
 * this returns; nothing here reads a file, a session or the terminal.
 */

import type {
	ContextBreakdown,
	ContextCategory,
	ContextCategoryId,
	ContextMessageBreakdown,
} from '@namzu/sdk'

/** Glyphs. A full square, a partly filled one, free room, and the compaction buffer. */
export const GLYPH_FULL = '⛁'
export const GLYPH_PARTIAL = '⛀'
export const GLYPH_FREE = '⛶'
export const GLYPH_BUFFER = '⛝'

/** A square this full or fuller is drawn as a full one. */
export const FULL_SQUARE_FROM = 0.7

/** Colours by category, as ANSI-256 indices the theme's own palette already uses. */
export const CONTEXT_COLORS: Readonly<Record<ContextCategoryId, string>> = {
	'system-prompt': 'ansi256(245)',
	'system-tools': 'ansi256(248)',
	'mcp-tools': 'ansi256(37)',
	'mcp-instructions': 'ansi256(77)',
	agents: 'ansi256(147)',
	memory: 'ansi256(173)',
	skills: 'ansi256(221)',
	messages: 'ansi256(141)',
	buffer: 'ansi256(245)',
	free: 'ansi256(239)',
}

export interface GridCell {
	readonly glyph: string
	readonly color: string
	readonly dim: boolean
}

export interface LegendLine {
	readonly glyph: string
	readonly color: string
	readonly dimGlyph: boolean
	readonly name: string
	/** The dim part after the name. */
	readonly value: string
	/** The name is dim too (the compaction buffer). */
	readonly dimName: boolean
}

export interface ContextListItem {
	readonly label: string
	readonly value: string
}

export interface ContextListGroup {
	/** A dim heading over the items, such as the folder they came from. */
	readonly heading?: string
	readonly items: readonly ContextListItem[]
}

export interface ContextSection {
	readonly title: string
	readonly hint: string
	readonly groups: readonly ContextListGroup[]
}

export interface ContextSuggestion {
	readonly level: 'warning' | 'info'
	readonly title: string
	readonly detail: string
	/** Tokens it could free, roughly. */
	readonly savings: number
}

export interface ContextView {
	readonly model?: string
	/** A red line when the context no longer fits. */
	readonly overLimit?: string
	readonly cells: readonly (readonly GridCell[])[]
	readonly usage: string
	readonly legend: readonly LegendLine[]
	readonly windowNote?: { readonly label: string; readonly value: string }
	readonly sections: readonly ContextSection[]
	readonly suggestions: readonly ContextSuggestion[]
	/** Lines under the advice, such as what the automatic cleanup has done. */
	readonly notes?: readonly string[]
	/** The same content as plain lines, for the transcript's copy and export. */
	readonly text: string
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** `1234` to `1.2k`, `42000` to `42k`, `1000000` to `1m`. */
export function formatTokens(value: number): string {
	return compact
		.format(Math.max(0, Math.round(value)))
		.toLowerCase()
		.replace('.0', '')
}

/** A skill's size is a rough figure: rounded to ten, or `< 20`. */
export function formatSkillTokens(value: number): string {
	return value < 20 ? '< 20' : `~${formatTokens(Math.round(value / 10) * 10)}`
}

export interface GridShape {
	readonly columns: number
	readonly rows: number
}

/** 10 by 10, 5 by 5 on a narrow terminal, 20 by 10 for a window of a million or more. */
export function gridShape(windowTokens: number, terminalColumns: number): GridShape {
	const narrow = terminalColumns < 80
	const huge = windowTokens >= 1_000_000
	return { columns: narrow ? 5 : huge ? 20 : 10, rows: huge ? 10 : narrow ? 5 : 10 }
}

/** The cells, row by row, for the window. */
export function buildGridCells(
	categories: readonly ContextCategory[],
	windowTokens: number,
	terminalColumns: number,
): GridCell[][] {
	const { columns, rows } = gridShape(windowTokens, terminalColumns)
	const total = columns * rows
	if (!(windowTokens > 0)) return []
	const cells: GridCell[] = []
	let bufferSquares = 0
	for (const category of categories) {
		if (category.tokens <= 0 || category.kind === 'free') continue
		const exact = (category.tokens / windowTokens) * total
		if (category.kind === 'buffer') {
			bufferSquares = Math.max(1, Math.round(exact))
			continue
		}
		const squares = Math.max(1, Math.round(exact))
		for (let i = 0; i < squares; i += 1) {
			const fraction = exact - Math.floor(exact)
			const fullness = i === Math.floor(exact) && fraction > 0 ? fraction : 1
			cells.push({
				glyph: fullness >= FULL_SQUARE_FROM ? GLYPH_FULL : GLYPH_PARTIAL,
				color: CONTEXT_COLORS[category.id],
				dim: false,
			})
		}
	}
	while (cells.length < total - bufferSquares) {
		cells.push({ glyph: GLYPH_FREE, color: CONTEXT_COLORS.free, dim: true })
	}
	for (let i = 0; i < bufferSquares; i += 1) {
		cells.push({ glyph: GLYPH_BUFFER, color: CONTEXT_COLORS.buffer, dim: false })
	}
	cells.length = Math.min(cells.length, total)
	const out: GridCell[][] = []
	for (let row = 0; row < rows; row += 1) out.push(cells.slice(row * columns, (row + 1) * columns))
	return out
}

/** One legend line per category with something in it, then free space and the buffer. */
export function buildLegend(breakdown: ContextBreakdown): LegendLine[] {
	const window = breakdown.windowTokens
	const pct = (tokens: number) => (window > 0 ? ((tokens / window) * 100).toFixed(1) : '0.0')
	const lines: LegendLine[] = []
	for (const category of breakdown.categories) {
		if (category.tokens <= 0 || category.kind === 'free') continue
		// The automatic buffer has its own glyph and a dim name, below free space;
		// the manual-compaction room is an ordinary line.
		if (category.kind === 'buffer' && breakdown.autoCompact) continue
		lines.push({
			glyph: GLYPH_FULL,
			color: CONTEXT_COLORS[category.id],
			dimGlyph: false,
			name: category.name,
			value: `${formatTokens(category.tokens)} tokens (${pct(category.tokens)}%)`,
			dimName: false,
		})
	}
	const free = breakdown.categories.find((c) => c.kind === 'free')
	if (free && free.tokens > 0) {
		lines.push({
			glyph: GLYPH_FREE,
			color: CONTEXT_COLORS.free,
			dimGlyph: true,
			name: 'Free space',
			value: `${formatTokens(free.tokens)} (${pct(free.tokens)}%)`,
			dimName: false,
		})
	}
	const buffer = breakdown.categories.find((c) => c.kind === 'buffer')
	if (buffer && buffer.tokens > 0 && breakdown.autoCompact) {
		lines.push({
			glyph: GLYPH_BUFFER,
			color: CONTEXT_COLORS.buffer,
			dimGlyph: false,
			name: buffer.name,
			value: `${formatTokens(buffer.tokens)} tokens (${pct(buffer.tokens)}%)`,
			dimName: true,
		})
	}
	return lines
}

/** The advice thresholds. */
export const SUGGEST_TOOL_SHARE_PERCENT = 15
export const SUGGEST_TOOL_MIN_TOKENS = 10_000
export const SUGGEST_READ_SHARE_PERCENT = 5
export const SUGGEST_FULL_PERCENT = 80
export const SUGGEST_MEMORY_SHARE_PERCENT = 5
export const SUGGEST_MEMORY_MIN_TOKENS = 5_000
const OTHER_TOOL_SHARE_PERCENT = 20

export interface SuggestionInput {
	readonly breakdown: ContextBreakdown
	readonly autoCompact: boolean
	readonly memoryFiles: readonly { readonly label: string; readonly tokens: number }[]
}

const share = (tokens: number, window: number) => (window > 0 ? (tokens / window) * 100 : 0)
const shareText = (tokens: number, window: number) =>
	`${formatTokens(tokens)} tokens (${share(tokens, window).toFixed(0)}%)`

function byTool(
	messages: ContextMessageBreakdown,
): Map<string, { calls: number; results: number }> {
	const out = new Map<string, { calls: number; results: number }>()
	for (const [name, tokens] of Object.entries(messages.toolCallsByType)) {
		out.set(name, { calls: tokens, results: out.get(name)?.results ?? 0 })
	}
	for (const [name, tokens] of Object.entries(messages.toolResultsByType)) {
		out.set(name, { calls: out.get(name)?.calls ?? 0, results: tokens })
	}
	return out
}

/** Advice, warnings first and then by what it could free. Silent once the context no longer fits. */
export function buildSuggestions(input: SuggestionInput): ContextSuggestion[] {
	const { breakdown, autoCompact } = input
	const window = breakdown.windowTokens
	if (!(window > 0) || breakdown.totalTokens > window) return []
	const out: ContextSuggestion[] = []
	if (breakdown.percentage >= SUGGEST_FULL_PERCENT) {
		out.push({
			level: 'warning',
			title: `Context is ${breakdown.percentage}% full`,
			detail: autoCompact
				? 'Older messages will be summarised soon. Run /compact now to choose what is kept.'
				: 'Nothing summarises this on its own. Run /compact to free space.',
			savings: 0,
		})
	}
	for (const [name, sizes] of byTool(breakdown.messageBreakdown)) {
		const tokens = sizes.calls + sizes.results
		const percent = share(tokens, window)
		if (percent < SUGGEST_TOOL_SHARE_PERCENT || tokens < SUGGEST_TOOL_MIN_TOKENS) continue
		const known = KNOWN_TOOL_ADVICE[name]
		if (!known && percent < OTHER_TOOL_SHARE_PERCENT) continue
		const advice = known ?? {
			level: 'info' as const,
			detail: 'This tool is using a large part of the context.',
			saves: 0.2,
		}
		out.push({
			level: advice.level,
			title: `${name} ${known ? 'results using' : 'using'} ${shareText(tokens, window)}`,
			detail: advice.detail,
			savings: Math.round(tokens * advice.saves),
		})
	}
	const readResults = breakdown.messageBreakdown.toolResultsByType.read ?? 0
	const readSizes = byTool(breakdown.messageBreakdown).get('read')
	const readTotal = (readSizes?.calls ?? 0) + (readSizes?.results ?? 0)
	const readToolFired =
		share(readTotal, window) >= SUGGEST_TOOL_SHARE_PERCENT && readTotal >= SUGGEST_TOOL_MIN_TOKENS
	if (
		!readToolFired &&
		share(readResults, window) >= SUGGEST_READ_SHARE_PERCENT &&
		readResults >= SUGGEST_TOOL_MIN_TOKENS
	) {
		out.push({
			level: 'info',
			title: `File reads using ${shareText(readResults, window)}`,
			detail: 'Refer to earlier reads instead of reading again, and read only the lines you need.',
			savings: Math.round(readResults * 0.3),
		})
	}
	const memory = breakdown.categories.find((c) => c.id === 'memory')?.tokens ?? 0
	if (
		share(memory, window) >= SUGGEST_MEMORY_SHARE_PERCENT &&
		memory >= SUGGEST_MEMORY_MIN_TOKENS
	) {
		const largest = [...input.memoryFiles]
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, 3)
			.map((file) => `${file.label} (${formatTokens(file.tokens)})`)
		out.push({
			level: 'info',
			title: `Memory files using ${shareText(memory, window)}`,
			detail: `Largest: ${largest.join(', ')}. Run /memory to review and trim old entries.`,
			savings: Math.round(memory * 0.3),
		})
	}
	if (!autoCompact && breakdown.percentage >= 50 && breakdown.percentage < SUGGEST_FULL_PERCENT) {
		out.push({
			level: 'info',
			title: 'Autocompact is disabled',
			detail: 'Without it the conversation will run out of room. Run /compact when it gets full.',
			savings: 0,
		})
	}
	return out.sort(
		(a, b) => (a.level === b.level ? 0 : a.level === 'warning' ? -1 : 1) || b.savings - a.savings,
	)
}

const KNOWN_TOOL_ADVICE: Record<
	string,
	{ level: 'warning' | 'info'; detail: string; saves: number }
> = {
	bash: {
		level: 'warning',
		detail: 'Pipe output through head, tail or grep, and read files with offsets rather than cat.',
		saves: 0.5,
	},
	read: {
		level: 'info',
		detail: 'Read only the lines you need, and avoid reading the same file again.',
		saves: 0.3,
	},
	grep: {
		level: 'info',
		detail: 'Use narrower patterns or a file filter, and glob to find files.',
		saves: 0.3,
	},
	web_fetch: {
		level: 'info',
		detail: 'Pages can be very large. Ask for only the part you need.',
		saves: 0.4,
	},
}

export interface BuildViewInput {
	readonly breakdown: ContextBreakdown
	readonly windowSource: 'auto' | 'config' | 'default'
	readonly autoCompact: boolean
	/** The context size is an estimate, or the window was assumed. */
	readonly approximate: boolean
	readonly model?: string
	readonly terminalColumns: number
	readonly sections: readonly ContextSection[]
	readonly memoryFiles: SuggestionInput['memoryFiles']
}

/** Assemble the whole view and its plain-text twin. */
export function buildContextView(input: BuildViewInput): ContextView {
	const { breakdown } = input
	const window = breakdown.windowTokens
	const approx = input.approximate ? '~' : ''
	const usage = `${approx}${formatTokens(breakdown.totalTokens)}/${formatTokens(window)} tokens (${breakdown.percentage}%)`
	let overLimit: string | undefined
	if (breakdown.overflowTokens > 0) {
		const over = formatTokens(breakdown.overflowTokens)
		const raw = formatTokens(window)
		overLimit =
			input.windowSource === 'auto'
				? `Context exceeds the ${raw}-token limit by ${over} tokens — run /compact or /clear to continue.`
				: `Context is ${over} tokens past the ${raw}-token compaction window — run /compact to reduce usage.`
	}
	const windowNote =
		input.autoCompact && input.windowSource !== 'auto'
			? {
					label: 'Auto-compact window: ',
					value:
						input.windowSource === 'default'
							? `${window.toLocaleString('en-US')} tokens (default for an unrecognized model)`
							: `${window.toLocaleString('en-US')} tokens`,
				}
			: undefined
	const cells = buildGridCells(breakdown.categories, window, input.terminalColumns)
	const legend = buildLegend(breakdown)
	const suggestions = buildSuggestions({
		breakdown,
		autoCompact: input.autoCompact,
		memoryFiles: input.memoryFiles,
	})
	const lines: string[] = ['Context usage']
	if (overLimit) lines.push(overLimit)
	if (input.model) lines.push(input.model)
	lines.push(usage, '', 'Estimated usage by category')
	for (const line of legend) lines.push(`${line.glyph} ${line.name}: ${line.value}`)
	if (windowNote) lines.push(`${windowNote.label}${windowNote.value}`)
	for (const section of input.sections) {
		lines.push('', `${section.title} · ${section.hint}`)
		for (const group of section.groups) {
			if (group.heading) lines.push(`  ${group.heading}`)
			for (const item of group.items) lines.push(`  ${item.label}: ${item.value}`)
		}
	}
	if (suggestions.length > 0) {
		lines.push('', 'Suggestions')
		for (const s of suggestions) {
			lines.push(
				`${s.level === 'warning' ? '!' : '-'} ${s.title}${s.savings > 0 ? ` → save ~${formatTokens(s.savings)}` : ''}`,
			)
			lines.push(`  ${s.detail}`)
		}
	}
	return {
		...(input.model ? { model: input.model } : {}),
		...(overLimit ? { overLimit } : {}),
		cells,
		usage,
		legend,
		...(windowNote ? { windowNote } : {}),
		sections: input.sections,
		suggestions,
		text: lines.join('\n'),
	}
}

/** The view with extra lines under it, in the drawing and in the plain text. */
export function withContextNotes(view: ContextView, notes: readonly string[]): ContextView {
	if (notes.length === 0) return view
	return { ...view, notes, text: `${view.text}\n\n${notes.join('\n')}` }
}
