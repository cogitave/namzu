import { verify as edVerify } from 'node:crypto'
import { canon } from '../canon.js'
import { ed25519KeyFromRaw, isDevKeyId } from '../keys.js'
import type { Manifest } from '../types.js'

export interface LicensePayload {
	readonly v: 1
	readonly licenseId: string
	readonly extensionId: string
	readonly customer: { readonly id: string; readonly name: string }
	readonly seats: number
	readonly issuedAt: string
	readonly notBefore: string
	readonly expires: string
	readonly features: readonly string[]
}

export type LicenseResult =
	| {
			ok: true
			payload: LicensePayload
			expiresAt: number
			graceDaysLeft?: number
	  }
	| {
			ok: false
			code:
				| 'malformed'
				| 'wrong-key'
				| 'signature'
				| 'wrong-extension'
				| 'not-yet-valid'
				| 'expired'
				| 'claim-missing'
				| 'clock-rolled-back'
				| 'revoked'
			message: string
	  }

const DAY = 86_400_000

/** The licence key file a package carries: `{keyId, algorithm, publicKey}` (covered by the package signature). */
export interface LicenseVerifierKey {
	readonly keyId: string
	readonly algorithm: 'ed25519'
	readonly publicKey: string
}

export function parseLicenseKeyFile(text: string): LicenseVerifierKey | undefined {
	try {
		const j = JSON.parse(text)
		if (typeof j.keyId === 'string' && j.algorithm === 'ed25519' && typeof j.publicKey === 'string')
			return j
	} catch {
		// fall through
	}
	return undefined
}

/**
 * The licence checks: signature over `namzu-license/1\n` + payload, the key the package names, the
 * extension, the window (`notBefore <= now < expires + grace`), the claims the manifest requires, and
 * a clock rolled back more than 24 hours behind the latest time the host has seen.
 */
export function checkLicense(input: {
	readonly text: string
	readonly manifest: Manifest
	readonly verifierKey: LicenseVerifierKey
	readonly now: number
	readonly highWater?: number
	readonly devMode: boolean
}): LicenseResult {
	const { text, manifest, verifierKey, now } = input
	const licensing = manifest.licensing
	const fail = (
		code: Extract<LicenseResult, { ok: false }>['code'],
		message: string,
	): LicenseResult => ({ ok: false, code, message })
	if (licensing.kind !== 'key')
		return fail('malformed', 'This extension does not use a licence key file.')
	let l: Record<string, unknown>
	let payload: LicensePayload
	let payloadBytes: Buffer
	try {
		l = JSON.parse(text)
		if (
			l.schema !== 1 ||
			l.algorithm !== 'ed25519' ||
			typeof l.keyId !== 'string' ||
			typeof l.payload !== 'string' ||
			typeof l.signature !== 'string'
		)
			return fail('malformed', 'The licence file has the wrong fields.')
		payloadBytes = Buffer.from(l.payload, 'base64url')
		payload = JSON.parse(payloadBytes.toString('utf8'))
		if (canon(payload) !== payloadBytes.toString('utf8'))
			return fail('malformed', 'The licence payload is not in the canonical form.')
	} catch {
		return fail('malformed', 'The licence file is not readable.')
	}
	if (l.keyId !== verifierKey.keyId || l.keyId !== licensing.verifier.keyId)
		return fail('wrong-key', 'This licence was not issued with the key this extension names.')
	if (isDevKeyId(l.keyId as string) && !input.devMode)
		return fail('wrong-key', 'A test licence key is accepted only in developer mode.')
	let ok = false
	try {
		ok = edVerify(
			null,
			Buffer.concat([Buffer.from('namzu-license/1\n'), payloadBytes]),
			ed25519KeyFromRaw(verifierKey.publicKey),
			Buffer.from(l.signature as string, 'base64'),
		)
	} catch {
		ok = false
	}
	if (!ok)
		return fail(
			'signature',
			'The licence signature does not verify: the file was changed or is not a licence.',
		)
	if (payload.extensionId !== manifest.id)
		return fail(
			'wrong-extension',
			`This licence is for ${payload.extensionId}, not for this extension.`,
		)
	for (const claim of licensing.claims) {
		if (claim === 'customer' && !payload.customer)
			return fail('claim-missing', 'The licence has no customer.')
		if (claim === 'seats' && typeof payload.seats !== 'number')
			return fail('claim-missing', 'The licence has no seat count.')
		if (claim === 'expires' && !payload.expires)
			return fail('claim-missing', 'The licence has no expiry.')
		if (claim === 'features' && !Array.isArray(payload.features))
			return fail('claim-missing', 'The licence has no feature list.')
	}
	if (input.highWater !== undefined && now < input.highWater - DAY)
		return fail(
			'clock-rolled-back',
			'The computer clock is more than a day behind the last time Namzu saw it. Set the clock right.',
		)
	const notBefore = Date.parse(payload.notBefore)
	const expiresAt = Date.parse(payload.expires) + licensing.graceDays * DAY
	if (Number.isNaN(notBefore) || Number.isNaN(expiresAt))
		return fail('malformed', 'The licence dates are not readable.')
	if (now < notBefore) return fail('not-yet-valid', 'This licence is not valid yet.')
	if (now >= expiresAt) return fail('expired', 'This licence has expired.')
	return { ok: true, payload, expiresAt }
}
