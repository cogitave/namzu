/**
 * What namzu says while an operator signs in to their subscription.
 *
 * Every decidable thing lives here rather than in the component, for the
 * reason `credential-entry.ts` gives next door: this package has no component
 * tests, and wording that handles a credential is the worst thing to leave
 * unverifiable. What the component does with these strings is print them.
 *
 * The one rule these functions exist to keep: **an outcome is described by
 * what happened, never by quoting what came back.** A refusal from a token
 * endpoint arrives in a document that can contain a token, so no function
 * here ever receives one — `LoginOutcome.reason` is already sanitised at the
 * protocol layer, and the success arm is handed a path, not a credential.
 */

import type { LoginOutcome } from '../integrations/providers/index.js'

/**
 * The screen the operator reads when a sign-in starts.
 *
 * The URL is printed WHATEVER happened with the browser. A launcher that
 * started is not a browser that appeared — no platform reports that — and a
 * message that says "your browser is opening" and nothing else leaves someone
 * on a machine with no browser staring at a line that is simply false.
 */
export function describeLoginStart(start: {
	readonly url: string
	readonly browserOpened: boolean
	/**
	 * How the operator hands the result back HERE, in the surface they are
	 * looking at.
	 *
	 * A parameter because the answer is different in each one — a slash command
	 * in the chat, a keypress at the picker, a line of standard input at a bare
	 * terminal — and this sentence is the one an operator with no browser
	 * follows. Printing the chat's answer on the picker would send them to a
	 * composer that is not on screen, which is the defect that made a shipped
	 * sign-in unreachable.
	 */
	readonly completionHint?: string
}): string {
	const lines = [
		start.browserOpened
			? 'Opening your browser to sign in. If nothing opened, or the browser is on another machine, use this address:'
			: 'Open this address to sign in — on this machine, or on any machine you can reach it from:',
		'',
		start.url,
		'',
	]
	lines.push(
		'Claude will show an authorization code when sign-in finishes. Copy that code, or the finished address, back here:',
	)
	lines.push('', `  ${start.completionHint ?? '/login <the address, or just the code>'}`)
	return lines.join('\n')
}

export function describeCodexDeviceLoginStart(start: {
	readonly url: string
	readonly userCode: string
	readonly browserOpened: boolean
}): string {
	return [
		start.browserOpened
			? 'Opening your browser to sign in with ChatGPT. If nothing opened, use this address:'
			: 'Open this address to sign in with ChatGPT:',
		'',
		start.url,
		'',
		'Enter this one-time device code:',
		`  ${start.userCode}`,
		'',
		'Continue only if you started this sign-in in Namzu. The code expires after 15 minutes.',
	].join('\n')
}

/**
 * What the operator reads when the attempt ends, either way.
 *
 * `retryHint` and `removeHint` name the commands as THIS surface spells them,
 * for the same reason `completionHint` exists above. A failed sign-in run from
 * a bare terminal used to end with "Run /login to try again" — a slash command,
 * in a shell, where the thing to type is `namzu login`. Instructions that name
 * another surface's spelling are the defect that made the sign-in unreachable
 * from the picker; it is not any better in an error message.
 */
export function describeLoginOutcome(
	outcome: LoginOutcome,
	hints: { readonly retry?: string; readonly remove?: string } = {},
): string {
	if (!outcome.ok) {
		return `${outcome.reason}\n\nRun ${hints.retry ?? '/login'} to try again.`
	}
	return [
		'Signed in. The credential is stored on this machine, readable only by your account:',
		`  ${outcome.storedAt}`,
		'',
		`namzu will refresh it as it expires, and will find it again next time it starts. Run ${hints.remove ?? '/logout'} to remove it.`,
	].join('\n')
}

/** What the operator reads after asking namzu to forget the credential. */
export function describeLogout(path: string, removed: boolean): string {
	return removed
		? `Removed the stored credential at ${path}. This session keeps working until it ends; the next one will ask you to sign in again.\n\nSigning out here does not revoke anything at the provider — do that in your account settings if you need to.`
		: "There was no stored credential to remove. If namzu is using one, it came from your environment or from another tool on this machine, and neither is namzu's to delete."
}

/**
 * Whether a `/login` argument is an attempt to finish, rather than to start.
 *
 * Bare `/login` starts an attempt; `/login <something>` finishes one. Drawn
 * here rather than in the command so the rule is testable and so the command
 * cannot quietly grow a third meaning.
 */
export function isCompletionArgument(args: readonly string[]): boolean {
	return args.join(' ').trim().length > 0
}
