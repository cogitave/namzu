import { describe, expect, it } from 'vitest'
import {
	classifyHumanRequired,
	isBotBlockTitle,
	isCaptchaFrame,
	isCredentialField,
	isSignInAddress,
} from '../classifier.js'
import { FIXTURE_EXPECTATIONS } from './fixture-signals.js'

const NEUTRAL = 'https://shop.example.test/account/overview'

const quiet = {
	url: NEUTRAL,
	title: 'Overview',
	passwordFields: 0,
	oneTimeCodeFields: 0,
	frameUrls: [] as string[],
}

describe('classifyHumanRequired over the fixture pages', () => {
	for (const [name, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
		it(`${name} → ${expected.reason ?? 'no person needed'}`, () => {
			expect(
				classifyHumanRequired({
					url: NEUTRAL,
					title: expected.title,
					passwordFields: expected.passwordFields,
					oneTimeCodeFields: expected.oneTimeCodeFields,
					frameUrls: expected.frameUrls,
					...(expected.status !== undefined ? { status: expected.status } : {}),
				}),
			).toBe(expected.reason)
		})
	}
})

describe('classifyHumanRequired', () => {
	it('requires the matching challenge header for an HTTP credential prompt', () => {
		expect(classifyHumanRequired({ ...quiet, status: 401 })).toBeUndefined()
		expect(classifyHumanRequired({ ...quiet, status: 407 })).toBeUndefined()
		expect(
			classifyHumanRequired({
				...quiet,
				status: 401,
				wwwAuthenticate: 'Basic realm="site"',
			}),
		).toBe('http-auth')
		expect(
			classifyHumanRequired({
				...quiet,
				status: 407,
				proxyAuthenticate: 'Basic realm="proxy"',
			}),
		).toBe('http-auth')
		expect(
			classifyHumanRequired({
				...quiet,
				status: 401,
				proxyAuthenticate: 'Basic realm="proxy"',
			}),
		).toBeUndefined()
		expect(
			classifyHumanRequired({
				...quiet,
				status: 407,
				wwwAuthenticate: 'Basic realm="site"',
			}),
		).toBeUndefined()
		expect(classifyHumanRequired({ ...quiet, status: 401, wwwAuthenticate: '   ' })).toBeUndefined()
		expect(classifyHumanRequired({ ...quiet, status: 407, proxyAuthenticate: '' })).toBeUndefined()
		expect(
			classifyHumanRequired({
				...quiet,
				status: 403,
				wwwAuthenticate: 'Basic realm="site"',
			}),
		).toBeUndefined()
	})

	it('keeps independently observed human handoffs on a bare HTTP denial', () => {
		expect(classifyHumanRequired({ ...quiet, status: 401, passwordFields: 1 })).toBe('sign-in')
		expect(
			classifyHumanRequired({
				...quiet,
				status: 407,
				title: 'Just a moment...',
			}),
		).toBe('bot-block')
		expect(
			classifyHumanRequired({
				...quiet,
				status: 401,
				frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=x&size=normal'],
			}),
		).toBe('captcha')
	})

	it('names a CAPTCHA before a sign-in on the same page', () => {
		expect(
			classifyHumanRequired({
				...quiet,
				passwordFields: 1,
				frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=x&size=normal'],
			}),
		).toBe('captcha')
	})

	it('reads a sign-in address even with no password box on the page', () => {
		expect(
			classifyHumanRequired({
				...quiet,
				url: 'https://accounts.google.com/v3/signin',
			}),
		).toBe('sign-in')
		expect(classifyHumanRequired({ ...quiet, url: 'https://github.com/login' })).toBe('sign-in')
		expect(classifyHumanRequired({ ...quiet, url: 'https://example.com/sso/start' })).toBe(
			'sign-in',
		)
	})

	it('reads a second-factor address as two-factor, not sign-in', () => {
		expect(
			classifyHumanRequired({
				...quiet,
				url: 'https://github.com/sessions/two-factor/app',
			}),
		).toBe('two-factor')
	})

	it('accepts extra sign-in addresses', () => {
		const url = 'https://intranet.example.com/portal/enter'
		expect(classifyHumanRequired({ ...quiet, url })).toBeUndefined()
		expect(
			classifyHumanRequired(
				{ ...quiet, url },
				{ signInAddresses: ['intranet.example.com/portal/enter'] },
			),
		).toBe('sign-in')
	})
})

describe('isSignInAddress', () => {
	it.each([
		['https://example.com/login', true],
		['https://example.com/login.php', true],
		['https://example.com/users/sign_in', true],
		['https://example.com/auth/callback', true],
		['https://example.com/oauth/authorize?client_id=1', true],
		['https://login.microsoftonline.com/common/oauth2/v2.0/authorize', true],
		['https://example.com/author/jane', false],
		['https://example.com/blog/how-to-login-faster', false],
		['https://example.com/', false],
		['https://github.com/loginator', false],
		['https://notgithub.com/login-help', false],
		['file:///login', false],
	])('%s → %s', (url, expected) => {
		expect(isSignInAddress(url)).toBe(expected)
	})
})

describe('isCaptchaFrame', () => {
	it.each([
		['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x', true],
		['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox', true],
		['https://client-api.arkoselabs.com/fc/gc/?token=1', true],
		['https://www.google.com/recaptcha/api2/anchor?k=1&size=normal', true],
		['https://www.recaptcha.net/recaptcha/api2/bframe?k=1', true],
		['https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible', false],
		['https://www.google.com/maps/embed', false],
		['https://challenges.cloudflare.com.evil.example/x', false],
		['about:blank', false],
	])('%s → %s', (url, expected) => {
		expect(isCaptchaFrame(url)).toBe(expected)
	})
})

describe('isBotBlockTitle', () => {
	it.each([
		['Just a moment...', true],
		['Attention Required! | Cloudflare', true],
		['Access denied', true],
		['Pardon Our Interruption', true],
		['  Just   a moment  ', true],
		['Just a moment: the history of waiting', false],
		['Access denied errors in S3, explained', false],
		['Pricing', false],
	])('%s → %s', (title, expected) => {
		expect(isBotBlockTitle(title)).toBe(expected)
	})
})

describe('isCredentialField', () => {
	const field = {
		tag: 'input',
		type: 'text',
		autocomplete: '',
		name: '',
		id: '',
		label: '',
	}

	it('refuses password inputs and credential autocomplete', () => {
		expect(isCredentialField({ ...field, type: 'password' })).toBe(true)
		expect(isCredentialField({ ...field, type: 'PASSWORD' })).toBe(true)
		expect(isCredentialField({ ...field, autocomplete: 'current-password' })).toBe(true)
		expect(isCredentialField({ ...field, autocomplete: 'section-a new-password' })).toBe(true)
		expect(isCredentialField({ ...field, autocomplete: 'one-time-code' })).toBe(true)
	})

	it('refuses one-time-code fields by name, id or label', () => {
		expect(isCredentialField({ ...field, name: 'otp' })).toBe(true)
		expect(isCredentialField({ ...field, id: 'totp_code' })).toBe(true)
		expect(isCredentialField({ ...field, label: 'Verification code' })).toBe(true)
		expect(isCredentialField({ ...field, name: 'app_otp' })).toBe(true)
	})

	it('allows ordinary fields', () => {
		expect(isCredentialField({ ...field, name: 'email', autocomplete: 'username' })).toBe(false)
		expect(isCredentialField({ ...field, name: 'postcode' })).toBe(false)
		expect(isCredentialField({ ...field, name: 'hotpot' })).toBe(false)
		expect(isCredentialField({ ...field, tag: 'button', type: '', name: 'otp' })).toBe(false)
	})
})
