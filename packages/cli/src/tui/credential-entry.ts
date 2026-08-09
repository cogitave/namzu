/**
 * Typing a credential into a running namzu, for this session only.
 *
 * Someone who has just installed namzu and has no key reaches a screen that
 * lists three sources and says "then restart namzu". That is accurate and it is
 * a cliff: the product tells them to leave it in order to use it.
 *
 * ## Why session-only, stated as a decision rather than a limitation
 *
 * The obvious durable home is the OS keychain, and here it does not exist. The
 * keychain helper in this package is macOS-only, and it reads and writes a
 * DIFFERENT product's credential store — namzu borrows an OAuth token from it.
 * Writing a namzu key into that envelope would put our secret under their name.
 * On Windows, which is where this was asked for, there is no keychain path at
 * all.
 *
 * So the durable options were a plaintext file or a per-platform credential
 * store nobody has written. Keeping the key in memory for the session is the
 * honest third answer: nothing lands on disk, it works everywhere, and the
 * screen names the environment variable that makes it durable. A secret at rest
 * should be something the operator chose, not something that arrived because
 * they typed into a text field.
 *
 * Everything decidable lives here rather than in the component, because this
 * package has no component tests and a secret is the worst thing to leave
 * unverifiable.
 */

import {
	type DetectedProvider,
	type ProviderRegistryEntry,
	isAnthropicOAuthToken,
} from '../integrations/providers/index.js'

/**
 * Which kind of secret was pasted.
 *
 * The distinction is not cosmetic: the two travel differently on the wire —
 * `constructProvider` sends one as `authToken` and the other as `apiKey` — and
 * they expire differently. A subscription token is short-lived and is renewed
 * from refresh metadata that only the discovered credential carries; a hand
 * pasted one has none, so it lapses in hours with nothing to renew it. An
 * operator who is not told that at the moment they paste discovers it as a 401
 * mid-turn, which is the difference between a feature and a trap.
 */
export type CredentialKind = 'api-key' | 'subscription-token'

/**
 * Classify a pasted secret by its own shape.
 *
 * Reuses the classifier the session layer already decides the wire header with
 * (`isAnthropicOAuthToken`), so the screen cannot say one thing while the
 * request says another. Every other provider takes an API key and nothing else,
 * so asking the question of them would invent a distinction they do not have.
 */
export function classifyCredential(entry: ProviderRegistryEntry, key: string): CredentialKind {
	if (entry.id !== 'anthropic') return 'api-key'
	return isAnthropicOAuthToken(key.trim()) ? 'subscription-token' : 'api-key'
}

/**
 * What a key looks like on screen. Never the key.
 *
 * Enough tail to tell two keys apart when you have pasted the wrong one, and
 * never enough to reconstruct one from a screen recording or a scrollback that
 * outlives the session. The length is not revealed either: a fixed-width mask
 * would leak it, and key length distinguishes vendors and sometimes tiers.
 */
export function maskKey(key: string): string {
	const trimmed = key.trim()
	if (trimmed.length === 0) return ''
	const tail = trimmed.slice(-4)
	return trimmed.length <= 4 ? '••••' : `••••••••${tail}`
}

/**
 * Whether a typed key is worth trying at all.
 *
 * Deliberately shallow. Anything beyond "not empty, no whitespace, not obviously
 * a shell fragment" is guessing at vendor formats that change, and a validator
 * that rejects a NEW valid key format is worse than one that lets the provider
 * answer. The provider is the authority; this only catches the paste that
 * plainly went wrong.
 */
export function keyLooksUsable(key: string): { ok: true } | { ok: false; reason: string } {
	const trimmed = key.trim()
	if (trimmed.length === 0) return { ok: false, reason: 'No key entered.' }
	if (/\s/.test(trimmed)) {
		return { ok: false, reason: 'That contains a space — check for a truncated or wrapped paste.' }
	}
	// Assignment-SHAPED, not "contains an equals sign". The old test rejected any
	// `=` anywhere, which is fine for an API key and wrong for a subscription
	// token: a JWT-shaped one is base64 and may carry `=` padding, so the screen
	// refused a valid credential and blamed the operator's paste for it. This
	// still catches the case the check exists for — `ANTHROPIC_API_KEY=sk-…`
	// copied out of a shell profile — because that has a variable name in front.
	if (trimmed.startsWith('$') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
		return {
			ok: false,
			reason: 'That looks like a shell assignment or variable. Paste the key itself.',
		}
	}
	return { ok: true }
}

/** How the key was checked before being accepted. */
export type Verification =
	| { readonly kind: 'verified' }
	/** The driver has no way to check a key without spending a turn. */
	| { readonly kind: 'unverifiable' }
	| { readonly kind: 'rejected'; readonly reason: string }

/**
 * What namzu tells the operator it did with what they typed.
 *
 * Every branch says four things: that it worked or did not, WHICH KIND of
 * credential it took, that it is held for this session only, and the
 * environment variable that persists it. The third is the part a person is most
 * likely to assume otherwise — typing a credential into an application usually
 * means it was saved.
 *
 * The kind is said out loud because the two behave differently after this
 * screen, and only one of them can be renewed. See {@link CredentialKind}.
 */
export function describeDisposition(
	entry: ProviderRegistryEntry,
	verification: Verification,
	kind: CredentialKind = 'api-key',
): string {
	const noun = kind === 'subscription-token' ? 'subscription token' : 'API key'
	const persist = entry.envVars[0]
	const durable = persist
		? `To keep it, set ${persist} in your shell and restart.`
		: 'To keep it, configure the credential in your environment and restart.'

	if (verification.kind === 'rejected') {
		return `${entry.label} rejected that ${noun}: ${verification.reason}\nNothing was stored.`
	}

	const checked =
		verification.kind === 'verified'
			? `${entry.label} accepted the ${noun}.`
			: // Said plainly rather than implied. Claiming a key is good would be
				// inventing a verification that did not happen — and this now covers
				// two ways of not happening: a driver that declares no credential
				// probe at all, and one whose probe could not be reached. The old
				// wording asserted the first ("offers no way to check it"), which
				// would be false for a probe that timed out. Neither is a bad key,
				// and neither is a checked one.
				`${noun.replace(/^./, (c) => c.toUpperCase())} accepted, but NOT checked — ${entry.label} could not confirm it just now, so the first message will be the test.`

	// Disclosed HERE, at the paste, and not left to be discovered as a 401 in the
	// middle of a turn. A discovered subscription token arrives with a refresh
	// token and an expiry, and the session layer renews it between turns; a
	// pasted one carries neither, so there is nothing to renew it with. Saying
	// "it lasts hours" is the honest form of a limitation we cannot remove
	// without an authorization flow namzu does not have.
	const expiry =
		kind === 'subscription-token'
			? '\nA pasted subscription token has no refresh data with it, so it expires in a few hours and namzu cannot renew it — expect to enter it again.'
			: ''

	return `${checked}\nHeld in memory for this session only — it is not written anywhere. ${durable}${expiry}`
}

/**
 * The detected-provider record a typed key produces.
 *
 * Shaped exactly like a discovered one so every downstream path — session
 * construction, the model picker, `/provider` — treats it identically. The only
 * difference is `source`, so a surface can say where it came from.
 *
 * `oauth` is deliberately NOT set, for a subscription token as much as for an
 * API key. That field means "this credential can be renewed from a refresh
 * token", the session layer gates its refresh on it, and a hand-pasted token
 * supplies no refresh token — so filling it in would claim a renewal path that
 * does not exist and turn a disclosed expiry into a silent 401. The disclosure
 * in `describeDisposition` is the substitute.
 */
export function sessionCredential(entry: ProviderRegistryEntry, key: string): DetectedProvider {
	return {
		entry,
		source: { kind: 'session' },
		apiKey: key.trim(),
		...(entry.defaultBaseUrl !== undefined ? { baseUrl: entry.defaultBaseUrl } : {}),
		alternatives: [],
	}
}
