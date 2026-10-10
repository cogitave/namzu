import type { ProviderConnectionView, ProviderTestResult } from '../shared/protocol.js'

/** Plain words for how a provider is connected. Never carries a key. */
export function connectionStatus(row: ProviderConnectionView): string {
	if (row.state === 'not-connected') return 'Not connected'
	// Namzu counts a provider only once a key is saved; the free models need a free key from Zen.
	if (row.state === 'free') return 'Free models. Needs a free Zen key.'
	switch (row.how) {
		case 'environment':
			return 'Connected with a key from your computer’s settings'
		case 'saved-key':
			return 'Connected with the key you saved'
		case 'claude-sign-in':
			return 'Connected with your Claude sign-in'
		case 'codex-sign-in':
			return 'Connected with your ChatGPT or Codex sign-in'
		case 'gemini-sign-in':
			return 'Connected with your Google sign-in'
		case 'namzu-sign-in':
			return 'Connected with your Namzu sign-in'
		case 'opencode-key':
			return 'Connected with a key from OpenCode'
		case 'local':
			return 'Running on this computer'
		default:
			return 'Connected'
	}
}

/** Where an environment key comes from, for a tooltip; the status line keeps plain words. */
export function connectionSource(row: ProviderConnectionView): string | undefined {
	return row.how === 'environment' && row.envName
		? `The key comes from the ${row.envName} setting on this computer.`
		: undefined
}

/** What an unconnected row tells the person to do. */
export function unconnectedHint(row: ProviderConnectionView): string | undefined {
	if (row.state !== 'not-connected') return undefined
	if (row.help) return row.help
	if (row.canSaveKey) return `Add an API key to use ${row.label}.`
	return `Start ${row.label} on this computer and Namzu will find it.`
}

/** The row's status once a check or reply showed the saved key is no good. */
export const REJECTED_KEY_STATUS = 'Key not accepted'

/** What the person is told after a check. */
export function testOutcome(
	result: ProviderTestResult,
	label: string,
	how?: ProviderConnectionView['how'],
): { text: string; tone: 'good' | 'bad' | 'quiet' } {
	switch (result) {
		case 'ok':
			return { text: `${label} accepted the key.`, tone: 'good' }
		case 'rejected':
			return {
				text: `${label} did not accept this key. Check that you copied all of it, then try again.`,
				tone: 'bad',
			}
		case 'missing':
			return { text: `There is no key for ${label} to check.`, tone: 'bad' }
		case 'quota':
			return {
				text: `${label} says this account is out of credit. Add credit with ${label}, then check again.`,
				tone: 'bad',
			}
		case 'busy':
			return {
				text: `${label} is busy right now. Check again in a minute.`,
				tone: 'quiet',
			}
		case 'down':
			return {
				text: `${label} had a problem on its side. Check again in a few minutes.`,
				tone: 'quiet',
			}
		case 'no-answer':
			return {
				text: `${label} didn’t answer. Check your internet connection, then check again.`,
				tone: 'quiet',
			}
		default:
			return how?.endsWith('-sign-in')
				? {
						text: 'Namzu can’t check this sign-in ahead of time. Send a message to try it.',
						tone: 'quiet',
					}
				: {
						text: `Namzu can’t check ${label} keys ahead of time. Send a message to try it.`,
						tone: 'quiet',
					}
	}
}

/** A first look at pasted text, before it leaves the window. The CLI checks again. */
export function keyProblem(text: string): string | undefined {
	const value = text.trim()
	if (!value) return 'Paste your API key first.'
	if (/\s/.test(value)) return 'An API key has no spaces or line breaks. Paste just the key.'
	if (value.length > 4096) return 'That is too long to be an API key.'
	return undefined
}

/** Where a person gets the free Zen key. */
export const ZEN_KEY_URL = 'https://opencode.ai/zen'

/** How many providers can answer a message right now. */
export function connectedCount(rows: readonly ProviderConnectionView[]): number {
	return rows.filter((row) => row.state === 'connected').length
}
