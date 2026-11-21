import { type KeyObject, createPublicKey } from 'node:crypto'

/** A publisher's Ed25519 key as the build ships it, or as a test names it. */
export interface TrustedKey {
	readonly id: string
	readonly publisher: string
	readonly idPrefixes: readonly string[]
	/** Raw 32-byte public key, base64. */
	readonly publicKey: string
	readonly dev?: boolean
}

/**
 * Publisher keys compiled into this build. A package must be signed by one of these, by a key whose
 * publisher is the manifest's `publisher.id` and whose id prefixes cover the manifest's id.
 * Rotation: add the new key beside the old, release, sign with the new one, drop the old later.
 */
export const EXTENSION_PUBLISHER_KEYS: readonly TrustedKey[] = [
	{
		// Cogitave's production key (2026). The private half never leaves the publisher's signing environment.
		id: 'cogitave-2026',
		publisher: 'cogitave',
		idPrefixes: ['com.cogitave.'],
		publicKey: 'oJsXwUHBMxv7izC/fk97c0P/8j//Mp2gUS65mnUl6Xg=',
	},
]

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function ed25519KeyFromRaw(base64: string): KeyObject {
	const raw = Buffer.from(base64, 'base64')
	if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes')
	return createPublicKey({
		key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
		format: 'der',
		type: 'spki',
	})
}

export const isDevKeyId = (id: string): boolean => id.startsWith('dev-')

/**
 * The keys this process trusts. A dev key counts only when BOTH `NAMZU_EXTENSION_DEV=1` and
 * `NAMZU_EXTENSION_TEST_PUBLIC_KEY=<keyId>:<base64>` are set, the way the kernel feed treats its
 * test key; never by default and never through a button.
 */
export function trustedKeys(
	env: NodeJS.ProcessEnv = process.env,
	compiled: readonly TrustedKey[] = EXTENSION_PUBLISHER_KEYS,
): TrustedKey[] {
	const keys: TrustedKey[] = compiled.filter((k) => !isDevKeyId(k.id))
	if (env.NAMZU_EXTENSION_DEV === '1' && env.NAMZU_EXTENSION_TEST_PUBLIC_KEY) {
		const raw = env.NAMZU_EXTENSION_TEST_PUBLIC_KEY
		const at = raw.indexOf(':')
		if (at > 0) {
			const id = raw.slice(0, at)
			const publicKey = raw.slice(at + 1)
			try {
				ed25519KeyFromRaw(publicKey)
				keys.push({ id, publisher: '*', idPrefixes: [''], publicKey, dev: true })
			} catch {
				// a malformed test key is ignored: nothing is trusted because of it
			}
		}
	}
	return keys
}

export const devModeOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
	env.NAMZU_EXTENSION_DEV === '1'
