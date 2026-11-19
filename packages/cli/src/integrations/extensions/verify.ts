import { verify as edVerify } from 'node:crypto'
import { canon, sha256Hex } from './canon.js'
import { ExtensionError } from './errors.js'
import { type TrustedKey, ed25519KeyFromRaw, isDevKeyId } from './keys.js'
import { licenceVerifier } from './license/kind.js'
import { uiFiles } from './manifest-r2.js'
import { parseManifest } from './manifest.js'
import type { PackageFile } from './package.js'
import type { Manifest } from './types.js'

/** The three ASCII lines a package signature covers: the manifest and every file's hash, under a domain line. */
export function signedStatement(manifestBytes: Uint8Array, filesBytes: Uint8Array): Buffer {
	return Buffer.from(
		`namzu-extension/1\nmanifest-sha256:${sha256Hex(manifestBytes)}\nfiles-sha256:${sha256Hex(filesBytes)}\n`,
		'ascii',
	)
}

export interface FileList {
	readonly schema: 1
	readonly files: Readonly<Record<string, { readonly sha256: string; readonly size: number }>>
}

export interface VerifiedPackage {
	readonly manifest: Manifest
	readonly manifestBytes: Buffer
	readonly keyId: string
	readonly dev: boolean
	readonly files: Map<string, PackageFile>
}

const MANIFEST = 'namzu-extension.json'
const LIST = 'files.sha256.json'
const SIGNATURE = 'signatures/manifest.sig'

/** The files a hash list covers: everything except the manifest, the list itself and the signatures. */
const covered = (name: string): boolean => name !== MANIFEST && name !== LIST && name !== SIGNATURE

function parseSignature(bytes: Buffer): { keyId: string; signature: Buffer } {
	const fail = (m: string): never => {
		throw new ExtensionError('signature-invalid', 'signature-form', m)
	}
	const text = bytes.toString('utf8')
	let j: Record<string, unknown>
	try {
		j = JSON.parse(text)
	} catch {
		return fail('The signature file is not valid JSON.')
	}
	if (text !== `${canon(j)}\n`) fail('The signature file is not in the compact form.')
	const keys = Object.keys(j).sort().join(',')
	if (keys !== 'algorithm,keyId,schema,signature') fail('The signature file has the wrong fields.')
	if (
		j.schema !== 1 ||
		j.algorithm !== 'ed25519' ||
		typeof j.keyId !== 'string' ||
		typeof j.signature !== 'string'
	)
		fail('The signature file has the wrong values.')
	const signature = Buffer.from(j.signature as string, 'base64')
	if (signature.length !== 64) fail('The signature is not 64 bytes.')
	return { keyId: j.keyId as string, signature }
}

/**
 * Package verification, in the order of the format: signature file form, trusted key, signature, only
 * then the manifest (strictly), the key's publisher and prefixes, and finally every file's hash. Each
 * step fails closed with a named check; nothing is installed from a package that fails one.
 */
export function verifyPackage(
	files: Map<string, PackageFile>,
	trusted: readonly TrustedKey[],
): VerifiedPackage {
	const need = (name: string): Buffer => {
		const f = files.get(name)
		if (!f) throw new ExtensionError('bad-package', 'missing-file', `The package has no ${name}.`)
		return f.bytes
	}
	const manifestBytes = need(MANIFEST)
	const listBytes = need(LIST)
	const { keyId, signature } = parseSignature(need(SIGNATURE))
	if (trusted.length === 0)
		throw new ExtensionError(
			'untrusted-publisher',
			'trusted-key',
			'No trusted publisher keys in this build, so no package can be added.',
		)
	const key = trusted.find((k) => k.id === keyId)
	if (!key) {
		const hint = isDevKeyId(keyId)
			? ' A test key is trusted only with NAMZU_EXTENSION_DEV=1 and NAMZU_EXTENSION_TEST_PUBLIC_KEY set.'
			: ''
		throw new ExtensionError(
			'untrusted-publisher',
			'trusted-key',
			`This file was not signed by a publisher Namzu trusts (key ${keyId}).${hint}`,
		)
	}
	const ok = edVerify(
		null,
		signedStatement(manifestBytes, listBytes),
		ed25519KeyFromRaw(key.publicKey),
		signature,
	)
	if (!ok)
		throw new ExtensionError('tampered', 'signature', 'This file was changed after it was signed.')
	const parsed = parseManifest(manifestBytes)
	if (!parsed.ok) {
		const first = parsed.issues[0]
		throw new ExtensionError(
			'manifest-invalid',
			first?.rule ?? 'manifest',
			`The manifest is refused (${first?.rule} ${first?.path}): ${first?.message}`,
		)
	}
	const manifest = parsed.manifest
	if (manifest.signing.publisherKeyId !== keyId)
		throw new ExtensionError(
			'untrusted-publisher',
			'key-id',
			'The manifest names a different signing key than the one that signed it.',
		)
	if (!key.dev) {
		if (key.publisher !== manifest.publisher.id)
			throw new ExtensionError(
				'untrusted-publisher',
				'publisher',
				'The signing key belongs to a different publisher than the manifest names.',
			)
		if (!key.idPrefixes.some((p) => manifest.id.startsWith(p)))
			throw new ExtensionError(
				'untrusted-publisher',
				'id-prefix',
				`The key may not sign the id ${manifest.id}.`,
			)
	}
	checkHashes(files, listBytes)
	checkPackageFiles(manifest, files)
	return { manifest, manifestBytes, keyId, dev: key.dev === true, files }
}

/** Every file against the signed list: none unlisted, none missing, hash and size equal. */
export function checkHashes(files: Map<string, PackageFile>, listBytes: Buffer): void {
	let list: FileList
	try {
		list = JSON.parse(listBytes.toString('utf8'))
	} catch {
		throw new ExtensionError('bad-package', 'file-list', 'files.sha256.json is not valid JSON.')
	}
	if (list.schema !== 1 || !list.files || typeof list.files !== 'object')
		throw new ExtensionError('bad-package', 'file-list', 'files.sha256.json has the wrong shape.')
	for (const name of files.keys()) {
		if (covered(name) && !Object.hasOwn(list.files, name))
			throw new ExtensionError(
				'tampered',
				'unlisted-file',
				`${name} is in the package but not in the signed list.`,
			)
	}
	for (const [name, want] of Object.entries(list.files)) {
		const f = files.get(name)
		if (!f)
			throw new ExtensionError(
				'tampered',
				'missing-file',
				`${name} is in the signed list but not in the package.`,
			)
		if (f.bytes.length !== want.size || sha256Hex(f.bytes) !== want.sha256)
			throw new ExtensionError('tampered', 'file-hash', `${name} was changed after it was signed.`)
	}
}

const ICON_MAX_BYTES = 32 * 1024
const UNSAFE_SVG =
	/<\s*script|\son[a-z]+\s*=|<\s*foreignObject|(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:|data:text)|@import|url\(\s*["']?\s*https?:/i

/** Files the manifest names exist, notice hashes agree, executables are files with the execute bit (K1, K2). */
export function checkPackageFiles(m: Manifest, files: Map<string, PackageFile>): void {
	const miss = (f: string, why: string): never => {
		throw new ExtensionError('manifest-invalid', 'K1', `${f} ${why}`)
	}
	for (const [locale, n] of Object.entries(m.legal.notices)) {
		const f = files.get(n.file)
		if (!f) miss(n.file, 'is named in the manifest but not in the package (K1).')
		else {
			if (sha256Hex(f.bytes) !== n.sha256)
				miss(n.file, `does not match the hash the manifest gives for the ${locale} notice (K1).`)
			const first = f.bytes.toString('utf8').split('\n', 1)[0] ?? ''
			const tag = /^<!--\s*locale:\s*([A-Za-z-]+)\s*-->/.exec(first)?.[1]
			if (tag !== locale) miss(n.file, `must start with <!-- locale: ${locale} --> (L4).`)
		}
	}
	for (const f of [
		...(licenceVerifier(m) ? [(licenceVerifier(m) as { keyFile: string }).keyFile] : []),
		...m.contributes.endpoint.queries.map((q) => q.schema),
		...(m.contributes.endpoint.actions ?? []).flatMap((a) => [a.paramsSchema, a.schema]),
		...uiFiles(m),
	])
		if (!files.has(f)) miss(f, 'is named in the manifest but not in the package (K1).')
	// An icon is shown as an image only: small, and an SVG holds nothing that runs or loads (K1).
	const icons = [
		m.ui?.icon,
		...(m.ui?.pages ?? []).map((p) => p.icon),
		...(m.ui?.chips ?? []).flatMap((c) => Object.values(c.states).map((s) => s.icon)),
	].filter((x): x is string => typeof x === 'string')
	for (const f of icons) {
		const bytes = files.get(f)?.bytes
		if (!bytes) continue
		if (bytes.length > ICON_MAX_BYTES) miss(f, 'is an icon larger than 32 KiB (K1).')
		if (/\.svg$/i.test(f) && UNSAFE_SVG.test(bytes.toString('utf8')))
			miss(
				f,
				'is an SVG with script, an event attribute, foreignObject or an external reference (K1).',
			)
	}
	const exes = [
		...Object.values(m.entry.process.command),
		...Object.values(m.entry.maintenance?.command ?? {}),
	].map((c) => c.exe)
	for (const exe of exes) {
		const f = files.get(exe)
		if (!f) miss(exe, 'is named in the manifest but not in the package (K1).')
		else if (!f.executable && process.platform !== 'win32')
			miss(exe, 'must be a file with the execute bit set in the package (K2).')
	}
}
