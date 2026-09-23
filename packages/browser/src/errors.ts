import type {
	BrowserActionName,
	BrowserHumanRequired,
	BrowserHumanRequiredReason,
	BrowserOriginMismatch,
	BrowserOutcomeUnknown,
	BrowserSiteDenied,
	BrowserStaleRef,
} from '@namzu/sdk'

/**
 * The browser cannot run here: the engine is not installed, there is no
 * display for a visible window, the engine this environment needs is not in
 * this build. `reason` is a sentence for a person and ends with what to do.
 */
export class BrowserUnavailableError extends Error {
	override readonly name = 'BrowserUnavailableError'
	readonly code = 'browser_unavailable' as const

	constructor(readonly reason: string) {
		super(reason)
	}
}

/**
 * Another browser holds the profile. A local profile directory can be opened
 * by one browser process at a time; `holders` names the processes that hold
 * it, as `<pid>-<session>`.
 */
export class ProfileBusyError extends Error {
	override readonly name = 'ProfileBusyError'
	readonly code = 'browser_profile_busy' as const

	constructor(
		readonly profile: string,
		readonly holders: readonly string[],
	) {
		super(
			holders.length > 0
				? `The browser profile "${profile}" is in use by another namzu process (${holders.join(', ')}). Close that session, or use another profile.`
				: `The browser profile "${profile}" is in use by another browser. Close it, or use another profile.`,
		)
	}
}

// ---------------------------------------------------------------------------
// The SDK's structural refusals, as classes. The tools recognise them by
// shape (`browserHostErrorOf`), so these only need to carry the fields.
// ---------------------------------------------------------------------------

export class BrowserOriginMismatchError extends Error implements BrowserOriginMismatch {
	override readonly name = 'BrowserOriginMismatchError'
	readonly code = 'browser_origin_mismatch' as const

	constructor(
		readonly expected: string,
		readonly actual: string,
	) {
		super(`The page is at ${actual || 'an unknown origin'}, not ${expected}. Nothing was done.`)
	}
}

export class BrowserStaleRefError extends Error implements BrowserStaleRef {
	override readonly name = 'BrowserStaleRefError'
	readonly code = 'browser_stale_ref' as const

	constructor(readonly ref: string) {
		super(`Element ${ref} is not on the page any more. Nothing was done.`)
	}
}

export class BrowserHumanRequiredError extends Error implements BrowserHumanRequired {
	override readonly name = 'BrowserHumanRequiredError'
	readonly code = 'browser_human_required' as const
	readonly profile?: string
	readonly loginCommand?: string

	constructor(
		readonly reason: BrowserHumanRequiredReason,
		readonly origin: string,
		options: { profile?: string; loginCommand?: string } = {},
	) {
		super(`${origin || 'The page'} needs a person (${reason}).`)
		if (options.profile !== undefined) this.profile = options.profile
		if (options.loginCommand !== undefined) this.loginCommand = options.loginCommand
	}
}

export class BrowserSiteDeniedError extends Error implements BrowserSiteDenied {
	override readonly name = 'BrowserSiteDeniedError'
	readonly code = 'browser_site_denied' as const

	constructor(
		readonly origin: string,
		detail?: string,
	) {
		super(detail ?? `${origin || 'This site'} is not allowed by the site rules.`)
	}
}

export class BrowserOutcomeUnknownError extends Error implements BrowserOutcomeUnknown {
	override readonly name = 'BrowserOutcomeUnknownError'
	readonly code = 'browser_outcome_unknown' as const
	readonly outcome = 'unknown' as const
	readonly retrySafety = 'unsafe' as const

	constructor(
		readonly action: BrowserActionName,
		cause: unknown,
	) {
		super(
			`browser_act "${action}" started and did not finish cleanly (${firstLine(cause)}). The page may already have changed; take a snapshot before deciding what to do, and do not repeat the action blindly.`,
		)
	}
}

function firstLine(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause)
	const line = text.split('\n')[0] ?? ''
	return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
