/**
 * What the renderer and the main process say to each other about an extension's pages. The renderer only
 * reports where a page's rectangle is; it never loads the page. Everything is plain data read defensively.
 */

export interface PageBounds {
	x: number
	y: number
	width: number
	height: number
}

export type ExtensionPageEvent =
	| {
			what: 'stopped'
			extensionId: string
			pageId: string
			reason: 'strikes' | 'crashed' | 'changed' | 'closed'
	  }
	| {
			what: 'open-namzu'
			extensionId: string
			target: 'notice' | 'permissions' | 'licence' | 'record' | 'what-is-collected'
	  }
	/** Escape was pressed inside a page's own view, where this window cannot hear it. */
	| { what: 'escape' }

const num = (v: unknown, max: number): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) && v >= -max && v <= max ? v : undefined

/** A rectangle from the renderer: four finite numbers in a sane range, or nothing. */
export function readBounds(value: unknown): PageBounds | undefined {
	if (!value || typeof value !== 'object') return undefined
	const r = value as Record<string, unknown>
	const x = num(r.x, 100_000)
	const y = num(r.y, 100_000)
	const width = num(r.width, 100_000)
	const height = num(r.height, 100_000)
	return x === undefined || y === undefined || width === undefined || height === undefined
		? undefined
		: { x, y, width, height }
}

const ID = /^[a-z0-9][a-z0-9.-]{2,99}$/
const PAGE = /^[a-z][a-z0-9-]{0,47}$/
export const readExtensionId = (v: unknown): string | undefined =>
	typeof v === 'string' && ID.test(v) && !v.includes('..') ? v : undefined
export const readPageId = (v: unknown): string | undefined =>
	typeof v === 'string' && PAGE.test(v) ? v : undefined

/** The theme tokens the renderer measures from its own page and hands to the pages (names fixed, values plain). */
export const THEME_TOKEN_NAMES = [
	'--ns-bg',
	'--ns-surface',
	'--ns-fg',
	'--ns-muted',
	'--ns-border',
	'--ns-accent',
	'--ns-font',
	'--ns-radius',
] as const

export function readTheme(
	value: unknown,
): { dark: boolean; tokens: Record<string, string> } | undefined {
	if (!value || typeof value !== 'object') return undefined
	const r = value as { dark?: unknown; tokens?: unknown }
	if (typeof r.dark !== 'boolean' || !r.tokens || typeof r.tokens !== 'object') return undefined
	const tokens: Record<string, string> = {}
	for (const k of THEME_TOKEN_NAMES) {
		const v = (r.tokens as Record<string, unknown>)[k]
		if (typeof v === 'string' && v.length <= 120 && !/[;{}<>\\]/.test(v)) tokens[k] = v
	}
	return { dark: r.dark, tokens }
}
