/**
 * The `state`-derives-from-verifier probe, scored against attempts whose
 * answer is known.
 *
 * ## What this suite is about, said plainly
 *
 * The deliverable here is the **probe** in `./oauth-state.js`, and this suite
 * scores the probe — not namzu's own sign-in, which is guarded by unit tests
 * beside the flow it belongs to. Saying so matters: a suite named for a
 * security property, sitting in a security folder, reads as "this proves the
 * product is safe", and this one does not. It proves the instrument reads
 * correctly in both directions, which is what makes an answer from it worth
 * anything anywhere else.
 *
 * A probe scored only against BROKEN samples would pass while always
 * returning "broken". A probe scored only against SOUND ones would pass while
 * always returning "fine" — and that is the direction that matters, because a
 * security check stuck on "fine" is indistinguishable from a working one until
 * the day it is needed. So every case pins both halves: the verdict, and the
 * NAME of the relation found.
 *
 * ## Why these particular broken shapes
 *
 * They are not invented. `state = verifier` is what real authorization-code
 * implementations ship, and it survives the assertion a careful person writes
 * (`state !== challenge`) because the challenge is the hash of the verifier —
 * so the two differ by the width of a hash while the property is broken. The
 * rest are the shapes an equality check waves through: a slice, a
 * re-encoding, a reversal, and a leak through a parameter that is not `state`
 * at all.
 *
 * Deterministic: no provider, no kernel, no network. The `run` step returns a
 * fabricated `EvalRun` carrying the attempt, and the scorers read it.
 */

import { createHash, randomBytes } from 'node:crypto'
import { customScorer, runExperiment } from '@namzu/sdk'

import { auditAuthorizationRequest, stateDerivesFromVerifier } from './oauth-state.js'

const AUTHORIZE = 'https://authorization.example/oauth/authorize'

/** A verifier of the shape RFC 7636 asks for: 43+ base64url characters. */
function verifier() {
	return randomBytes(32).toString('base64url')
}

/** @param {string} v */
function challengeFor(v) {
	return createHash('sha256').update(v).digest('base64url')
}

/**
 * Build the authorization request a flow would actually send.
 *
 * @param {{ state: string, verifier: string, extra?: Record<string, string> }} input
 */
function authorizationUrl(input) {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: 'probe-client',
		redirect_uri: 'http://localhost:1/callback',
		code_challenge: challengeFor(input.verifier),
		code_challenge_method: 'S256',
		state: input.state,
		...(input.extra ?? {}),
	})
	return `${AUTHORIZE}?${params.toString()}`
}

/**
 * An `EvalRun` that drove nothing.
 *
 * `error` is deliberately absent: setting it makes the scorers short-circuit
 * to zero with a "run failed" reason, which would report a broken harness as
 * a failed property.
 *
 * @param {{ url: string, state: string, verifier: string }} attempt
 */
function runFor(attempt) {
	return {
		output: null,
		steps: [],
		toolCalls: [],
		totalTokens: 0,
		totalCostUsd: 0,
		durationMs: 0,
		attempt,
	}
}

/**
 * Did the probe reach the expected verdict, and name the expected relation?
 *
 * The name is scored, not just the verdict, because a probe that flags
 * everything for the wrong reason sends the next person to the wrong line —
 * and would otherwise score full marks on every broken case here.
 */
const verdictScorer = customScorer('state-independence', (run, evalCase) => {
	const attempt = run.attempt
	if (!attempt) {
		return { score: 0, reason: 'the case carried no captured attempt' }
	}
	const audit = auditAuthorizationRequest(attempt)
	const expected = evalCase.input.expect

	if (expected === 'sound') {
		return audit.sound
			? { score: 1, reason: 'independent state, no recoverable verifier in the request' }
			: {
					score: 0,
					reason: `a sound attempt was flagged: ${audit.findings.join('; ')}`,
					details: { findings: audit.findings },
				}
	}
	if (audit.sound) {
		return {
			score: 0,
			reason: `a broken attempt was passed as sound — expected ${expected}`,
			details: { expected },
		}
	}
	const named = audit.findings.some((f) => f.includes(expected))
	return named
		? { score: 1, reason: audit.findings.join('; ') }
		: {
				score: 0,
				reason: `flagged, but for the wrong reason — expected ${expected}, got: ${audit.findings.join('; ')}`,
				details: { expected, findings: audit.findings },
			}
})

/**
 * The specific false negative this whole probe exists for.
 *
 * Scored on its own rather than folded into the case list, because it is not
 * a claim about one sample: it is the claim that the assertion a careful
 * person writes CANNOT see this defect, which is the reason the probe is
 * needed at all. If this ever scores zero — if `state === verifier` started
 * making `state` equal the challenge — the argument for the probe has changed
 * and the reasoning in `oauth-state.js` needs rereading, not patching.
 */
const insufficiencyScorer = customScorer('difference-check-is-insufficient', () => {
	const v = verifier()
	const challenge = challengeFor(v)
	const broken = v // the shipped defect: state = verifier

	if (broken === challenge) {
		return { score: 0, reason: 'the verifier equalled its own challenge, which cannot happen' }
	}
	const caught = stateDerivesFromVerifier(broken, v)
	return caught
		? {
				score: 1,
				reason: `state !== challenge holds for the broken flow, and the probe still names it: ${caught}`,
			}
		: { score: 0, reason: 'the probe missed state = verifier' }
})

export default async function oauthState() {
	return runExperiment({
		name: 'security/oauth-state',
		scorers: [verdictScorer, insufficiencyScorer],
		run: async (input) => runFor(input.attempt()),
		cases: [
			{
				name: 'independent state passes',
				input: {
					expect: 'sound',
					attempt: () => {
						const v = verifier()
						const state = randomBytes(16).toString('base64url')
						return { url: authorizationUrl({ state, verifier: v }), state, verifier: v }
					},
				},
			},
			{
				name: 'state = the verifier, the shape that ships',
				input: {
					expect: 'the verifier itself',
					attempt: () => {
						const v = verifier()
						return { url: authorizationUrl({ state: v, verifier: v }), state: v, verifier: v }
					},
				},
			},
			{
				name: 'state = a slice of the verifier',
				input: {
					expect: 'a slice of the verifier',
					attempt: () => {
						const v = verifier()
						const state = v.slice(0, 20)
						return { url: authorizationUrl({ state, verifier: v }), state, verifier: v }
					},
				},
			},
			{
				name: 'state = the verifier reversed',
				input: {
					expect: 'reversed',
					attempt: () => {
						const v = verifier()
						const state = [...v].reverse().join('')
						return { url: authorizationUrl({ state, verifier: v }), state, verifier: v }
					},
				},
			},
			{
				name: 'state = the verifier re-encoded',
				input: {
					expect: 're-encoded as hex',
					attempt: () => {
						const v = verifier()
						const state = Buffer.from(v, 'utf8').toString('hex')
						return { url: authorizationUrl({ state, verifier: v }), state, verifier: v }
					},
				},
			},
			{
				name: 'state = the challenge, which is public',
				input: {
					expect: 'this is the PKCE challenge',
					attempt: () => {
						const v = verifier()
						const state = challengeFor(v)
						return { url: authorizationUrl({ state, verifier: v }), state, verifier: v }
					},
				},
			},
			{
				name: 'the verifier leaks through a parameter that is not state',
				input: {
					expect: 'the verifier itself',
					attempt: () => {
						const v = verifier()
						const state = randomBytes(16).toString('base64url')
						return {
							url: authorizationUrl({ state, verifier: v, extra: { debug_verifier: v } }),
							state,
							verifier: v,
						}
					},
				},
			},
		],
	})
}

export const tags = ['security', 'ci']
