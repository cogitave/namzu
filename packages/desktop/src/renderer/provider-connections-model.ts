import type { ProviderConnectionView, ProviderTestResult } from '../shared/protocol.js'

/** Plain words for how a provider is connected. Never carries a key. */
export function connectionStatus(row: ProviderConnectionView): string {
	if (row.state === 'not-connected') return 'Not connected'
	// Namzu counts a provider only once a key is saved; the free models need a free key from Zen.
	if (row.state === 'free') return 'Free models. Needs a free Zen key.'
	switch (row.how) {
		case 'environment':
			return row.envName
				? `Connected with the key in your computer’s ${row.envName} setting`
				: 'Connected with a key from your computer’s settings'
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

/** What the person is told after a check. */
export function testOutcome(
	result: ProviderTestResult,
	label: string,
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
		default:
			return {
				text: `${label} can’t be checked without sending a message, so the key is saved but not confirmed.`,
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
