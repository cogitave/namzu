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
 * Instead this waits on BOTH routes at once. The loopback listener takes the
 * browser that lands on this machine; standard input takes the address pasted
 * back from a browser somewhere else. Whichever answers first wins.
 */

import { createInterface } from 'node:readline'

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type LoginOutcome,
	beginSubscriptionLogin,
	clearStoredSubscriptionCredential,
	credentialsPath,
	readStoredSubscriptionCredential,
} from '../integrations/providers/index.js'
import { describeLoginOutcome, describeLoginStart, describeLogout } from '../tui/login-prompt.js'
import { openInBrowser } from '../tui/open-browser.js'
import type { CommandDef } from './types.js'

const LOGIN_HELP = `Usage: namzu login [options]

Sign in with a provider subscription and store the credential on this machine.

Options:
  --no-browser        Do not try to launch a browser; just print the address.
  --timeout <seconds> Give up waiting after this long (default: 300).
  -h, --help          Show this help.

namzu prints an address to open. Finish the sign-in in a browser and namzu
picks it up automatically; if your browser is on another machine, paste the
address it lands on into this terminal and press enter.

The credential is written to ~/.namzu/credentials.json, readable only by your
account. Run 'namzu logout' to remove it.`

const DEFAULT_TIMEOUT_SECONDS = 300

interface LoginFlags {
	readonly noBrowser: boolean
	readonly timeoutMs: number
	readonly unknown: readonly string[]
}

export function parseLoginFlags(argv: readonly string[]): LoginFlags {
	let noBrowser = false
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
		if (arg !== undefined) unknown.push(arg)
	}
	return { noBrowser, timeoutMs, unknown }
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
 * **A closed or absent stream never resolves.** This is raced against the
 * loopback listener and a timeout, so a stdin that is not there (a service,
 * `< /dev/null`) must not read as "the operator declined" and cancel a browser
 * sign-in still in progress.
 */
function firstStdinLine(signal: AbortSignal): Promise<string> {
	return new Promise((resolve) => {
		if (!process.stdin.readable) return
		const rl = createInterface({ input: process.stdin })
		const done = () => {
			rl.close()
		}
		signal.addEventListener('abort', done, { once: true })
		rl.on('line', (line) => {
			if (line.trim().length === 0) return
			signal.removeEventListener('abort', done)
			rl.close()
			resolve(line)
		})
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
				loopback: login.loopback,
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
		const pasted = firstStdinLine(stop.signal).then((line) => login.completeWithPastedCode(line))
		const callback = login.waitForCallback()

		const outcome = await Promise.race(callback ? [callback, pasted, timeout] : [pasted, timeout])
		stop.abort()
		login.cancel()

		ctx.formatter.print({
			text: describeLoginOutcome(outcome, { retry: 'namzu login', remove: 'namzu logout' }),
		})
		return outcome.ok ? EXIT_OK : EXIT_FAIL
	},
}

export const logoutCommand: CommandDef = {
	name: 'logout',
	description: 'Remove the subscription credential namzu stored on this machine.',
	handler: async ({ ctx }) => {
		const path = credentialsPath()
		const had = readStoredSubscriptionCredential() !== null
		try {
			clearStoredSubscriptionCredential()
		} catch (err) {
			ctx.formatter.print({
				text: `Could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
			})
			return EXIT_FAIL
		}
		ctx.formatter.print({ text: describeLogout(path, had) })
		return EXIT_OK
	},
}
