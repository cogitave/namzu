/**
 * When an approving keystroke at the permission prompt counts as a decision.
 *
 * The prompt takes the screen on the agent's schedule, not the operator's. The
 * composer stays live while a turn runs and the docs encourage typing a
 * follow-up there, so the moment the agent asks to run a tool the overlay
 * replaces a composer someone's hands are already in. A keystroke begun before
 * that swap was aimed at the composer behind it, and must not be read as
 * consent for a tool call nobody has had time to read.
 *
 * So approval is deferred for a beat after the prompt opens. Refusal is NOT:
 * rejecting a call the operator wanted costs them a retry, while approving one
 * they never saw cannot be taken back, and a guard that hesitates in both
 * directions would make the safe key feel broken to buy nothing.
 */

/**
 * How long after the prompt opens an approving key is ignored.
 *
 * Long enough to swallow a keystroke already in flight, short enough that
 * someone who read the prompt and reached for `y` never waits on it. A fast
 * typist runs near 100ms between characters, so this covers roughly three
 * characters of overshoot.
 */
export const APPROVAL_SETTLE_MS = 350

/**
 * Whether an approving keypress arriving `now` should decide the prompt that
 * opened at `openedAt`.
 *
 * `null` — no recorded open — is refused rather than allowed. The value exists
 * only while a prompt is up, so its absence means the caller cannot establish
 * that the operator has seen anything, and the fail-safe reading of "I cannot
 * establish this" is not consent.
 */
export function approvalIsDeliberate(openedAt: number | null, now: number): boolean {
	if (openedAt === null) return false
	return now - openedAt >= APPROVAL_SETTLE_MS
}
