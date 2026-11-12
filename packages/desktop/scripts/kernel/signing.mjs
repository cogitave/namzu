// Ed25519 signing of the manifest (specification 3.5, 4.4) and the public key list (4.5, 4.6).
// The private key is read from the environment, held in memory for one call and never written,
// printed, passed on a command line or put in an error message: every failure here says what kind of
// value was wrong, never the value.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SIGNING_KEY_ENV = 'NAMZU_KERNEL_SIGNING_KEY'
export const DEFAULT_KEYS_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'kernel-keys.json',
)

export class SigningError extends Error {
	constructor(message) {
		super(message)
		this.name = 'SigningError'
	}
}

// The same rule as the app's reader: a key id is a short plain name.
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** The raw 32 bytes of an Ed25519 public key, as base64: the form the app compiles in. */
export function rawPublicKey(publicKeyObject) {
	return publicKeyObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
}

/** An Ed25519 public KeyObject from base64 of its 32 raw bytes. */
export function publicKeyFromRaw(base64) {
	const raw = Buffer.from(base64, 'base64')
	if (raw.length !== 32 || raw.toString('base64') !== base64)
		throw new SigningError('A public key must be the base64 of exactly 32 bytes.')
	return createPublicKey({
		key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
		format: 'der',
		type: 'spki',
	})
}

/**
 * The private key from a PKCS#8 PEM, or base64 of that PEM, or base64 of the PKCS#8 DER. Anything
 * else is refused without echoing it.
 */
export function privateKeyFromText(text) {
	const value = (text ?? '').trim()
	if (value === '') throw new SigningError(`${SIGNING_KEY_ENV} is empty or not set.`)
	let key
	try {
		if (value.startsWith('-----BEGIN')) key = createPrivateKey({ key: value, format: 'pem' })
		else {
			const decoded = Buffer.from(value, 'base64')
			key = decoded.toString('latin1').startsWith('-----BEGIN')
				? createPrivateKey({ key: decoded.toString('utf8'), format: 'pem' })
				: createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' })
		}
	} catch {
		throw new SigningError(
			`${SIGNING_KEY_ENV} is not a PKCS#8 private key (PEM, or base64 of the PEM).`,
		)
	}
	if (key.asymmetricKeyType !== 'ed25519')
		throw new SigningError(`${SIGNING_KEY_ENV} is not an Ed25519 key.`)
	return key
}

/** The signing key named by an environment, or a SigningError. */
export const privateKeyFromEnv = (env = process.env) => privateKeyFromText(env[SIGNING_KEY_ENV])

/** The public key list: a JSON array of `{ id, publicKey }`, checked entry by entry. */
export function parseKeyList(text, where = 'the key list') {
	let value
	try {
		value = JSON.parse(text)
	} catch {
		throw new SigningError(`${where} is not valid JSON.`)
	}
	if (!Array.isArray(value))
		throw new SigningError(`${where} must be a JSON array of { "id", "publicKey" }.`)
	const ids = new Set()
	return value.map((entry) => {
		if (
			entry === null ||
			typeof entry !== 'object' ||
			Object.keys(entry).sort().join() !== 'id,publicKey' ||
			typeof entry.id !== 'string' ||
			!KEY_ID.test(entry.id)
		)
			throw new SigningError(`${where} has an entry that is not { "id", "publicKey" }.`)
		if (ids.has(entry.id)) throw new SigningError(`${where} lists the id "${entry.id}" twice.`)
		ids.add(entry.id)
		return { id: entry.id, publicKey: entry.publicKey, key: publicKeyFromRaw(entry.publicKey) }
	})
}

export function readKeyList(file = DEFAULT_KEYS_FILE) {
	let text
	try {
		text = readFileSync(file, 'utf8')
	} catch {
		throw new SigningError(`The public key list ${file} cannot be read.`)
	}
	return parseKeyList(text, file)
}

/** The signature file (3.5) for exact manifest bytes. Returns its bytes. */
export function signManifest(manifestBytes, privateKey, keyId) {
	if (!KEY_ID.test(keyId ?? ''))
		throw new SigningError(
			'The key id must be 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or digit.',
		)
	const signature = sign(null, manifestBytes, privateKey).toString('base64')
	return Buffer.from(`${JSON.stringify({ schema: 1, keyId, algorithm: 'ed25519', signature })}\n`)
}

/** The id the list gives to the public half of this private key, or undefined. */
export function keyIdFor(privateKey, keys) {
	const mine = rawPublicKey(createPublicKey(privateKey))
	return keys.find((entry) => entry.publicKey === mine)?.id
}

/**
 * Check a signature file against manifest bytes and a key list. Returns `{ keyId }`; throws a
 * SigningError that says which check failed. An empty list always fails.
 */
export function verifySignature(manifestBytes, signatureBytes, keys) {
	if (keys.length === 0)
		throw new SigningError('The public key list is empty, so nothing can be verified.')
	let value
	try {
		value = JSON.parse(signatureBytes.toString('utf8'))
	} catch {
		throw new SigningError('The signature file is not valid JSON.')
	}
	if (
		value === null ||
		typeof value !== 'object' ||
		Object.keys(value).join() !== 'schema,keyId,algorithm,signature' ||
		value.schema !== 1 ||
		value.algorithm !== 'ed25519' ||
		typeof value.keyId !== 'string' ||
		typeof value.signature !== 'string'
	)
		throw new SigningError(
			'The signature file does not have the shape { schema: 1, keyId, algorithm: "ed25519", signature }.',
		)
	// Compact JSON, the fields in the order of the text and one newline: one reading only (7.6).
	if (signatureBytes.toString('utf8') !== `${JSON.stringify(value)}\n`)
		throw new SigningError(
			'The signature file is not in the exact form of the text (compact JSON, fields in order, one newline).',
		)
	const entry = keys.find((candidate) => candidate.id === value.keyId)
	if (!entry)
		throw new SigningError(
			`The signature names the key "${value.keyId}", which is not in the public key list.`,
		)
	const signature = Buffer.from(value.signature, 'base64')
	if (signature.length !== 64 || signature.toString('base64') !== value.signature)
		throw new SigningError('The signature is not the base64 of 64 bytes.')
	if (!verify(null, manifestBytes, entry.key, signature))
		throw new SigningError(
			`The signature does not match these manifest bytes under the key "${value.keyId}".`,
		)
	return { keyId: value.keyId }
}

/** A new key pair: `{ privatePem, entry: { id, publicKey } }`. */
export function makeKeyPair(id) {
	if (!KEY_ID.test(id))
		throw new SigningError(
			'The key id must be 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or digit.',
		)
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	return {
		privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
		entry: { id, publicKey: rawPublicKey(publicKey) },
	}
}
