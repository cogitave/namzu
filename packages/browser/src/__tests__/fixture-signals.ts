import type { BrowserHumanRequiredReason } from '@namzu/sdk'

/**
 * What the host should read off each fixture page, and what the classifier
 * should conclude. The unit test runs the classifier over these signals; the
 * E2E test loads the same HTML in a real browser and checks that the host
 * reads exactly these signals off it, so the two halves meet in one table.
 */
export interface FixtureExpectation {
	readonly title: string
	readonly passwordFields: number
	readonly oneTimeCodeFields: number
	/** Frame addresses the page draws, as the host would list them. */
	readonly frameUrls: readonly string[]
	readonly status?: number
	readonly reason: BrowserHumanRequiredReason | undefined
	/** Loaded by the E2E suite (a fixture that reaches the internet is not). */
	readonly e2e: boolean
}

export const FIXTURE_EXPECTATIONS: Readonly<Record<string, FixtureExpectation>> = {
	'index.html': {
		title: 'Fixture index',
		passwordFields: 0,
		oneTimeCodeFields: 0,
		frameUrls: [],
		reason: undefined,
		e2e: true,
	},
	'form.html': {
		title: 'Order form',
		passwordFields: 0,
		oneTimeCodeFields: 0,
		frameUrls: [],
		reason: undefined,
		e2e: true,
	},
	'login.html': {
		title: 'Your account',
		passwordFields: 1,
		oneTimeCodeFields: 0,
		frameUrls: [],
		reason: 'sign-in',
		e2e: true,
	},
	'otp.html': {
		title: 'Check your phone',
		passwordFields: 0,
		oneTimeCodeFields: 1,
		frameUrls: [],
		reason: 'two-factor',
		e2e: true,
	},
	'challenge.html': {
		title: 'Just a moment...',
		passwordFields: 0,
		oneTimeCodeFields: 0,
		frameUrls: [],
		reason: 'bot-block',
		e2e: true,
	},
	'captcha.html': {
		title: 'Sign up',
		passwordFields: 0,
		oneTimeCodeFields: 0,
		frameUrls: [
			'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal',
		],
		reason: 'captcha',
		e2e: false,
	},
	'injection.html': {
		title: 'Article',
		passwordFields: 0,
		oneTimeCodeFields: 0,
		frameUrls: [],
		reason: undefined,
		e2e: true,
	},
}
