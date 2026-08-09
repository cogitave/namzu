/**
 * Does `state` derive from the PKCE verifier?
 *
 * A red-team probe for an authorization-code flow, published because the
 * defect it looks for is one a careful person writes on purpose, ships, and
 * is never told about.
 *
 * ## The defect
 *
 * In authorization code + PKCE, two secrets are minted per attempt:
 *
 *  - the **verifier**, which must never leave the client until the token
 *    exchange. Only its `S256` hash — the **challenge** — travels in the
 *    authorization URL. That is the entire mechanism: an attacker who
 *    intercepts the authorization code cannot redeem it, because redeeming it
 *    needs the verifier and the verifier was never sent.
 *  - the **state**, an unguessable value echoed back by the authorization
 *    server so the client can match the response to its own request.
 *
 * `state` travels in the authorization URL. So a flow that sets
 * `state = verifier` writes the verifier into the address bar, the browser
 * history, and any referrer along the way — and the one secret PKCE exists to
 * keep out of that URL is exactly the verifier. The ceremony is entirely
 * present: a real challenge, `S256`, a real `code_verifier` on the exchange.
 * The protection is gone.
 *
 * ## Why the obvious assertion does not catch it
 *
 * The check a careful person naturally writes is:
 *
 *     expect(state).not.toBe(challenge)
 *
 * **That passes while the property is broken.** The challenge is the SHA-256
 * of the verifier, so `state === verifier` leaves `state` and `challenge`
 * different — necessarily, and by the width of a hash. The assertion is not
 * wrong; it is about the wrong pair.
 *
 * Even `state !== verifier` is not enough on its own. It catches literal
 * reuse and nothing else: a truncation, a re-encoding, a reversal or a
 * second hash all still couple the two values, and a `state` computed from
 * the verifier carries no independent entropy — which makes it useless as the
 * anti-forgery value it exists to be, whatever else it leaks.
 *
 * So the question has to be asked as **"does `state` derive from the
 * verifier"**, against every derivation cheap enough to enumerate, in both
 * directions.
 *
 * ## What this cannot tell you
 *
 * It reads one captured attempt. A flow that derived `state` from the
 * verifier by a route not listed below would pass — the list is the honest
 * bound, and it is written out rather than described so a reader can see
 * exactly how far the answer reaches. Absence of a listed relation is not
 * proof of independence; presence of one is proof of coupling.
 */

import { createHash } from 'node:crypto'

/**
 * Shortest overlap treated as containment.
 *
 * Below this, a shared run is coincidence rather than derivation — two
 * independent base64url values of ordinary length share short substrings all
 * the time, and a probe that called that a leak would cry wolf until someone
 * switched it off.
 */
const MIN_CONTAINMENT = 8

/**
 * Relations that let a reader RECOVER the verifier from the value.
 *
 * Kept apart from the one-way relations below because the two answer
 * different questions. A hash of the verifier appearing in the authorization
 * URL is not a leak — that is what the challenge IS. The verifier reversed,
 * re-encoded, or truncated in that URL is a leak.
 *
 * @param {string} verifier
 * @returns {ReadonlyArray<readonly [string, string]>}
 */
function reversibleForms(verifier) {
	const bytes = Buffer.from(verifier, 'utf8')
	return [
		['the verifier itself', verifier],
		['the verifier, reversed', [...verifier].reverse().join('')],
		['the verifier, re-encoded as base64url', bytes.toString('base64url')],
		['the verifier, re-encoded as base64', bytes.toString('base64')],
		['the verifier, re-encoded as hex', bytes.toString('hex')],
	]
}

/**
 * Relations that couple the two values without exposing the verifier.
 *
 * Still disqualifying for `state`. `sha256`/base64url is the PKCE challenge
 * itself, which is public by design — a `state` equal to it is a public
 * value, and an anti-forgery token an attacker can read out of the request it
 * is meant to protect is not one.
 *
 * @param {string} verifier
 * @returns {ReadonlyArray<readonly [string, string]>}
 */
function oneWayForms(verifier) {
	/** @type {Array<readonly [string, string]>} */
	const forms = []
	for (const algorithm of /** @type {const} */ (['sha256', 'sha1', 'md5'])) {
		const digest = createHash(algorithm).update(verifier).digest()
		const label =
			algorithm === 'sha256'
				? `${algorithm} of the verifier, base64url — this is the PKCE challenge`
				: `${algorithm} of the verifier, base64url`
		forms.push([label, digest.toString('base64url')])
		forms.push([`${algorithm} of the verifier, hex`, digest.toString('hex')])
		forms.push([`${algorithm} of the verifier, base64`, digest.toString('base64')])
	}
	return forms
}

/**
 * @param {string} a
 * @param {string} b
 */
function containsMeaningfully(a, b) {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
	return shorter.length >= MIN_CONTAINMENT && longer.includes(shorter)
}

/**
 * Name the relation tying `state` to `verifier`, or `null` when there is none
 * this probe can find.
 *
 * A NAME rather than a boolean: "state derives from the verifier" sends
 * someone to re-read a flow they believe is correct, and "state is the
 * verifier, reversed" sends them to the line.
 *
 * @param {string} state
 * @param {string} verifier
 * @returns {string | null}
 */
export function stateDerivesFromVerifier(state, verifier) {
	if (typeof state !== 'string' || typeof verifier !== 'string') return null
	if (state.length === 0 || verifier.length === 0) return null

	for (const [name, form] of [...reversibleForms(verifier), ...oneWayForms(verifier)]) {
		if (state === form) return name
		if (state.toLowerCase() === form.toLowerCase()) return `${name}, differing only in case`
	}
	// The inverse direction: `state` is an encoding that DECODES to the
	// verifier. A flow that base64url-encodes its verifier into `state` is
	// caught above; one that stores the verifier already-encoded and uses the
	// raw bytes as state is caught here.
	for (const encoding of /** @type {const} */ (['base64url', 'base64', 'hex'])) {
		let decoded = ''
		try {
			decoded = Buffer.from(state, encoding).toString('utf8')
		} catch {
			continue
		}
		if (decoded === verifier) return `a ${encoding} encoding of the verifier`
	}
	// Truncation, prefixing, wrapping — the shapes that survive an equality
	// check. Asked last so an exact relation is reported by its own name.
	if (containsMeaningfully(state, verifier)) {
		return state.length < verifier.length
			? 'a slice of the verifier'
			: 'a value containing the verifier'
	}
	return null
}

/**
 * Name a recoverable form of the verifier present in an authorization
 * request, or `null`.
 *
 * Separate from the question above because a request can leak the verifier
 * through a parameter that is not `state` at all — a debug field, a login
 * hint, a redirect carrying it round. Only reversible forms are reported: the
 * challenge is a hash of the verifier and is *supposed* to be here, so
 * flagging one-way forms would make this fire on every correct flow, which is
 * the fastest way to get a security check disabled.
 *
 * @param {string} url
 * @param {string} verifier
 * @returns {string | null}
 */
export function authorizationRequestLeaksVerifier(url, verifier) {
	if (typeof url !== 'string' || typeof verifier !== 'string') return null
	if (url.length === 0 || verifier.length === 0) return null

	const haystacks = [url]
	try {
		for (const [, value] of new URL(url).searchParams) haystacks.push(value)
	} catch {
		// Not a parseable URL; the raw-string check above still applies.
	}
	for (const [name, form] of reversibleForms(verifier)) {
		if (form.length < MIN_CONTAINMENT) continue
		for (const haystack of haystacks) {
			if (haystack.includes(form)) return name
		}
	}
	return null
}

/**
 * Both questions about one captured attempt.
 *
 * @param {{ url: string, state: string, verifier: string }} attempt
 * @returns {{ sound: boolean, findings: readonly string[] }}
 */
export function auditAuthorizationRequest(attempt) {
	const findings = []
	const derived = stateDerivesFromVerifier(attempt.state, attempt.verifier)
	if (derived) findings.push(`state is ${derived}`)
	const leaked = authorizationRequestLeaksVerifier(attempt.url, attempt.verifier)
	if (leaked) findings.push(`the authorization request carries ${leaked}`)
	return { sound: findings.length === 0, findings }
}
