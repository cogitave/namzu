import { describe, expect, it } from 'vitest'
import {
	asksForCredential,
	classifyHumanRequired,
	isBotBlockTitle,
	isCaptchaFrame,
	isCredentialField,
	isSignInAddress,
	signInNotice,
} from '../classifier.js'
import { FIXTURE_EXPECTATIONS } from './fixture-signals.js'

const address = { signInDetection: 'address' } as const

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
				classifyHumanRequired(
					{
						url: `https://shop.example.test/${name}`,
						title: expected.title,
						passwordFields: expected.passwordFields,
						oneTimeCodeFields: expected.oneTimeCodeFields,
						frameUrls: expected.frameUrls,
						status: expected.status ?? 200,
					},
					address,
				),
			).toBe(expected.reason)
		})
	}
})

describe('classifyHumanRequired', () => {
	it('does not turn credential component examples on a public page into a page-wide handoff', () => {
		for (const [passwordFields, oneTimeCodeFields] of [
			[1, 0],
			[0, 6],
			[1, 6],
		] as const) {
			expect(
				classifyHumanRequired({
					...quiet,
					url: 'https://www.boardui.com/components',
					status: 200,
					passwordFields,
					oneTimeCodeFields,
				}),
			).toBeUndefined()
		}
	})

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
		expect(classifyHumanRequired({ ...quiet, status: 401, oneTimeCodeFields: 1 })).toBe(
			'two-factor',
		)
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
			classifyHumanRequired(
				{
					...quiet,
					url: 'https://accounts.google.com/v3/signin',
				},
				address,
			),
		).toBe('sign-in')
		expect(classifyHumanRequired({ ...quiet, url: 'https://github.com/login' }, address)).toBe(
			'sign-in',
		)
		expect(classifyHumanRequired({ ...quiet, url: 'https://example.com/sso/start' }, address)).toBe(
			'sign-in',
		)
	})

	it('reads a second-factor address as two-factor, not sign-in', () => {
		expect(
			classifyHumanRequired(
				{
					...quiet,
					url: 'https://github.com/sessions/two-factor/app',
				},
				address,
			),
		).toBe('two-factor')
		expect(
			classifyHumanRequired(
				{
					...quiet,
					url: 'https://example.com/login',
					status: 200,
					oneTimeCodeFields: 1,
				},
				address,
			),
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
		expect(isSignInAddress(url, address)).toBe(expected)
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

describe('signInDetection: page', () => {
	const page = { signInDetection: 'page' } as const
	const demo = {
		...quiet,
		url: 'https://demo.example.test/login',
		title: 'Login Page',
		status: 200,
	}

	it('is the default: a /login path alone is not a sign-in, and the page is noted instead', () => {
		expect(classifyHumanRequired(demo)).toBeUndefined()
		expect(classifyHumanRequired({ ...demo, passwordFields: 1 })).toBeUndefined()
		expect(isSignInAddress(demo.url)).toBe(false)
		expect(signInNotice({ ...demo, passwordFields: 1 })).toContain('You cannot type one')
	})

	it('keeps the old answer when address is asked for: a /login path alone is a sign-in', () => {
		expect(classifyHumanRequired(demo, address)).toBe('sign-in')
		expect(classifyHumanRequired({ ...demo, passwordFields: 1 }, address)).toBe('sign-in')
		expect(isSignInAddress(demo.url, address)).toBe(true)
	})

	it('does not stop on a /login path, with or without a password field', () => {
		expect(classifyHumanRequired(demo, page)).toBeUndefined()
		expect(classifyHumanRequired({ ...demo, passwordFields: 1 }, page)).toBeUndefined()
		expect(
			classifyHumanRequired(
				{ ...demo, url: 'https://demo.example.test/2fa', oneTimeCodeFields: 1 },
				page,
			),
		).toBeUndefined()
		expect(isSignInAddress(demo.url, page)).toBe(false)
	})

	it("still stops on the listed hosts, the operator's own addresses and a bare 401 with a password field", () => {
		expect(
			classifyHumanRequired({ ...demo, url: 'https://accounts.google.com/v3/signin' }, page),
		).toBe('sign-in')
		expect(
			classifyHumanRequired(
				{ ...demo, url: 'https://sso.corp.test/start' },
				{ ...page, signInAddresses: ['sso.corp.test'] },
			),
		).toBe('sign-in')
		expect(
			classifyHumanRequired({ ...demo, url: 'https://github.com/sessions/two-factor' }, page),
		).toBe('two-factor')
		expect(classifyHumanRequired({ ...demo, status: 401, passwordFields: 1 }, page)).toBe('sign-in')
	})

	it('still stops on a CAPTCHA and an HTTP challenge', () => {
		expect(classifyHumanRequired({ ...demo, status: 401, wwwAuthenticate: 'Basic' }, page)).toBe(
			'http-auth',
		)
		expect(
			classifyHumanRequired({ ...demo, frameUrls: ['https://newassets.hcaptcha.com/x'] }, page),
		).toBe('captcha')
	})

	it('with a person present, asks the model to put the sign-in to them and wait, never naming a command', () => {
		const text = signInNotice(
			{ ...demo, passwordFields: 1 },
			page,
			'namzu browser login work https://demo.example.test/login',
			true,
		)
		expect(text).toContain('You cannot type one')
		expect(text).toContain('ask_user_question')
		expect(text).toContain('sign in in the browser window')
		expect(text).toContain('I signed in')
		expect(text).not.toContain('namzu browser login')
		// A page with no credential field, or one that already stopped the turn, still says nothing.
		expect(signInNotice(demo, page, undefined, true)).toBeUndefined()
		expect(signInNotice({ ...demo, passwordFields: 1 }, address, undefined, true)).toBeUndefined()
		// An unattended run is unchanged: it names the command.
		expect(
			signInNotice({ ...demo, passwordFields: 1 }, page, 'namzu browser login work x'),
		).toContain('namzu browser login work x')
	})

	it('gives a notice, naming the command, only for a page that shows a credential field', () => {
		const text = signInNotice(
			{ ...demo, passwordFields: 1 },
			page,
			'namzu browser login work https://demo.example.test/login',
		)
		expect(text).toContain('You cannot type one')
		expect(text).toContain('Do the steps that do not need the sign-in')
		expect(text).toContain('namzu browser login work')
		expect(signInNotice({ ...demo, oneTimeCodeFields: 1 }, page)).toContain('code')
		expect(signInNotice(demo, page)).toBeUndefined()
		// Address mode stops the turn instead, so it has nothing to add.
		expect(signInNotice({ ...demo, passwordFields: 1 }, address)).toBeUndefined()
		// A page that already stopped the turn is not noted twice.
		expect(
			signInNotice({ ...demo, url: 'https://accounts.google.com/x', passwordFields: 1 }, page),
		).toBeUndefined()
	})
})

describe('asksForCredential', () => {
	it.each([
		['Enter your password to continue', true],
		['Please type the one-time code we sent you', true],
		['Passcode:', true],
		['Your 2FA code?', true],
		['Name your new folder', false],
		['How many copies?', false],
	])('%s → %s', (message, expected) => {
		expect(asksForCredential(message)).toBe(expected)
	})
})
