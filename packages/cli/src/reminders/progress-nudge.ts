import type { ProgressNudgeConfig } from '../config/schema.js'

/** What a session needs to build the quiet-stretch clock. */
export interface ProgressNudgeSettings {
	/** Milliseconds of work; absent means the default. */
	readonly afterMs?: number
	readonly afterCalls?: number
	/** Milliseconds, injectable; absent means the wall clock. */
	readonly now?: () => number
}

/**
 * Whether a session gets the quiet-stretch nudge, and its stretch.
 *
 * `watched` says the surface has a person looking at the work live (the
 * terminal, the Desktop application). `auto`, the default, nudges only there.
 * `on` also nudges where nobody is known to look, for a `namzu exec` run in
 * text mode; callers that must never nudge (`exec --json`, scheduled runs,
 * Pals, sub-agents) do not call this at all.
 */
export function resolveProgressNudge(
	config: ProgressNudgeConfig | undefined,
	surface: { readonly watched: boolean },
): ProgressNudgeSettings | undefined {
	const mode = config?.mode ?? 'auto'
	if (mode === 'off' || (mode === 'auto' && !surface.watched)) return undefined
	return {
		...(config?.afterSeconds !== undefined ? { afterMs: config.afterSeconds * 1000 } : {}),
		...(config?.afterCalls !== undefined ? { afterCalls: config.afterCalls } : {}),
	}
}
