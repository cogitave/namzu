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

import type { DetectedProvider, ProviderRegistryEntry } from '../integrations/providers/index.js'

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
	if (trimmed.startsWith('$') || trimmed.includes('=')) {
		return {
			ok: false,
			// The classic: pasting `ANTHROPIC_API_KEY=sk-…` or `$MY_KEY` from a
			// shell profile rather than the value.
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
 * Every branch says three things: that it worked or did not, that the key is
 * held for this session only, and the environment variable that persists it.
 * The middle one is the part a person is most likely to assume otherwise —
 * typing a credential into an application usually means it was saved.
 */
export function describeDisposition(
	entry: ProviderRegistryEntry,
	verification: Verification,
): string {
	const persist = entry.envVars[0]
	const durable = persist
		? `To keep it, set ${persist} in your shell and restart.`
		: 'To keep it, configure the credential in your environment and restart.'

	if (verification.kind === 'rejected') {
		return `${entry.label} rejected that key: ${verification.reason}\nNothing was stored.`
	}

	const checked =
		verification.kind === 'verified'
			? `${entry.label} accepted the key.`
			: // Said plainly rather than implied. A driver with no cheap check
				// cannot confirm a key without spending a turn, and claiming it is
				// good would be inventing a verification that did not happen.
				`Key accepted. ${entry.label} offers no way to check it without a request, so the first message will be the test.`

	return `${checked}\nHeld in memory for this session only — it is not written anywhere. ${durable}`
}

/**
 * The detected-provider record a typed key produces.
 *
 * Shaped exactly like a discovered one so every downstream path — session
 * construction, the model picker, `/provider` — treats it identically. The only
 * difference is `source`, so a surface can say where it came from.
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
