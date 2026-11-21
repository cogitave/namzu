/**
 * Machine identity: one Ed25519 key pair per machine, and the small helpers
 * every other module of the Namzu network uses to name and sign with it.
 *
 * Nothing here implements a cryptographic primitive; it is `node:crypto`
 * (`generateKeyPairSync`, `sign`, `verify`, `createHash`) with fixed
 * encodings so that two machines always compute the same id from the same key.
 *
 * - `machineId`: lowercase hex sha256 of the public key's SPKI DER (64 hex).
 * - `netId`: the first 16 hex of the same digest over the FOUNDER's key. It is
 *   not secret and not a name.
 *
 * @experimental
 */

import {
	type KeyObject,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
} from 'node:crypto'

export interface MachineKey {
	readonly privateKey: KeyObject
	readonly publicKey: KeyObject
	/** SPKI DER of the public key. */
	readonly publicKeyDer: Buffer
	readonly machineId: string
}

const NET_ID_LENGTH = 16

export function sha256Hex(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex')
}

/** The id of a machine, from the SPKI DER of its public key. */
export function machineIdOf(publicKeyDer: Buffer): string {
	return sha256Hex(publicKeyDer)
}

/** The id of a network, from the SPKI DER of its founder's public key. */
export function netIdOf(founderPublicKeyDer: Buffer): string {
	return sha256Hex(founderPublicKeyDer).slice(0, NET_ID_LENGTH)
}

/** Short form of a machine id for a screen. */
export function shortMachineId(machineId: string): string {
	return machineId.slice(0, 12)
}

function fromPrivateKey(privateKey: KeyObject): MachineKey {
	const publicKey = createPublicKey(privateKey)
	const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
	return {
		privateKey,
		publicKey,
		publicKeyDer,
		machineId: machineIdOf(publicKeyDer),
	}
}

export function generateMachineKey(): MachineKey {
	return fromPrivateKey(generateKeyPairSync('ed25519').privateKey)
}

/** PKCS#8 PEM of the private key. The only place a private key is serialised; callers write it 0600 and never log it. */
export function exportMachineKeyPem(key: MachineKey): string {
	return key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

export function importMachineKeyPem(pem: string): MachineKey {
	const privateKey = createPrivateKey(pem)
	if (privateKey.asymmetricKeyType !== 'ed25519') {
		throw new Error('The machine key is not an Ed25519 key.')
	}
	return fromPrivateKey(privateKey)
}

export function publicKeyFromDer(der: Buffer): KeyObject {
	return createPublicKey({ key: der, type: 'spki', format: 'der' })
}

export function signBytes(key: MachineKey, data: Buffer): Buffer {
	return sign(null, data, key.privateKey)
}

/** False for any malformed key or signature rather than throwing. */
export function verifyBytes(publicKeyDer: Buffer, data: Buffer, signature: Buffer): boolean {
	try {
		return verify(null, data, publicKeyFromDer(publicKeyDer), signature)
	} catch {
		return false
	}
}
