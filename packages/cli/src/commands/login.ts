/**
 * `namzu login` / `namzu logout` — sign in without a running TUI.
 *
 * ## Why this exists, having been argued against
 *
 * When the sign-in shipped, a standalone command was declined: the TUI already
 * offered `/login`, and a second entry point is a second thing to document.
 * That reasoning had a hole, and an operator found it on the first day.
 *
 * `/login` is a slash command, slash commands are typed into the composer, and
 * **the composer does not exist during the provider picker.** So the one
 * operator who most needs to sign in — the one with no credential at all, whom
 * namzu routes straight to the picker — is the one operator who cannot reach
 * the command. There was no other route: nothing else writes the credential
 * store. A capability with no reachable entry point is not a capability, and
 * "it is reachable from the screen you cannot get to" is the shape this
 * repository has spent its time removing.
 *
 * The picker now offers it too. This command remains, because it is the
 * answer for the case that has no screen at all: a container, a provisioning
 * script, a machine being set up over SSH before anyone opens a session.
 *
 * ## Finishing from a shell that cannot take a paste
 *
 * The verifier is what makes the exchange safe, and a run whose standard input
 * closes at once (a chat tool's shell) would take it to the grave before the
 * browser shows its code. That run now keeps the pending sign-in in an
 * owner-only file for ten minutes (under `login-pending/`, never printed) and
 * exits 0 as "waiting"; running the same login again with `--code <code>`
 * finishes it. A terminal that can paste keeps the interactive path as is.
 *
 * The registered browser callback shows a code rather than returning to a
 * local listener. Standard input takes that code or the finished address;
 * the timeout bounds an unattended terminal.
 */

import { createInterface } from 'node:readline'

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type ApiKeyLogoutTarget,
	type LoginOutcome,
	PROVIDER_REGISTRY,
	type ProviderId,
	type SubscriptionProviderId,
	apiKeyLogoutTarget,
	apiKeysPath,
	beginCodexDeviceLogin,
	beginSubscriptionLogin,
	clearAllStoredApiKeys,
	clearAllStoredCredentials,
	clearStoredApiKey,
	clearStoredCodexCredential,
	clearStoredGeminiApiKey as clearStoredGoogleApiKey,
	clearStoredSubscriptionCredential,
	completePendingSubscriptionLogin,
	credentialsPath,
	googleApiKeyPath,
	isApiKeyLogoutTarget,
	listStoredApiKeyProviders,
	locateStoredCodexCredential,
	locateStoredSubscriptionCredential,
	readStoredApiKey,
	readStoredGeminiApiKey as readStoredGoogleApiKey,
} from '../integrations/providers/index.js'
import {
	describeAllCredentialsLogout,
	describeApiKeyLogout,
	describeCodexDeviceLoginStart,
	describeLoginOutcome,
	describeLoginStart,
	describeProviderLogout,
} from '../tui/login-prompt.js'
import { openInBrowser } from '../tui/open-browser.js'
import type { CommandDef } from './types.js'

const LOGIN_HELP = [
	'Usage: namzu login <claude|codex> [options]',
	'',
	'Sign in with a provider subscription and store the credential on this machine.',
	'',
	'Options:',
	'  --no-browser        Do not try to launch a browser; just print the address.',
	'  --code <value>      Finish a Claude sign-in that is waiting for its code: the code,',
	'                      code#state, or the finished address (within 10 minutes).',
	'  --timeout <seconds> Give up waiting after this long (default: 300).',
	'  -h, --help          Show this help.',
	'',
	'Claude sign-in opens a registered browser flow; paste the returned code or',
	'finished address into this terminal. Where the shell cannot take a paste',
	'(standard input closed), the sign-in is kept for 10 minutes, the address is',
	'printed, and you finish with: namzu login claude --code <code>.',
	'Codex sign-in prints a device code and polls while you approve it in the browser.',
	'',
	'Exit status: 0 signed in, or waiting for the code (the sign-in is kept; run',
	'--code to finish); 1 the sign-in failed; 2 the command was used wrongly.',
	'',
	'The credential is written to ~/.namzu/credentials.json, readable only by your',
	"account. Run 'namzu logout' to remove it.",
	'',
	'Inside WSL, a Claude or Codex sign-in made in Namzu Desktop on Windows is used in',
	'place when this terminal has none of its own; signing in here keeps a separate one.',
].join('\n')

const DEFAULT_TIMEOUT_SECONDS = 300

const DESKTOP_SHARED_LOGOUT_NOTE =
	'A subscription this terminal reads from Namzu Desktop on Windows was not removed: it belongs to Desktop, so signing out here would sign Desktop out too. Sign out in Desktop to remove it, or set shareDesktopSignIn to false (or NAMZU_SHARE_DESKTOP_SIGNIN=0) so this terminal stops using it.'

const LOGOUT_HELP = [
	'Usage: namzu logout [claude|codex|gemini|<provider>|all]',
	'',
	'Remove a credential created by Namzu on this machine.',
	'With no target, all Namzu-owned credentials are removed.',
	'Credentials borrowed from another tool or supplied through the environment are untouched.',
].join('\n')

export type LogoutTarget = SubscriptionProviderId | 'google' | 'all' | ApiKeyLogoutTarget

export function parseLogoutTarget(argv: readonly string[]): LogoutTarget | null {
	if (argv.length === 0) return 'all'
	if (argv.length !== 1) return null
	const value = argv[0]?.toLowerCase()
	if (value === 'claude' || value === 'anthropic') return 'anthropic'
	if (value === 'codex' || value === 'chatgpt') return 'codex'
	if (value === 'gemini' || value === 'google') return 'google'
	if (value === 'all') return 'all'
	return value ? apiKeyLogoutTarget(value) : null
}

interface LoginFlags {
	readonly provider?: SubscriptionProviderId
	readonly noBrowser: boolean
	readonly timeoutMs: number
	readonly code?: string
	readonly unknown: readonly string[]
}

export function parseLoginFlags(argv: readonly string[]): LoginFlags {
	let noBrowser = false
	let provider: SubscriptionProviderId | undefined
	let timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1_000
	let code: string | undefined
	const unknown: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--no-browser') {
			noBrowser = true
			continue
		}
		if (arg === '--code' || arg?.startsWith('--code=')) {
			const value = arg === '--code' ? argv[++i] : arg.slice('--code='.length)
			// The value is never echoed back: it is a credential.
			if (value === undefined || value.trim().length === 0 || code !== undefined) {
				unknown.push('--code')
				continue
			}
			code = value
			continue
		}
		if (arg === '--timeout') {
			const value = argv[++i]
			const seconds = Number(value)
			// Refused rather than defaulted. A caller who wrote `--timeout 5m`
			// meant something specific, and silently waiting five minutes
			// because `NaN` fell through to the default is the reading that
			// makes a flag look honoured when it was discarded.
			if (!Number.isFinite(seconds) || seconds <= 0) {
				unknown.push(`--timeout ${value ?? ''}`.trim())
				continue
			}
			timeoutMs = seconds * 1_000
			continue
		}
		if (arg === 'claude' || arg === 'anthropic') {
			if (provider) unknown.push(arg)
			else provider = 'anthropic'
			continue
		}
		if (arg === 'codex' || arg === 'chatgpt') {
			if (provider) unknown.push(arg)
			else provider = 'codex'
			continue
		}
		if (arg !== undefined) unknown.push(arg)
	}
	return { provider, noBrowser, timeoutMs, code, unknown }
}

/**
 * Resolve with the first NON-BLANK line standard input offers, or never.
 *
 * Two deliberate choices, both found by running this rather than by reading it.
 *
 * **Blank lines are ignored, not answered.** `once('line')` took a bare Enter
 * — the keystroke a person makes while waiting, and the one a piped empty
 * stdin delivers immediately — and spent the sign-in on it: the empty string
 * went to `completeWithPastedCode`, came back "that does not contain an
 * authorization code", and the attempt was over before the browser had loaded
 * the page.
 *
 * **A closed or absent stream resolves as absent, not as a blank code.** A
 * pending promise with only an unref'd timeout does not keep Node alive, so
 * `< /dev/null` otherwise exits zero before printing an outcome. The caller
 * turns absence into an explicit failed login.
 */

export function firstStdinLine(
	signal: AbortSignal,
	input: NodeJS.ReadableStream = process.stdin,
): Promise<string | null> {
	if (!input.readable) return Promise.resolve(null)
	return new Promise((resolve) => {
		const rl = createInterface({ input })
		let settled = false
		const finish = (value: string | null) => {
			if (settled) return
			settled = true
			signal.removeEventListener('abort', onAbort)
			resolve(value)
		}
		const onAbort = () => {
			finish(null)
			rl.close()
		}
		signal.addEventListener('abort', onAbort, { once: true })
		rl.on('line', (line) => {
			if (line.trim().length === 0) return
			finish(line)
			rl.close()
		})
		rl.once('close', () => finish(null))
	})
}

export const loginCommand: CommandDef = {
	name: 'login',
	description: 'Sign in with a provider subscription and store the credential.',
	passThrough: true,
	help: LOGIN_HELP,
	handler: async ({ ctx, rawArgs }) => {
		const flags = parseLoginFlags(rawArgs)
		if (flags.unknown.length > 0) {
			ctx.formatter.print({
				text: `Unrecognised argument(s): ${flags.unknown.join(', ')}\n\n${LOGIN_HELP}`,
			})
			return EXIT_USAGE
		}
		if (!flags.provider) {
			ctx.formatter.print({
				text: `Choose which subscription Namzu should own:\n  namzu login claude\n  namzu login codex\n\nAPI keys remain optional alternatives.\n\n${LOGIN_HELP}`,
			})
			return EXIT_USAGE
		}

		if (flags.code !== undefined && flags.provider !== 'anthropic') {
			ctx.formatter.print({
				text: `--code finishes a Claude sign-in; the Codex sign-in needs no code.\n\n${LOGIN_HELP}`,
			})
			return EXIT_USAGE
		}

		if (flags.provider === 'codex') {
			let login: Awaited<ReturnType<typeof beginCodexDeviceLogin>>
			try {
				login = await beginCodexDeviceLogin()
			} catch (error) {
				ctx.formatter.print({
					text: `Could not start Codex sign-in: ${error instanceof Error ? error.message : String(error)}`,
				})
				return EXIT_FAIL
			}
			ctx.formatter.print({
				text: describeCodexDeviceLoginStart({
					url: login.url,
					userCode: login.userCode,
					browserOpened: flags.noBrowser ? false : openInBrowser(login.url),
				}),
			})
			const timeout = new Promise<LoginOutcome>((resolve) =>
				setTimeout(
					() =>
						resolve({
							ok: false,
							reason: 'Timed out waiting for Codex sign-in. Nothing was stored.',
						}),
					flags.timeoutMs,
				).unref(),
			)
			const outcome = await Promise.race([login.waitForCompletion(), timeout])
			login.cancel()
			ctx.formatter.print({
				text: describeLoginOutcome(outcome, {
					retry: 'namzu login codex',
					remove: 'namzu logout',
				}),
			})
			return outcome.ok ? EXIT_OK : EXIT_FAIL
		}

		return runBrowserCodeLogin({
			print: (text) => ctx.formatter.print({ text }),
			flags,
			input: process.stdin,
			interactive: process.stdin.isTTY === true,
		})
	},
}

export interface BrowserCodeLoginDeps {
	readonly print: (text: string) => void
	readonly flags: LoginFlags
	readonly input: NodeJS.ReadableStream
	/** A terminal that can paste: the interactive path, unchanged. */
	readonly interactive: boolean
	readonly home?: string
	readonly fetch?: typeof fetch
	readonly openBrowser?: (url: string) => boolean
}

const WAITING_LINE = 'Finish with `namzu login claude --code <code>` within 10 minutes.'

export async function runBrowserCodeLogin(deps: BrowserCodeLoginDeps): Promise<number> {
	const { print, flags } = deps
	const options = { home: deps.home, fetch: deps.fetch }
	const retry = { retry: 'namzu login claude', remove: 'namzu logout' }

	if (flags.code !== undefined) {
		const outcome = await completePendingSubscriptionLogin(flags.code, options)
		print(describeLoginOutcome(outcome, retry))
		return outcome.ok ? EXIT_OK : EXIT_FAIL
	}

	let login: Awaited<ReturnType<typeof beginSubscriptionLogin>>
	try {
		login = await beginSubscriptionLogin(options)
	} catch (err) {
		print(`Could not start a sign-in: ${err instanceof Error ? err.message : String(err)}`)
		return EXIT_FAIL
	}

	const open = deps.openBrowser ?? openInBrowser
	print(
		describeLoginStart({
			url: login.url,
			browserOpened: flags.noBrowser ? false : open(login.url),
			completionHint: 'paste it here and press enter',
		}),
	)

	const stop = new AbortController()
	const timeout = new Promise<LoginOutcome | 'closed'>((resolve) =>
		setTimeout(
			() =>
				resolve({
					ok: false,
					reason: 'Timed out waiting for the sign-in to finish. Nothing was stored.',
				}),
			flags.timeoutMs,
		).unref(),
	)
	const pasted = firstStdinLine(stop.signal, deps.input).then(
		(line): Promise<LoginOutcome> | LoginOutcome | 'closed' =>
			line === null
				? deps.interactive
					? {
							ok: false,
							reason:
								'Standard input closed before an authorization code was pasted. Nothing was stored.',
						}
					: 'closed'
				: login.completeWithPastedCode(line),
	)
	const outcome = await Promise.race([pasted, timeout])
	stop.abort()
	if (outcome === 'closed') {
		// No paste can reach this process, so keep the attempt for `--code`
		// instead of letting the verifier die with it.
		try {
			if (!login.savePending) throw new Error('this sign-in cannot be kept')
			login.savePending()
		} catch (err) {
			login.cancel()
			print(
				`Could not keep the sign-in for a later code: ${err instanceof Error ? err.message : String(err)}\n\nRun namzu login claude in a terminal that can take a paste.`,
			)
			return EXIT_FAIL
		}
		print(WAITING_LINE)
		return EXIT_OK
	}
	login.cancel()
	print(describeLoginOutcome(outcome, retry))
	return outcome.ok ? EXIT_OK : EXIT_FAIL
}

export const logoutCommand: CommandDef = {
	name: 'logout',
	description: 'Remove a credential namzu stored on this machine.',
	passThrough: true,
	help: LOGOUT_HELP,
	handler: async ({ ctx, rawArgs }) => {
		const target = parseLogoutTarget(rawArgs)
		if (!target) {
			ctx.formatter.print({ text: LOGOUT_HELP })
			return EXIT_USAGE
		}
		if (isApiKeyLogoutTarget(target)) {
			const id = target.slice('key:'.length) as ProviderId
			const had = readStoredApiKey(id) !== null
			try {
				clearStoredApiKey(id)
			} catch (err) {
				ctx.formatter.print({
					text: `Could not remove ${apiKeysPath()}: ${err instanceof Error ? err.message : String(err)}`,
				})
				return EXIT_FAIL
			}
			ctx.formatter.print({
				text: describeApiKeyLogout(PROVIDER_REGISTRY[id].label, apiKeysPath(), had),
			})
			return EXIT_OK
		}
		const path = target === 'google' ? googleApiKeyPath() : credentialsPath()
		// A sign-in shared from Namzu Desktop on Windows is Desktop's, not this terminal's:
		// signing out here removes only what this terminal owns and leaves Desktop's alone.
		const subscriptionAt = locateStoredSubscriptionCredential()
		const codexAt = locateStoredCodexCredential()
		const hadSubscription = subscriptionAt !== null && subscriptionAt.shared === null
		const hadCodex = codexAt !== null && codexAt.shared === null
		const sharedFromDesktop =
			(subscriptionAt?.shared && (target === 'anthropic' || target === 'all')) ||
			(codexAt?.shared && (target === 'codex' || target === 'all'))
		const desktopNote = sharedFromDesktop ? `\n\n${DESKTOP_SHARED_LOGOUT_NOTE}` : ''
		const hadGoogleKey = readStoredGoogleApiKey() !== null
		if (target === 'all') {
			const failures: string[] = []
			const hadKeys = listStoredApiKeyProviders().length > 0
			try {
				clearAllStoredApiKeys()
			} catch (error) {
				failures.push(`${apiKeysPath()}: ${error instanceof Error ? error.message : String(error)}`)
			}
			try {
				clearAllStoredCredentials()
			} catch (error) {
				failures.push(
					`${credentialsPath()}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			try {
				clearStoredGoogleApiKey()
			} catch (error) {
				failures.push(
					`${googleApiKeyPath()}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			ctx.formatter.print({
				text:
					failures.length > 0
						? `Some stored credentials could not be removed: ${failures.join('; ')}. Check both stores before retrying.`
						: `${describeAllCredentialsLogout(
								path,
								googleApiKeyPath(),
								hadSubscription || hadCodex || hadGoogleKey || hadKeys,
								apiKeysPath(),
							)}${desktopNote}`,
			})
			return failures.length > 0 ? EXIT_FAIL : EXIT_OK
		}
		try {
			if (target === 'anthropic') clearStoredSubscriptionCredential()
			else if (target === 'codex') clearStoredCodexCredential()
			else clearStoredGoogleApiKey()
		} catch (err) {
			ctx.formatter.print({
				text: `Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
			})
			return EXIT_FAIL
		}
		ctx.formatter.print({
			text: `${describeProviderLogout(
				path,
				target,
				target === 'anthropic' ? hadSubscription : target === 'codex' ? hadCodex : hadGoogleKey,
			)}${desktopNote}`,
		})
		return EXIT_OK
	},
}
