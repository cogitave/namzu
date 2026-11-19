import { verify as edVerify } from 'node:crypto'
import { ed25519KeyFromRaw, isDevKeyId } from '../keys.js'
import type { LicenseVerifierKey } from './key.js'

/**
 * A signed answer of the publisher's licence service (`namzu-license/1`). The signature covers the
 * ASCII line `namzu-license-answer/1\n` followed by the payload bytes, so a package signature, a kernel
 * feed signature or a round-1 `.nzlic` licence (which signs `namzu-license/1\n`) can never verify as an
 * answer, and the reverse. Every check of section 3.5 of the spec is here, in order.
 */

export const ANSWER_MAX_BYTES = 16 * 1024
export const ANSWER_PREFIX = 'namzu-license-answer/1\n'
export const SKEW_MS = 10 * 60_000
export const MAX_LIFETIME_MS = 30 * 86_400_000

export type AnswerOp = 'activate' | 'refresh' | 'release'
export type AnswerStatus = 'active' | 'suspended' | 'revoked' | 'expired' | 'released'

export interface AnswerPayload {
	readonly v: 1
	readonly op: AnswerOp
	readonly status: AnswerStatus
	readonly licenseId: string
	readonly activationId: string
	readonly extensionId: string
	readonly machineHash: string
	readonly nonce: string
	readonly issuedAt: string
	readonly validUntil: string
	readonly expires: string
	readonly customer: { readonly id: string; readonly name: string }
	readonly seats: number
	readonly features: readonly string[]
	readonly message: string | null
}

export type AnswerRefusal =
	| 'too-large'
	| 'not-json'
	| 'wrong-key'
	| 'bad-signature'
	| 'bad-payload'
	| 'wrong-op'
	| 'wrong-extension'
	| 'wrong-machine'
	| 'wrong-nonce'
	| 'clock-skew'
	| 'already-over'
	| 'wrong-status'

export type AnswerCheck =
	| { ok: true; payload: AnswerPayload; clamped: boolean; validUntil: number }
	| { ok: false; why: AnswerRefusal }

const STATUSES = ['active', 'suspended', 'revoked', 'expired', 'released']
const OPS = ['activate', 'refresh', 'release']

export function checkAnswer(input: {
	readonly text: string
	readonly verifierKey: LicenseVerifierKey
	readonly keyId: string
	readonly extensionId: string
	readonly machineHash: string
	readonly op: AnswerOp
	readonly nonce: string
	readonly now: number
	readonly devMode: boolean
}): AnswerCheck {
	const no = (why: AnswerRefusal): AnswerCheck => ({ ok: false, why })
	if (Buffer.byteLength(input.text) > ANSWER_MAX_BYTES) return no('too-large')
	let env: Record<string, unknown>
	try {
		const j = JSON.parse(input.text)
		if (!j || typeof j !== 'object' || Array.isArray(j)) return no('not-json')
		env = j
	} catch {
		return no('not-json')
	}
	if (
		env.v !== 1 ||
		typeof env.keyId !== 'string' ||
		typeof env.payload !== 'string' ||
		typeof env.signature !== 'string'
	)
		return no('bad-payload')
	if (env.keyId !== input.keyId || env.keyId !== input.verifierKey.keyId) return no('wrong-key')
	if (isDevKeyId(env.keyId) && !input.devMode) return no('wrong-key')
	const bytes = Buffer.from(env.payload, 'base64url')
	let ok = false
	try {
		ok = edVerify(
			null,
			Buffer.concat([Buffer.from(ANSWER_PREFIX), bytes]),
			ed25519KeyFromRaw(input.verifierKey.publicKey),
			Buffer.from(env.signature, 'base64'),
		)
	} catch {
		ok = false
	}
	if (!ok) return no('bad-signature')
	let p: AnswerPayload
	try {
		p = JSON.parse(bytes.toString('utf8'))
	} catch {
		return no('bad-payload')
	}
	if (
		!p ||
		p.v !== 1 ||
		!STATUSES.includes(p.status) ||
		!OPS.includes(p.op) ||
		typeof p.activationId !== 'string' ||
		p.activationId.length > 64 ||
		typeof p.nonce !== 'string' ||
		typeof p.issuedAt !== 'string' ||
		typeof p.validUntil !== 'string'
	)
		return no('bad-payload')
	if (p.op !== input.op) return no('wrong-op')
	if (p.extensionId !== input.extensionId) return no('wrong-extension')
	if (p.machineHash !== input.machineHash) return no('wrong-machine')
	if (p.nonce !== input.nonce) return no('wrong-nonce')
	const issued = Date.parse(p.issuedAt)
	let validUntil = Date.parse(p.validUntil)
	if (Number.isNaN(issued) || Number.isNaN(validUntil)) return no('bad-payload')
	if (Math.abs(input.now - issued) > SKEW_MS) return no('clock-skew')
	if (input.op === 'release') {
		if (p.status !== 'released') return no('wrong-status')
	} else if (p.status === 'released') return no('wrong-status')
	if (p.status === 'active' && validUntil <= input.now) return no('already-over')
	let clamped = false
	if (validUntil - issued > MAX_LIFETIME_MS) {
		validUntil = issued + MAX_LIFETIME_MS
		clamped = true
	}
	return { ok: true, payload: p, clamped, validUntil }
}

/**
 * Re-open a stored envelope when it is read back: the signature, the key, the extension and this
 * machine are checked again and the payload and the lifetime are taken from the verified bytes only.
 * The nonce, the op and the clock skew belong to the moment the answer arrived and are not repeated.
 */
export function reopenEnvelope(input: {
	readonly envelope: string
	readonly verifierKey: LicenseVerifierKey
	readonly keyId: string
	readonly extensionId: string
	readonly machineHash: string
	readonly devMode: boolean
}): { payload: AnswerPayload; validUntil: number } | undefined {
	if (Buffer.byteLength(input.envelope) > ANSWER_MAX_BYTES) return undefined
	let env: Record<string, unknown>
	try {
		const j = JSON.parse(input.envelope)
		if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
		env = j
	} catch {
		return undefined
	}
	if (
		env.v !== 1 ||
		typeof env.keyId !== 'string' ||
		typeof env.payload !== 'string' ||
		typeof env.signature !== 'string' ||
		env.keyId !== input.keyId ||
		env.keyId !== input.verifierKey.keyId ||
		(isDevKeyId(env.keyId) && !input.devMode)
	)
		return undefined
	const bytes = Buffer.from(env.payload, 'base64url')
	try {
		const ok = edVerify(
			null,
			Buffer.concat([Buffer.from(ANSWER_PREFIX), bytes]),
			ed25519KeyFromRaw(input.verifierKey.publicKey),
			Buffer.from(env.signature, 'base64'),
		)
		if (!ok) return undefined
	} catch {
		return undefined
	}
	let p: AnswerPayload
	try {
		p = JSON.parse(bytes.toString('utf8'))
	} catch {
		return undefined
	}
	if (
		!p ||
		p.v !== 1 ||
		!STATUSES.includes(p.status) ||
		(p.op !== 'activate' && p.op !== 'refresh') ||
		typeof p.activationId !== 'string' ||
		p.extensionId !== input.extensionId ||
		p.machineHash !== input.machineHash
	)
		return undefined
	const issued = Date.parse(p.issuedAt)
	let validUntil = Date.parse(p.validUntil)
	if (Number.isNaN(issued) || Number.isNaN(validUntil)) return undefined
	if (validUntil - issued > MAX_LIFETIME_MS) validUntil = issued + MAX_LIFETIME_MS
	return { payload: p, validUntil }
}
