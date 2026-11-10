import type { ThreadUsage } from '../shared/projection.js'

/** Tokens in plain words: 950, 12.4k, 200k, 1M. Never more than three significant figures. */
export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) return '0'
	const scaled = (value: number, unit: string): string => {
		const text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
		return `${text.includes('.') ? text.replace(/\.?0+$/, '') : text}${unit}`
	}
	if (count < 1000) return String(Math.round(count))
	if (count < 1_000_000) return scaled(count / 1000, 'k')
	return scaled(count / 1_000_000, 'M')
}

/** Dollars for a tooltip: "$0.42", and "under $0.01" instead of a misleading zero. */
export function formatCost(dollars: number): string {
	if (!Number.isFinite(dollars) || dollars <= 0) return '$0.00'
	if (dollars < 0.01) return 'under $0.01'
	return `$${dollars.toFixed(2)}`
}

export type ContextRingTone = 'normal' | 'high' | 'full'

export interface ContextRingModel {
	/** 0 to 1, how much of the window the conversation holds. */
	fraction: number
	percent: number
	tone: ContextRingTone
	/** The accessible name: a complete sentence, not a bare number. */
	label: string
	/** The tooltip's lines, in order. */
	lines: string[]
}

/** The ring turns amber at this share of the window, and red at the next. */
export const RING_HIGH = 0.75
export const RING_FULL = 0.9

/**
 * What the context ring shows, or nothing at all. Without a measured context size and a window to
 * measure it against there is no honest fraction, so the ring is not drawn rather than guessed.
 */
export function contextRingModel(usage: ThreadUsage | undefined): ContextRingModel | undefined {
	const used = usage?.contextTokens
	const window = usage?.contextWindowTokens
	if (used === undefined || window === undefined || window <= 0) return undefined
	const fraction = Math.min(1, Math.max(0, used / window))
	const percent = Math.round(fraction * 100)
	const tone: ContextRingTone =
		fraction >= RING_FULL ? 'full' : fraction >= RING_HIGH ? 'high' : 'normal'
	const size = `${formatTokens(used)} of ${formatTokens(window)} tokens`
	const lines = [
		`Context: ${size} (${percent}%)${usage?.measuredBy === 'estimate' ? ', estimated' : ''}`,
	]
	if (tone !== 'normal') lines.push('Older messages may be summarised to make room.')
	if (usage?.cost !== undefined) lines.push(`Cost so far: ${formatCost(usage.cost)}`)
	return {
		fraction,
		percent,
		tone,
		label: `Context ${percent}% full. ${size}.${usage?.cost !== undefined ? ` Cost so far ${formatCost(usage.cost)}.` : ''}`,
		lines,
	}
}

/** The working line while a compaction pass runs, and the note that replaces it. */
export const COMPACTING_TEXT = 'Compacting the conversation…'
export function compactedText(compaction: { tokensBefore?: number; tokensAfter?: number }): string {
	return compaction.tokensBefore !== undefined && compaction.tokensAfter !== undefined
		? `Conversation compacted · ${formatTokens(compaction.tokensBefore)} to ${formatTokens(compaction.tokensAfter)} tokens`
		: 'Conversation compacted'
}
