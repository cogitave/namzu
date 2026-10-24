/**
 * The footer's context meter: how close the window is to the point where the
 * conversation gets summarised.
 *
 * The meter shows nothing until the context is within 20,000
 * tokens of its auto-compact threshold, then `N% until auto-compact` (dim),
 * or, with auto-compact off, `Context low (N% remaining) · Run /compact to
 * compact & continue` (red). The percentage counts down to the threshold the
 * conversation will really be compacted at, not to the end of the window.
 *
 * The threshold is the kernel's own, read from the same function the kernel
 * compares against (`resolveTriggerThreshold`), so the figure never disagrees
 * with when compaction actually happens.
 */

import { resolveTriggerThreshold } from '@namzu/sdk'

/** The meter appears this many tokens before the threshold. */
export const CONTEXT_WARNING_MARGIN_TOKENS = 20_000

export interface ContextMeter {
	readonly text: string
	/** `muted` while compaction will handle it; `error` when nothing will. */
	readonly tone: 'muted' | 'error'
}

export interface ContextMeterInput {
	/** The context being sent now, in tokens. */
	readonly tokens: number
	/** The model's window, in tokens. */
	readonly windowTokens: number
	/** Whether the session summarises on its own at the threshold. */
	readonly autoCompact: boolean
	readonly triggerThreshold?: number
}

/** `null` while there is room to spare; otherwise the words for the footer. */
export function contextMeter(input: ContextMeterInput): ContextMeter | null {
	const { tokens, windowTokens, autoCompact } = input
	if (!Number.isFinite(tokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return null
	const threshold = resolveTriggerThreshold(input.triggerThreshold, windowTokens)
	// With auto-compact the end of the road is the threshold; without it, the window.
	const ceiling = autoCompact ? Math.floor(windowTokens * threshold) : windowTokens
	if (ceiling <= 0 || tokens < ceiling - CONTEXT_WARNING_MARGIN_TOKENS) return null
	const left = Math.max(0, Math.round(((ceiling - tokens) / ceiling) * 100))
	return autoCompact
		? { text: `${left}% until auto-compact`, tone: 'muted' }
		: {
				text: `Context low (${left}% remaining) · Run /compact to compact & continue`,
				tone: 'error',
			}
}
