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
 * ## Finishing without a browser on this machine
 *
 * The verifier lives in this process and nowhere else — that is what makes the
 * exchange safe — so a second invocation cannot finish what a first one
 * started. There is no `--code` flag for that reason: it would look like it
 * should work and could not.
 *
 * The registered browser callback shows a code rather than returning to a
 * local listener. Standard input takes that code or the finished address;
 * the timeout bounds an unattended terminal.
 */

import { createInterface } from 'node:readline'

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type LoginOutcome,
	type SubscriptionProviderId,
	beginCodexDeviceLogin,
	beginSubscriptionLogin,
	clearAllStoredCredentials,
	clearStoredCodexCredential,
	clearStoredSubscriptionCredential,
	credentialsPath,
	readStoredCodexCredential,
	readStoredSubscriptionCredential,
} from '../integrations/providers/index.js'
import {
	describeCodexDeviceLoginStart,
	describeLoginOutcome,
	describeLoginStart,
	describeLogout,
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
	'  --timeout <seconds> Give up waiting after this long (default: 300).',
	'  -h, --help          Show this help.',
	'',
	'Claude sign-in opens a registered browser flow; paste the returned code or',
	'finished address into this terminal. Codex sign-in prints a device code and',
	'polls while you approve it in the browser.',
	'',
	'The credential is written to ~/.namzu/credentials.json, readable only by your',
	"account. Run 'namzu logout' to remove it.",
].join('\n')

const DEFAULT_TIMEOUT_SECONDS = 300

const LOGOUT_HELP = [
	'Usage: namzu logout [claude|codex|all]',
	'',
	'Remove a subscription credential created by Namzu on this machine.',
	'With no target, both Namzu-owned credentials are removed for compatibility.',
	'Credentials borrowed from another tool or supplied through the environment are untouched.',
].join('\n')

export type LogoutTarget = SubscriptionProviderId | 'all'

export function parseLogoutTarget(argv: readonly string[]): LogoutTarget | null {
	if (argv.length === 0) return 'all'
	if (argv.length !== 1) return null
	const value = argv[0]?.toLowerCase()
	if (value === 'claude' || value === 'anthropic') return 'anthropic'
	if (value === 'codex' || value === 'chatgpt') return 'codex'
	if (value === 'all') return 'all'
	return null
}

interface LoginFlags {
	readonly provider?: SubscriptionProviderId
	readonly noBrowser: boolean
	readonly timeoutMs: number
	readonly unknown: readonly string[]
}

export function parseLoginFlags(argv: readonly string[]): LoginFlags {
	let noBrowser = false
	let provider: SubscriptionProviderId | undefined
	let timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1_000
	const unknown: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--no-browser') {
			noBrowser = true
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
	return { provider, noBrowser, timeoutMs, unknown }
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

		let login: Awaited<ReturnType<typeof beginSubscriptionLogin>>
		try {
			login = await beginSubscriptionLogin()
		} catch (err) {
			ctx.formatter.print({
				text: `Could not start a sign-in: ${err instanceof Error ? err.message : String(err)}`,
			})
			return EXIT_FAIL
		}

		ctx.formatter.print({
			text: describeLoginStart({
				url: login.url,
				browserOpened: flags.noBrowser ? false : openInBrowser(login.url),
				completionHint: 'paste it here and press enter',
			}),
		})

		const stop = new AbortController()
		const timeout = new Promise<LoginOutcome>((resolve) =>
			setTimeout(
				() =>
					resolve({
						ok: false,
						reason: 'Timed out waiting for the sign-in to finish. Nothing was stored.',
					}),
				flags.timeoutMs,
			).unref(),
		)
		const pasted = firstStdinLine(stop.signal).then((line): Promise<LoginOutcome> | LoginOutcome =>
			line === null
				? {
						ok: false,
						reason:
							'Standard input closed before an authorization code was pasted. Nothing was stored.',
					}
				: login.completeWithPastedCode(line),
		)
		const outcome = await Promise.race([pasted, timeout])
		stop.abort()
		login.cancel()

		ctx.formatter.print({
			text: describeLoginOutcome(outcome, {
				retry: 'namzu login claude',
				remove: 'namzu logout',
			}),
		})
		return outcome.ok ? EXIT_OK : EXIT_FAIL
	},
}

export const logoutCommand: CommandDef = {
	name: 'logout',
	description: 'Remove a subscription credential namzu stored on this machine.',
	passThrough: true,
	help: LOGOUT_HELP,
	handler: async ({ ctx, rawArgs }) => {
		const target = parseLogoutTarget(rawArgs)
		if (!target) {
			ctx.formatter.print({ text: LOGOUT_HELP })
			return EXIT_USAGE
		}
		const path = credentialsPath()
		const hadClaude = readStoredSubscriptionCredential() !== null
		const hadCodex = readStoredCodexCredential() !== null
		try {
			if (target === 'anthropic') clearStoredSubscriptionCredential()
			else if (target === 'codex') clearStoredCodexCredential()
			else clearAllStoredCredentials()
		} catch (err) {
			ctx.formatter.print({
				text: `Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
			})
			return EXIT_FAIL
		}
		ctx.formatter.print({
			text:
				target === 'all'
					? describeLogout(path, hadClaude || hadCodex)
					: describeProviderLogout(path, target, target === 'anthropic' ? hadClaude : hadCodex),
		})
		return EXIT_OK
	},
}
