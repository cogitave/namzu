/**
 * How a run resolves the calls no rule decided.
 *
 * The `[permissions]` table says what a tool may do. This says what happens to
 * everything it did not cover. The two axes are separate on purpose: a rule is
 * a durable statement an operator reviewed, and a mode is a property of ONE
 * invocation — the difference between "we never force-push" and "this run is
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
export type PermissionMode =
	/** Ask a human. The default when a terminal is attached. */
	| 'prompt'
	/**
	 * Approve it. The default with no terminal, and what every headless run has
	 * always done — named here rather than left implicit.
	 */
	| 'auto'
	/**
	 * Refuse it. Nothing runs unless a rule allowed it by name or pattern.
	 *
	 * The mode that did not exist before: an unattended run could previously
	 * only be `auto`, so a CI job either trusted the agent with everything or
	 * could not use it. This makes the allowlist the whole permission surface,
	 * which is the only form an unattended run can actually be reasoned about.
	 */
	| 'strict'

export const PERMISSION_MODES: readonly PermissionMode[] = ['prompt', 'auto', 'strict']

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * The mode for a run, from the flag, the bypass alias, and whether anyone is
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
