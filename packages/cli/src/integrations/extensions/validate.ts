import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionError } from './errors.js'
import type { TrustedKey } from './keys.js'
import { parseManifest } from './manifest.js'
import { type PackageFile, openPackage } from './package.js'
import type { ManifestIssue } from './types.js'
import { checkHashes, checkPackageFiles, verifyPackage } from './verify.js'

/** `namzu extension validate`: the developer's check. Runs nothing from the target and installs nothing. */
export interface ValidationReport {
	readonly kind: 'folder' | 'package'
	readonly ok: boolean
	readonly issues: ManifestIssue[]
	/** What was and was not proven about the signature. */
	readonly signature: string
	readonly id?: string
	readonly version?: string
	/** What is not wrong enough to refuse but should be fixed, such as a package file name off the convention. */
	readonly warnings?: string[]
}

/** The convention for a package file: `<id>-<version>-<platform>.nzx`. Returns a sentence when it is not followed. */
export function packageNameWarning(
	fileName: string,
	id: string,
	version: string,
	platforms: readonly string[],
): string | undefined {
	const base = fileName.split(/[\\/]/).pop() ?? fileName
	if (platforms.some((p) => base === `${id}-${version}-${p}.nzx`)) return undefined
	const example = `${id}-${version}-${platforms[0] ?? 'win32-x64'}.nzx`
	return `the package file is named ${base}; name it <id>-<version>-<platform>.nzx, for example ${example}, so a person can tell which extension, version and platform it is`
}

const fromError = (e: unknown): ManifestIssue => {
	if (e instanceof ExtensionError) return { rule: e.check, path: '', message: e.message }
	return { rule: 'V', path: '', message: (e as Error).message }
}

export function validateFolder(dir: string): ValidationReport {
	const file = join(dir, 'namzu-extension.json')
	if (!existsSync(file))
		return {
			kind: 'folder',
			ok: false,
			issues: [{ rule: 'V', path: '', message: 'there is no namzu-extension.json in this folder' }],
			signature: 'not checked (a folder is not signed)',
		}
	const parsed = parseManifest(readFileSync(file))
	if (!parsed.ok)
		return {
			kind: 'folder',
			ok: false,
			issues: parsed.issues,
			signature: 'not checked (a folder is not signed)',
		}
	const files = new Map<string, PackageFile>()
	const walk = (d: string, prefix: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const abs = join(d, e.name)
			const rel = prefix ? `${prefix}/${e.name}` : e.name
			if (e.isSymbolicLink()) continue
			if (e.isDirectory()) walk(abs, rel)
			else
				files.set(rel, { bytes: readFileSync(abs), executable: (statSync(abs).mode & 0o111) !== 0 })
		}
	}
	walk(dir, '')
	const issues: ManifestIssue[] = []
	try {
		checkPackageFiles(parsed.manifest, files)
	} catch (e) {
		issues.push(fromError(e))
	}
	return {
		kind: 'folder',
		ok: issues.length === 0,
		issues,
		signature: 'not checked (a folder is not signed)',
		id: parsed.manifest.id,
		version: parsed.manifest.version,
	}
}

export function validatePackage(
	bytes: Buffer,
	trusted: readonly TrustedKey[],
	fileName?: string,
): ValidationReport {
	const r = validatePackageBytes(bytes, trusted)
	if (fileName === undefined || !r.id || !r.version) return r
	let platforms: readonly string[] = []
	try {
		const m = openPackage(bytes).get('namzu-extension.json')?.bytes
		const parsed = m ? parseManifest(m) : undefined
		if (parsed?.ok) platforms = parsed.manifest.platforms
	} catch {
		// a package that cannot be opened has already been refused above
	}
	const w = packageNameWarning(fileName, r.id, r.version, platforms)
	return w ? { ...r, warnings: [w] } : r
}

function validatePackageBytes(bytes: Buffer, trusted: readonly TrustedKey[]): ValidationReport {
	let files: Map<string, PackageFile>
	try {
		files = openPackage(bytes)
	} catch (e) {
		return { kind: 'package', ok: false, issues: [fromError(e)], signature: 'not checked' }
	}
	try {
		const v = verifyPackage(files, trusted)
		return {
			kind: 'package',
			ok: true,
			issues: [],
			signature: v.dev ? 'verified with a DEV key' : 'verified',
			id: v.manifest.id,
			version: v.manifest.version,
		}
	} catch (e) {
		// Without a trusted key the signature cannot be proven, but the rest still can be checked.
		if (e instanceof ExtensionError && e.code === 'untrusted-publisher') {
			const manifestBytes = files.get('namzu-extension.json')?.bytes
			const list = files.get('files.sha256.json')?.bytes
			const parsed = manifestBytes ? parseManifest(manifestBytes) : undefined
			if (!parsed || !list)
				return { kind: 'package', ok: false, issues: [fromError(e)], signature: 'not verified' }
			if (!parsed.ok)
				return {
					kind: 'package',
					ok: false,
					issues: parsed.issues,
					signature: `not verified: ${e.message}`,
				}
			const issues: ManifestIssue[] = []
			try {
				checkHashes(files, list)
				checkPackageFiles(parsed.manifest, files)
			} catch (err) {
				issues.push(fromError(err))
			}
			return {
				kind: 'package',
				ok: issues.length === 0,
				issues,
				signature: `NOT verified: ${e.message}`,
				id: parsed.manifest.id,
				version: parsed.manifest.version,
			}
		}
		return { kind: 'package', ok: false, issues: [fromError(e)], signature: 'failed' }
	}
}
