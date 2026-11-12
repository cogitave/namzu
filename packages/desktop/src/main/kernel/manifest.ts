import { createPublicKey, verify } from 'node:crypto'
import { type KernelPublicKey, isKeyId } from './keys.js'
import { isKernelVersion } from './version.js'

/** The signed description of the newest engine (kernel-<channel>.json) and its signature. */

export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_BUNDLE_BYTES = 2 * 1024 ** 3
export const MAX_UNPACKED_BYTES = 8 * 1024 ** 3
export const MAX_FILE_COUNT = 200_000
const MAX_WITHDRAWN = 1000
const MAX_BUNDLES = 16

export type ManifestErrorCode =
	| 'signature-format'
	| 'unknown-key'
	| 'bad-signature'
	| 'manifest-format'

export class ManifestError extends Error {
	constructor(
		readonly code: ManifestErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'ManifestError'
	}
}

export interface BundleEntry {
	file: string
	size: number
	sha512: string
	filesSha512: string
	fileCount: number
	unpackedSize: number
}

export interface KernelManifest {
	schema: 1
	channel: string
	sequence: number
	issuedAt: number
	expiresAt: number
	minimumKernel: string
	withdrawn: string[]
	kernel: {
		commandLine: string
		engine: string
		desktopContract: number
		dataEpoch: number
		bundles: Record<string, BundleEntry>
	}
}

export interface SignatureFile {
	schema: 1
	keyId: string
	algorithm: 'ed25519'
	signature: string
}

const HEX_128 = /^[0-9a-f]{128}$/u
const BARE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/u
const BUNDLE_KEY = /^[a-z0-9]+-[a-z0-9]+$/u
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u

function fail(code: ManifestErrorCode, message: string): never {
	throw new ManifestError(code, message)
}

function object(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		fail('manifest-format', `${where} is not an object.`)
	const record = value as Record<string, unknown>
	for (const key of Object.keys(record))
		if (!keys.includes(key)) fail('manifest-format', `Unknown field ${where}.${key}.`)
	for (const key of keys)
		if (!(key in record)) fail('manifest-format', `Missing field ${where}.${key}.`)
	return record
}

function integer(
	value: unknown,
	where: string,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		fail('manifest-format', `${where} is not an acceptable whole number.`)
	return value
}

function version(value: unknown, where: string): string {
	if (!isKernelVersion(value)) fail('manifest-format', `${where} is not a version.`)
	return value
}

function time(value: unknown, where: string): number {
	if (typeof value !== 'string' || !ISO_SECONDS.test(value))
		fail('manifest-format', `${where} is not a time.`)
	const ms = Date.parse(value)
	if (!Number.isFinite(ms)) fail('manifest-format', `${where} is not a time.`)
	return ms
}

function parseJson(bytes: Uint8Array, code: ManifestErrorCode, what: string): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		return fail(code, `${what} is not valid JSON.`)
	}
}

/** Strict: a field that is not named here refuses the whole file. */
export function parseManifest(bytes: Uint8Array): KernelManifest {
	if (bytes.length > MAX_MANIFEST_BYTES) fail('manifest-format', 'The manifest is too large.')
	const top = object(parseJson(bytes, 'manifest-format', 'The manifest'), 'manifest', [
		'schema',
		'channel',
		'sequence',
		'issuedAt',
		'expiresAt',
		'minimumKernel',
		'withdrawn',
		'kernel',
	])
	if (top.schema !== 1) fail('manifest-format', 'Unknown manifest schema.')
	if (typeof top.channel !== 'string' || !CHANNEL.test(top.channel))
		fail('manifest-format', 'channel is not a channel name.')
	const issuedAt = time(top.issuedAt, 'issuedAt')
	const expiresAt = time(top.expiresAt, 'expiresAt')
	if (expiresAt <= issuedAt) fail('manifest-format', 'expiresAt is not after issuedAt.')
	if (!Array.isArray(top.withdrawn) || top.withdrawn.length > MAX_WITHDRAWN)
		fail('manifest-format', 'withdrawn is not a short list.')
	const withdrawn = top.withdrawn.map((entry, index) => version(entry, `withdrawn[${index}]`))
	const kernel = object(top.kernel, 'kernel', [
		'commandLine',
		'engine',
		'desktopContract',
		'dataEpoch',
		'bundles',
	])
	const bundlesRaw = kernel.bundles
	if (!bundlesRaw || typeof bundlesRaw !== 'object' || Array.isArray(bundlesRaw))
		fail('manifest-format', 'bundles is not an object.')
	const names = Object.keys(bundlesRaw)
	if (names.length === 0 || names.length > MAX_BUNDLES)
		fail('manifest-format', 'bundles holds no entry or too many.')
	const bundles: Record<string, BundleEntry> = Object.create(null)
	for (const name of names) {
		if (!BUNDLE_KEY.test(name)) fail('manifest-format', `Bad bundle key ${name}.`)
		const entry = object((bundlesRaw as Record<string, unknown>)[name], `bundles.${name}`, [
			'file',
			'size',
			'sha512',
			'filesSha512',
			'fileCount',
			'unpackedSize',
		])
		if (typeof entry.file !== 'string' || !BARE_FILE.test(entry.file) || entry.file.includes('..'))
			fail('manifest-format', `bundles.${name}.file is not a bare file name.`)
		if (typeof entry.sha512 !== 'string' || !HEX_128.test(entry.sha512))
			fail('manifest-format', `bundles.${name}.sha512 is not a hash.`)
		if (typeof entry.filesSha512 !== 'string' || !HEX_128.test(entry.filesSha512))
			fail('manifest-format', `bundles.${name}.filesSha512 is not a hash.`)
		bundles[name] = {
			file: entry.file,
			size: integer(entry.size, `bundles.${name}.size`, 1, MAX_BUNDLE_BYTES),
			sha512: entry.sha512,
			filesSha512: entry.filesSha512,
			fileCount: integer(entry.fileCount, `bundles.${name}.fileCount`, 1, MAX_FILE_COUNT),
			unpackedSize: integer(
				entry.unpackedSize,
				`bundles.${name}.unpackedSize`,
				0,
				MAX_UNPACKED_BYTES,
			),
		}
	}
	return {
		schema: 1,
		channel: top.channel,
		sequence: integer(top.sequence, 'sequence', 0),
		issuedAt,
		expiresAt,
		minimumKernel: version(top.minimumKernel, 'minimumKernel'),
		withdrawn,
		kernel: {
			commandLine: version(kernel.commandLine, 'kernel.commandLine'),
			engine: version(kernel.engine, 'kernel.engine'),
			desktopContract: integer(kernel.desktopContract, 'kernel.desktopContract', 1, 1_000_000),
			dataEpoch: integer(kernel.dataEpoch, 'kernel.dataEpoch', 1, 1_000_000),
			bundles,
		},
	}
}

export function parseSignatureFile(bytes: Uint8Array): SignatureFile {
	if (bytes.length > MAX_MANIFEST_BYTES)
		fail('signature-format', 'The signature file is too large.')
	const value = parseJson(bytes, 'signature-format', 'The signature file')
	if (!value || typeof value !== 'object' || Array.isArray(value))
		fail('signature-format', 'The signature file is not an object.')
	const record = value as Record<string, unknown>
	for (const key of Object.keys(record))
		if (!['schema', 'keyId', 'algorithm', 'signature'].includes(key))
			fail('signature-format', `Unknown field ${key} in the signature file.`)
	if (record.schema !== 1) fail('signature-format', 'Unknown signature schema.')
	if (record.algorithm !== 'ed25519') fail('signature-format', 'Unknown signature algorithm.')
	if (!isKeyId(record.keyId)) fail('signature-format', 'keyId is not a key id.')
	if (typeof record.signature !== 'string') fail('signature-format', 'signature is not text.')
	return {
		schema: 1,
		keyId: record.keyId,
		algorithm: 'ed25519',
		signature: record.signature,
	}
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** The key object for 32 raw public key bytes, or undefined when they are not that. */
export function ed25519KeyFromRaw(base64: string) {
	const raw = Buffer.from(base64, 'base64')
	if (raw.length !== 32 || raw.toString('base64') !== base64) return undefined
	try {
		return createPublicKey({
			key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
			format: 'der',
			type: 'spki',
		})
	} catch {
		return undefined
	}
}

/**
 * Checks the signature over the exact bytes served, with the key the signature file names,
 * then reads the manifest strictly. Nothing in the manifest is looked at before the
 * signature holds.
 */
export function verifyManifest(
	manifestBytes: Uint8Array,
	signatureBytes: Uint8Array,
	keys: readonly KernelPublicKey[],
): { manifest: KernelManifest; keyId: string } {
	const signature = parseSignatureFile(signatureBytes)
	const key = keys.find((candidate) => candidate.id === signature.keyId)
	if (!key) fail('unknown-key', `No trusted key named ${signature.keyId}.`)
	const publicKey = ed25519KeyFromRaw(key.publicKey)
	if (!publicKey) fail('unknown-key', 'The trusted key is not an Ed25519 public key.')
	const raw = Buffer.from(signature.signature, 'base64')
	if (raw.length !== 64 || raw.toString('base64') !== signature.signature)
		fail('signature-format', 'The signature is not 64 bytes of base64.')
	let ok = false
	try {
		ok = verify(null, manifestBytes, publicKey, raw)
	} catch {
		ok = false
	}
	if (!ok) fail('bad-signature', 'The signature does not match the manifest.')
	return { manifest: parseManifest(manifestBytes), keyId: key.id }
}

/** `<platform>-<arch>`, the key of a bundle. */
export function bundleKey(platform: string, arch: string): string {
	return `${platform}-${arch}`
}
