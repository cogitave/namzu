import type { BrowserHumanRequiredReason } from '@namzu/sdk'

/**
 * What the host read off a page to decide whether it needs a person. Every
 * field is gathered by the host from the browser, never from the model.
 */
export interface BrowserPageSignals {
	/** The main frame's address. */
	readonly url: string
	/** The document title. */
	readonly title: string
	/** HTTP status of the main document's last response, when known. */
	readonly status?: number
	/** Visible password fields (`type=password`, `autocomplete=current-password`). */
	readonly passwordFields: number
	/** Visible one-time-code fields (`autocomplete=one-time-code`, or named like one). */
	readonly oneTimeCodeFields: number
	/** Addresses of visible child frames, the only place a CAPTCHA widget is drawn. */
	readonly frameUrls: readonly string[]
}

export interface BrowserHumanClassifierOptions {
	/**
	 * More sign-in addresses, as `host` (`sso.example.com`) or `host/path`
	 * prefix (`example.com/account/login`). Added to {@link SIGN_IN_ADDRESSES}.
	 */
	readonly signInAddresses?: readonly string[]
}

/**
 * Hosts and host/path prefixes that are a sign-in wherever they appear. The
 * path forms below catch the rest (`/login`, `/signin`, `/sso`, …).
 */
export const SIGN_IN_ADDRESSES: readonly string[] = [
	'accounts.google.com',
	'login.microsoftonline.com',
	'login.live.com',
	'appleid.apple.com',
	'github.com/login',
	'github.com/session',
	'gitlab.com/users/sign_in',
]

/** Second-factor addresses: a sign-in that is already half done. */
const TWO_FACTOR_ADDRESSES: readonly string[] = ['github.com/sessions/two-factor']

/** A path segment that is a sign-in page. `/author` is not `/auth`. */
const SIGN_IN_PATH =
	/(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|auth|sso|oauth2?\/authorize|authorize)(?:\/|\.[a-z]+$|$)/i

const TWO_FACTOR_PATH = /(?:^|\/)(?:two-factor|2fa|mfa|otp|totp)(?:\/|\.[a-z]+$|$)/i

/**
 * Hosts that draw CAPTCHA and bot-check widgets in a frame. A frame served
 * from one of these (or a subdomain) is a challenge.
 */
export const CAPTCHA_FRAME_HOSTS: readonly string[] = [
	'challenges.cloudflare.com',
	'hcaptcha.com',
	'newassets.hcaptcha.com',
	'arkoselabs.com',
	'funcaptcha.com',
	'recaptcha.net',
]

/** reCAPTCHA is served from google.com under this path. */
const RECAPTCHA_PATH = /^\/recaptcha\//

/**
 * Titles of interstitial bot checks and blocks. Anchored and short on
 * purpose: a page ABOUT access control must not match.
 */
const BOT_BLOCK_TITLES: readonly RegExp[] = [
	/^just a moment\.{0,3}$/i,
	/^attention required!?(?: \| cloudflare)?$/i,
	/^access denied$/i,
	/^are you a robot\??$/i,
	/^verify(?:ing)? (?:you are|that you are) (?:a )?human\.{0,3}$/i,
	/^(?:security|human) (?:check|verification)$/i,
	/^checking (?:your browser|if the site connection is secure)[\s\S]{0,40}$/i,
	/^pardon our interruption\.{0,3}$/i,
	/^please verify you are a human$/i,
	/^one more step$/i,
	/^robot check$/i,
	/^ddos-guard$/i,
]

function hostMatches(host: string, entry: string): boolean {
	return host === entry || host.endsWith(`.${entry}`)
}

function addressMatches(url: URL, entry: string): boolean {
	const slash = entry.indexOf('/')
	const host = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase()
	const path = slash === -1 ? '' : entry.slice(slash)
	if (url.hostname !== host) return false
	if (path === '') return true
	return url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`)
}

function parse(raw: string): URL | undefined {
	try {
		return new URL(raw)
	} catch {
		return undefined
	}
}

/** Is `frameUrl` a CAPTCHA or bot-check widget? Invisible-badge frames are not. */
export function isCaptchaFrame(frameUrl: string): boolean {
	const url = parse(frameUrl)
	if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false
	if (url.searchParams.get('size') === 'invisible') return false
	const host = url.hostname
	if (CAPTCHA_FRAME_HOSTS.some((entry) => hostMatches(host, entry))) return true
	return (host === 'www.google.com' || host === 'google.com') && RECAPTCHA_PATH.test(url.pathname)
}

/** Is `title` the title of a bot check or block page? */
export function isBotBlockTitle(title: string): boolean {
	const flat = title.replace(/\s+/g, ' ').trim()
	return BOT_BLOCK_TITLES.some((pattern) => pattern.test(flat))
}

/** Is `rawUrl` a sign-in address, by host list or by path? */
export function isSignInAddress(
	rawUrl: string,
	options: BrowserHumanClassifierOptions = {},
): boolean {
	const url = parse(rawUrl)
	if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false
	const entries = [...SIGN_IN_ADDRESSES, ...(options.signInAddresses ?? [])]
	if (entries.some((entry) => addressMatches(url, entry))) return true
	return SIGN_IN_PATH.test(url.pathname)
}

function isTwoFactorAddress(rawUrl: string): boolean {
	const url = parse(rawUrl)
	if (!url) return false
	if (TWO_FACTOR_ADDRESSES.some((entry) => addressMatches(url, entry))) return true
	return TWO_FACTOR_PATH.test(url.pathname)
}

/**
 * Does the page need a person, and why? `undefined` when it does not.
 *
 * Order matters only for the reason reported: an HTTP credential prompt,
 * then a CAPTCHA, a bot wall, a second factor, and last a sign-in. All of it
 * is read by the host; nothing the model says reaches this function.
 *
 * It errs toward stopping. A page with a visible password box is treated as
 * a sign-in even when it is a settings page, because the cost of a false stop
 * is a question to the operator and the cost of a false pass is an agent
 * typing near a credential.
 */
export function classifyHumanRequired(
	signals: BrowserPageSignals,
	options: BrowserHumanClassifierOptions = {},
): BrowserHumanRequiredReason | undefined {
	if (signals.status === 401 || signals.status === 407) return 'http-auth'
	if (signals.frameUrls.some(isCaptchaFrame)) return 'captcha'
	if (isBotBlockTitle(signals.title)) return 'bot-block'
	if (signals.oneTimeCodeFields > 0 || isTwoFactorAddress(signals.url)) return 'two-factor'
	if (signals.passwordFields > 0 || isSignInAddress(signals.url, options)) return 'sign-in'
	return undefined
}

/** What the host read about one field before typing into it. */
export interface BrowserFieldFacts {
	readonly tag: string
	readonly type: string
	readonly autocomplete: string
	readonly name: string
	readonly id: string
	readonly label: string
}

const ONE_TIME_CODE_NAME =
	/(?:^|[^a-z])(?:otp|totp|2fa|mfa|one[-_ ]?time[-_ ]?(?:code|password)|verification[-_ ]?code|passcode|security[-_ ]?code|auth(?:entication)?[-_ ]?code)(?:[^a-z]|$)/i

/**
 * Is this field a password or a one-time code? Typing into one is always
 * refused, whatever the gate allowed: the agent never handles a credential.
 */
export function isCredentialField(field: BrowserFieldFacts): boolean {
	if (field.tag !== 'input' && field.tag !== 'textarea') return false
	if (field.type.toLowerCase() === 'password') return true
	const autocomplete = field.autocomplete.toLowerCase()
	if (/\b(?:current-password|new-password|one-time-code)\b/.test(autocomplete)) return true
	return [field.name, field.id, field.label].some((value) => ONE_TIME_CODE_NAME.test(value))
}
