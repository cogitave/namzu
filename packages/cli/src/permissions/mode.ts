import { REVIEW_MODES, type ReviewMode, isReviewMode } from '@namzu/sdk'

/**
 * How a turn resolves the calls no rule decided.
 *
 * The `[permissions]` table says what a tool may do. The kernel's review
 * policy (`createReviewHandler` in `@namzu/sdk`) says what happens to
 * everything it did not cover; the modes and their words live there, and
 * this file resolves which one a turn gets from the flag and the terminal.
 *
 * The two axes are separate on purpose: a rule is
 * a durable statement an operator reviewed, and a mode is a property of ONE
 * invocation — the difference between "we never force-push" and "this turn is
 * unattended".
 *
 * ## Precedence between a flag and the config file
 *
 * A mode only governs calls the gate routed to REVIEW. A rule that denied a
 * call already stopped it, and a rule that allowed one never asked, so neither
 * reaches the mode at all. **A mode can therefore never reopen what a rule
 * closed, and `--permission-mode` cannot widen a `deny`.**
 *
 * That direction is deliberate. The config file is written once, read by
 * whoever reviews the repository, and changed on purpose; a flag is typed in a
 * hurry by someone who wants to get on with it. Letting the hurried thing
 * overrule the considered one would make every `deny` in the file advisory, and
 * a prohibition that a flag can lift is not a prohibition. The dangerous-pattern
 * floor sits above both and no mode reaches it either.
 */
export type PermissionMode = ReviewMode

/**
 * The modes the flag and the picker offer. The SDK's `bypass` and `classify`
 * are not offered yet; this list keeps the five the CLI has always taken.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = REVIEW_MODES.filter(
	(mode) => mode !== 'bypass' && mode !== 'classify',
)

export { ACCEPT_EDITS_TOOLS, PLAN_MODE_REFUSAL } from '@namzu/sdk'

export const isPermissionMode: (value: unknown) => value is PermissionMode = isReviewMode

export function permissionModeLabel(mode: PermissionMode): string {
	switch (mode) {
		case 'prompt':
			return 'Ask before changes'
		case 'accept-edits':
			return 'Auto-approve edits'
		case 'auto':
			return 'Auto-approve tools'
		case 'strict':
			return 'Preapproved tools only'
		case 'plan':
			return 'Plan (read-only)'
		case 'bypass':
			return 'Bypass permissions'
		case 'classify':
			return 'Auto (classifier)'
	}
}

/**
 * The mode Shift+Tab moves to. The reference's cycle (`c4t`) runs default,
 * accept edits, plan, then bypass when the session may use it, then back to
 * default; `auto` is that bypass stop here and is reached only when
 * `bypassAvailable`. `auto` and `strict` go back to `prompt`.
 */
export function nextCycleMode(current: PermissionMode, bypassAvailable: boolean): PermissionMode {
	switch (current) {
		case 'prompt':
			return 'accept-edits'
		case 'accept-edits':
			return 'plan'
		case 'plan':
			return bypassAvailable ? 'auto' : 'prompt'
		case 'auto':
		case 'strict':
		case 'bypass':
		case 'classify':
			return 'prompt'
	}
}

/**
 * Whether Shift+Tab may land on `auto`: the session was launched in it
 * (`--dangerously-skip-permissions`, `--yolo`, `--permission-mode auto`),
 * or asked for it with `--allow-dangerously-skip-permissions`. Choosing
 * `auto` by name in `/permissions` grants it for the rest of the session.
 */
export function bypassAvailableAtLaunch(opts: {
	readonly launchMode: PermissionMode
	readonly allowDangerouslySkipPermissions?: boolean
}): boolean {
	return opts.launchMode === 'auto' || opts.allowDangerouslySkipPermissions === true
}

/** The behavior shown by both the permission selector and the session report. */
export function permissionModeDescription(mode: PermissionMode): string {
	switch (mode) {
		case 'prompt':
			return 'Ask before changes and shell commands.'
		case 'accept-edits':
			return 'Allow file edits; ask before shell commands and other changes.'
		case 'auto':
			return 'Allow tools without asking, subject to configured rules.'
		case 'strict':
			return 'Allow preapproved tools; refuse other calls without asking.'
		case 'plan':
			return 'Read-only: block changes until you leave plan mode.'
		case 'bypass':
			return 'Run everything except what always needs a person.'
		case 'classify':
			return 'A classifier model decides what you would otherwise be asked.'
	}
}

/**
 * The mode for a turn, from the flag, the bypass alias, and whether anyone is
 * there to answer.
 *
 * `--yolo` / `--dangerously-skip-permissions` map to `auto`. They were accepted
 * and documented as doing nothing, which was true and unsatisfying; now they
 * say the same thing the mode vocabulary says, and in the TUI they do what
 * their name has always implied. Neither reaches a `deny` rule or the
 * dangerous-pattern floor, so the name still overstates what it can do —
 * deliberately, because it should read as more dangerous than it is rather than
 * less.
 */
export function resolvePermissionMode(opts: {
	readonly flag?: string | null
	readonly skipPermissions?: boolean
	readonly interactive: boolean
}): { mode: PermissionMode } | { error: string } {
	if (opts.flag != null && opts.flag !== '') {
		if (!isPermissionMode(opts.flag)) {
			return {
				error: `--permission-mode must be one of: ${PERMISSION_MODES.join(', ')} (got "${opts.flag}")`,
			}
		}
		return { mode: opts.flag }
	}
	if (opts.skipPermissions) return { mode: 'auto' }
	// No terminal means nobody to ask, so `prompt` would silently become `auto`
	// anyway. Saying so here keeps the resolved mode honest in a log.
	return { mode: opts.interactive ? 'prompt' : 'auto' }
}
