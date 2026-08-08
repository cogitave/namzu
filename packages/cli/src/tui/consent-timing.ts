/**
 * When a keystroke counts as consent.
 *
 * namzu has two screens that ask the operator to permit something, and both
 * appear on a schedule the operator does not control:
 *
 * - **The tool-permission prompt.** The composer stays editable while a turn
 *   runs and the docs encourage typing a follow-up there, so the overlay
 *   replaces a composer someone's hands are already in.
 * - **The trust gate.** It is the first screen of the program, reached by
 *   typing `namzu` and pressing Enter — so a key repeat, a buffered second
 *   press, or an impatient double-tap arrives while it is painting.
 *
 * In both cases the keystroke that lands was aimed at whatever was there
 * before, and must not be read as agreement to what replaced it. So granting
 * is deferred for a beat after the screen appears.
 *
 * **Refusing is never deferred**, at either screen. The asymmetry is the whole
 * design: a refusal the operator did not mean costs them a retry, while a grant
 * they did not mean cannot be taken back — the permission prompt runs the tool,
 * and the trust gate writes durable trust for a directory tree. A guard that
 * hesitated in both directions would make the safe key feel broken to buy
 * nothing.
 */

/**
 * How long after a consent screen appears a granting key is ignored.
 *
 * Long enough to swallow a keystroke already in flight, short enough that
 * someone who read the screen and reached for `y` never waits on it. A fast
 * typist runs near 100ms between characters, so this covers roughly three
 * characters of overshoot.
 */
export const APPROVAL_SETTLE_MS = 350

/**
 * Whether a granting keypress arriving `now` should decide the screen that
 * appeared at `shownAt`.
 *
 * `null` — no recorded appearance — is refused rather than allowed. The value
 * exists only while such a screen is up, so its absence means the caller cannot
 * establish that the operator has seen anything, and the fail-safe reading of
 * "I cannot establish this" is not consent.
 */
export function approvalIsDeliberate(shownAt: number | null, now: number): boolean {
	if (shownAt === null) return false
	return now - shownAt >= APPROVAL_SETTLE_MS
}
