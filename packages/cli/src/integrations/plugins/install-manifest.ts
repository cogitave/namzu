/**
 * `.install-manifests/<id>.json`: what a person accepted when a plugin was
 * installed. It lists every file that can run or configure running (the
 * executable files), the sha256 of each, the surface that was shown (hooks,
 * local servers, remote origins, modules, pre-approved tools) and one digest
 * over all of it.
 *
 * At every load the runtime hashes the executable files again, and walks the
 * plugin folder for a file that decides what runs but is not listed (any JSON
 * file, a skill, an agent or a command): one added after install, or left out
 * by the installer, stops the plugin too. A file that is not what was accepted
 * stops that plugin, and only that plugin. Nothing that has no matching record
 * and manifest loads from the plugin cache.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { isRecord, readJsonObject } from './json-state.js'
import { installManifestsFolder, pluginCacheFolder, splitPluginId } from './records.js'

export const INSTALL_MANIFEST_VERSION = 1

export interface InstallManifest {
	readonly id: string
	readonly installedFrom?: Readonly<Record<string, unknown>>
	/** Paths inside the plugin folder, with `/`. */
	readonly executable: readonly string[]
	/** sha256 (hex) of each executable file. */
	readonly files: Readonly<Record<string, string>>
	readonly surface: Readonly<Record<string, unknown>>
	readonly surfaceSha256: string
	readonly consent?: Readonly<Record<string, unknown>>
}

export function installManifestPath(home: string, id: string): string {
	return join(installManifestsFolder(home), `${id}.json`)
}

/** JSON with every mapping's keys sorted, so equal values print equal. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

export function sha256Hex(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex')
}

/** The digest a person accepts: the surface, and the hash of each executable file by path. */
export function surfaceDigest(
	surface: unknown,
	files: Readonly<Record<string, string>>,
	executable: readonly string[],
): string {
	const hashes = [...executable].sort().map((path) => `${path}\t${files[path] ?? ''}`)
	return sha256Hex(`${canonicalJson(surface)}\n${hashes.join('\n')}`)
}

export type InstallManifestRead =
	| { readonly state: 'ok'; readonly manifest: InstallManifest }
	| { readonly state: 'missing' }
	| { readonly state: 'unreadable'; readonly reason: string }

export function readInstallManifest(home: string, id: string): InstallManifestRead {
	const read = readJsonObject(installManifestPath(home, id))
	if (read.state === 'missing') return { state: 'missing' }
	if (read.state === 'unreadable') return read
	const raw = read.raw
	if (raw.version !== INSTALL_MANIFEST_VERSION)
		return {
			state: 'unreadable',
			reason: `version ${String(raw.version)} is not one this Namzu reads`,
		}
	if (raw.id !== id) return { state: 'unreadable', reason: 'it names another plugin' }
	if (!Array.isArray(raw.executable) || !raw.executable.every((p) => typeof p === 'string'))
		return { state: 'unreadable', reason: 'its list of executable files is not a list of paths' }
	if (
		!isRecord(raw.files) ||
		!Object.values(raw.files).every(
			(hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
		)
	)
		return { state: 'unreadable', reason: 'its file hashes are not sha256 values' }
	if (!isRecord(raw.surface)) return { state: 'unreadable', reason: 'its surface is not a mapping' }
	if (typeof raw.surfaceSha256 !== 'string')
		return { state: 'unreadable', reason: 'it has no surface digest' }
	return {
		state: 'ok',
		manifest: {
			id,
			executable: raw.executable as string[],
			files: raw.files as Record<string, string>,
			surface: raw.surface,
			surfaceSha256: raw.surfaceSha256,
			...(isRecord(raw.installedFrom) ? { installedFrom: raw.installedFrom } : {}),
			...(isRecord(raw.consent) ? { consent: raw.consent } : {}),
		},
	}
}

export type InstallVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false
			readonly code: 'changed' | 'no-manifest' | 'outside-cache'
			readonly message: string
	  }

function within(outer: string, inner: string): boolean {
	const rel = relative(outer, inner)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Whether `path` really lies strictly under the plugin cache (links followed). */
export function isInsidePluginCache(home: string, path: string): boolean {
	const cache = realOrNothing(pluginCacheFolder(home))
	const real = realOrNothing(path)
	return cache !== undefined && real !== undefined && real !== cache && within(cache, real)
}

function realOrNothing(path: string): string | undefined {
	try {
		return realpathSync.native(path)
	} catch {
		return undefined
	}
}

const CONFIG_FOLDERS = new Set(['agents', 'commands', 'skills'])

/**
 * A file that can configure what runs: any JSON file (manifests, hook entries,
 * server lists), a skill's `SKILL.md` (its front matter can attach hooks and
 * pre-approve tools), and any markdown file in an agents, commands or skills
 * folder. Such a file must be in the install manifest's executable list.
 */
export function isConfigFile(path: string): boolean {
	const parts = path.split('/')
	const name = parts[parts.length - 1] ?? ''
	const lower = name.toLowerCase()
	if (lower.endsWith('.json')) return true
	if (!lower.endsWith('.md')) return false
	return lower === 'skill.md' || parts.slice(0, -1).some((part) => CONFIG_FOLDERS.has(part))
}

const PROGRAM_EXTENSIONS = new Set([
	'.js',
	'.mjs',
	'.cjs',
	'.sh',
	'.ps1',
	'.bat',
	'.cmd',
	'.py',
	'.rb',
	'.pl',
	'.ts',
	'.mts',
	'.cts',
	'.tsx',
	'.jsx',
	'.php',
	'.lua',
	'.vbs',
	'.exe',
	'.jar',
	'.wasm',
])

/** Whether a file can run or configure running, by its path and mode. */
export function isExecutablePath(path: string, mode: number): boolean {
	if (isConfigFile(path)) return true
	if (path.startsWith('hooks/') || path.startsWith('bin/')) return true
	if ((mode & 0o111) !== 0) return true
	const dot = path.lastIndexOf('.')
	return dot >= 0 && PROGRAM_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

/** Every file or link under `root` that {@link isConfigFile} names and the manifest does not list. */
function unlistedConfigFile(root: string, listed: ReadonlySet<string>): string | undefined {
	const walk = (dir: string, prefix: string): string | undefined => {
		let entries: import('node:fs').Dirent[]
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return prefix === '' ? undefined : prefix
		}
		for (const entry of entries) {
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) {
				const found = walk(join(dir, entry.name), rel)
				if (found !== undefined) return found
			} else if (!listed.has(rel)) {
				let mode = 0
				try {
					mode = lstatSync(join(dir, entry.name)).mode
				} catch {
					return rel
				}
				if (isExecutablePath(rel, mode)) return rel
			}
		}
		return undefined
	}
	return walk(root, '')
}

/**
 * Whether the installed copy is what was accepted. Hashes the executable
 * files the manifest names and fails closed on a configuration file it does
 * not list; a folder outside the plugin cache, a missing or
 * unreadable manifest, a digest that does not match what was recorded, a file
 * that is missing, a link or whose hash differs all fail with the same
 * sentence a person can act on: install it again to review it again.
 */
export function verifyInstalledCopy(
	home: string,
	id: string,
	installPath: string,
	recordedDigest?: string,
): InstallVerdict {
	const { name } = splitPluginId(id)
	const again = 'Reinstall it to review it again.'
	const cache = realOrNothing(pluginCacheFolder(home))
	const root = realOrNothing(installPath)
	if (cache === undefined || root === undefined || root === cache || !within(cache, root))
		return {
			ok: false,
			code: 'outside-cache',
			message: `${name} is not in the plugin cache, so it did not load. ${again}`,
		}
	const read = readInstallManifest(home, id)
	if (read.state !== 'ok')
		return {
			ok: false,
			code: 'no-manifest',
			message: `${name} has no readable install manifest${read.state === 'unreadable' ? ` (${read.reason})` : ''}, so it did not load. ${again}`,
		}
	const manifest = read.manifest
	const changed: InstallVerdict = {
		ok: false,
		code: 'changed',
		message: `${name} changed on disk after you accepted it, so it did not load. ${again}`,
	}
	if (
		surfaceDigest(manifest.surface, manifest.files, manifest.executable) !==
			manifest.surfaceSha256 ||
		(recordedDigest !== undefined && recordedDigest !== manifest.surfaceSha256)
	)
		return changed
	for (const path of manifest.executable) {
		const expected = manifest.files[path]
		if (expected === undefined || path.length === 0 || isAbsolute(path)) return changed
		const target = resolve(root, ...path.split('/'))
		if (!target.startsWith(root + sep)) return changed
		try {
			const entry = lstatSync(target)
			if (!entry.isFile()) return changed
			// A folder on the way that is a link out would hash another file.
			const real = realOrNothing(target)
			if (real === undefined || !real.startsWith(root + sep)) return changed
			if (sha256Hex(readFileSync(target)) !== expected) return changed
		} catch {
			return changed
		}
	}
	// A file added after install, or left out of the list, is not what was accepted.
	if (unlistedConfigFile(root, new Set(manifest.executable)) !== undefined) return changed
	return { ok: true }
}
