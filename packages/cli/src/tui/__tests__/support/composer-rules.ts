/**
 * The composer is two plain horizontal rules with the input between them. A
 * test that needs "the row under the frame" or "the frame's own rows" finds
 * the rules here instead of the box corners the frame used to have.
 */

const PLAIN_RULE = /^\s*─{3,}\s*$/u

/** Index of the composer's lower rule (the last row made only of `─`), or -1. */
export function lowerRuleRow(viewport: readonly string[]): number {
	for (let at = viewport.length - 1; at >= 0; at--) {
		if (PLAIN_RULE.test(viewport[at] ?? '')) return at
	}
	return -1
}

/**
 * Index of the composer's upper rule: the nearest row above the lower one that
 * is a rule, which may carry the mode label at its right end. -1 when absent.
 */
export function upperRuleRow(viewport: readonly string[]): number {
	const lower = lowerRuleRow(viewport)
	for (let at = lower - 1; at >= 0; at--) {
		if (/^\s*─{3,}(?: \S+ ─)?\s*$/u.test(viewport[at] ?? '')) return at
	}
	return -1
}
