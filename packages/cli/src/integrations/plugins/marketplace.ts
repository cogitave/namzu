/**
 * Marketplaces: the catalogs a person adds, and how an address typed for one is
 * read.
 *
 * This file reads and judges; it never copies a plugin, fetches anything or
 * runs anything. A marketplace added from a folder or a `.json` file is
 * registered in place (nothing is copied): its catalog is read again each time
 * it is needed.
 *
 * A catalog is read leniently (a key this Namzu does not know is kept under
 * `raw`), with these bounds: the file is a regular file of at most 10 MiB, it
 * lists at most 500 plugins, and an entry with no name or no source is left out
 * and reported, never half read.
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import {
	COMMON_MARKETPLACE_DIR,
	COMMON_MARKETPLACE_FILE,
	isOfficialLookingMarketplaceName,
	resolveWithinReal,
} from '@namzu/sdk'

import { isRecord } from './json-state.js'

/** The marketplace id every plugin installed from a file or a folder gets. It has no record. */
export const LOCAL_UPLOADS_MARKETPLACE = 'local-uploads'

/** Names a catalog may not take: the ids Namzu itself uses. `namzu` and `namzu-*` are refused too. */
export const RESERVED_MARKETPLACE_NAMES: readonly string[] = [
	LOCAL_UPLOADS_MARKETPLACE,
	'inline',
	'builtin',
	'synced',
]

export const MAX_CATALOG_PLUGINS = 500
export const MAX_CATALOG_BYTES = 10 * 1024 * 1024

const NAME_RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Why a name may not be a marketplace's, or `undefined` when it may. */
export function marketplaceNameProblem(name: string): string | undefined {
	if (!NAME_RULE.test(name) || name.includes('..'))
		return `"${name}" is not a marketplace name. Use lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64 characters.`
	const lower = name.toLowerCase()
	if (RESERVED_MARKETPLACE_NAMES.includes(lower) || lower === 'namzu' || lower.startsWith('namzu-'))
		return `The marketplace name "${name}" is reserved.`
	if (isOfficialLookingMarketplaceName(name))
		return `The marketplace name "${name}" looks like an official catalog's name, which another marketplace may not use.`
	return undefined
}

/** The fields of a catalog entry a marketplace may set inline, honoured only when the entry says `strict: false`. */
export const ENTRY_COMPONENT_FIELDS: readonly string[] = [
	'skills',
	'commands',
	'agents',
	'hooks',
	'mcpServers',
]
/** What the install sidecar keeps of an entry. */
export const ENTRY_SIDECAR_KEEPS: readonly string[] = [
	'name',
	'description',
	'version',
	'author',
	'strict',
	'platforms',
	'engines',
	...ENTRY_COMPONENT_FIELDS,
]

export interface CatalogEntry {
	readonly name: string
	readonly source: unknown
	readonly description?: string
	readonly version?: string
	readonly author?: string
	readonly strict: boolean
	/** The whole entry as written, for the sidecar and for keys this Namzu does not know. */
	readonly raw: Readonly<Record<string, unknown>>
}

export interface Catalog {
	readonly name: string
	readonly owner?: string
	readonly pluginRoot?: string
	readonly entries: readonly CatalogEntry[]
	/** Things left out or ignored, in words. */
	readonly warnings: readonly string[]
	/** The catalog file that was read. */
	readonly file: string
	/** The folder relative entry sources resolve against. */
	readonly root: string
}

export type CatalogRead =
	| { readonly ok: true; readonly catalog: Catalog }
	| { readonly ok: false; readonly reason: string; readonly missing?: boolean }

/** The catalog file of a registered marketplace, and the folder its relative sources start from. */
export function catalogLocation(
	location: string,
	kind: 'directory' | 'file',
): { readonly file: string; readonly root: string } {
	if (kind === 'file') {
		const dir = dirname(location)
		return { file: location, root: basename(dir) === COMMON_MARKETPLACE_DIR ? dirname(dir) : dir }
	}
	const inside = join(location, COMMON_MARKETPLACE_DIR, COMMON_MARKETPLACE_FILE)
	let file = inside
	try {
		lstatSync(inside)
	} catch {
		const plain = join(location, COMMON_MARKETPLACE_FILE)
		try {
			lstatSync(plain)
			file = plain
		} catch {
			file = inside
		}
	}
	return { file, root: location }
}

function text(value: unknown, max = 1024): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
}

/** Read one catalog. Nothing is run; a link, a file that is not JSON or one over the bounds is refused with a reason. */
export function readCatalog(location: string, kind: 'directory' | 'file'): CatalogRead {
	const { file, root } = catalogLocation(location, kind)
	let stat: ReturnType<typeof lstatSync>
	try {
		stat = lstatSync(file)
	} catch {
		return {
			ok: false,
			missing: true,
			reason: `There is no catalog at ${file}. A marketplace folder holds ${COMMON_MARKETPLACE_DIR}/${COMMON_MARKETPLACE_FILE}.`,
		}
	}
	if (!stat.isFile())
		return { ok: false, reason: `${file} is a link or not a regular file, so it is not read.` }
	if (stat.size > MAX_CATALOG_BYTES)
		return { ok: false, reason: `${file} is larger than ${MAX_CATALOG_BYTES / (1024 * 1024)} MiB.` }
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'))
	} catch (error) {
		return {
			ok: false,
			reason: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
		}
	}
	if (!isRecord(parsed))
		return { ok: false, reason: `${file} is not a catalog: it is not a mapping.` }
	const name = text(parsed.name, 200)
	if (name === undefined) return { ok: false, reason: `${file} has no "name".` }
	if (!Array.isArray(parsed.plugins)) return { ok: false, reason: `${file} has no "plugins" list.` }
	if (parsed.plugins.length > MAX_CATALOG_PLUGINS)
		return {
			ok: false,
			reason: `${file} lists ${parsed.plugins.length} plugins; at most ${MAX_CATALOG_PLUGINS} are read.`,
		}
	const warnings: string[] = []
	const owner = isRecord(parsed.owner) ? text(parsed.owner.name, 200) : undefined
	if (owner === undefined) warnings.push('The catalog names no owner.')
	const metadata = isRecord(parsed.metadata) ? parsed.metadata : {}
	const pluginRoot = text(metadata.pluginRoot, 512)
	const seen = new Set<string>()
	const entries: CatalogEntry[] = []
	for (const [index, item] of parsed.plugins.entries()) {
		if (!isRecord(item)) {
			warnings.push(`Entry ${index + 1} is not a mapping and was left out.`)
			continue
		}
		const entryName = text(item.name, 64)
		if (entryName === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entryName)) {
			warnings.push(`Entry ${index + 1} has no usable name and was left out.`)
			continue
		}
		if (
			item.source === undefined ||
			(typeof item.source !== 'string' && !isRecord(item.source)) ||
			item.source === ''
		) {
			warnings.push(`${entryName} has no source and was left out.`)
			continue
		}
		if (seen.has(entryName)) {
			warnings.push(`${entryName} is listed twice; the first entry is used.`)
			continue
		}
		seen.add(entryName)
		const description = text(item.description)
		const version = text(item.version, 64)
		const author = typeof item.author === 'string' ? text(item.author, 200) : undefined
		entries.push({
			name: entryName,
			source: item.source,
			...(description !== undefined ? { description } : {}),
			...(version !== undefined ? { version } : {}),
			...(author !== undefined ? { author } : {}),
			strict: item.strict !== false,
			raw: item,
		})
		if (item.strict !== false && ENTRY_COMPONENT_FIELDS.some((field) => field in item))
			warnings.push(
				`${entryName} sets components inline without "strict": false, so they are ignored.`,
			)
	}
	return {
		ok: true,
		catalog: {
			name,
			...(owner !== undefined ? { owner } : {}),
			...(pluginRoot !== undefined ? { pluginRoot } : {}),
			entries,
			warnings,
			file,
			root,
		},
	}
}

export type EntrySource =
	| { readonly kind: 'local'; readonly dir: string }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'invalid'; readonly reason: string }

/** Remote forms an entry may name; reading them needs a download this version does not do. */
const DOWNLOAD_KINDS = ['github', 'url', 'git', 'git-subdir', 'archive']

/**
 * Where an entry's plugin is. A relative path (`./plugins/ledger`, or a bare
 * name under the catalog's `metadata.pluginRoot`) is resolved inside the
 * catalog's folder with symbolic links followed and refused when they leave it.
 */
export async function resolveEntrySource(
	entry: CatalogEntry,
	catalog: Catalog,
): Promise<EntrySource> {
	const source = entry.source
	if (typeof source === 'string') {
		let relative: string
		if (source.startsWith('./') || source.startsWith('../') || source === '.') relative = source
		else if (catalog.pluginRoot !== undefined && !isAbsolute(source) && !/^[A-Za-z]:/.test(source))
			relative = join(catalog.pluginRoot, source)
		else
			return {
				kind: 'invalid',
				reason: `The source "${source}" is not a folder path starting with ./, and the catalog sets no metadata.pluginRoot for a bare name.`,
			}
		if (isAbsolute(relative) || /^[A-Za-z]:/.test(relative))
			return { kind: 'invalid', reason: `The source "${source}" is an absolute path.` }
		try {
			const dir = await resolveWithinReal(catalog.root, relative)
			if (!lstatSync(dir).isDirectory())
				return { kind: 'invalid', reason: `The source "${source}" is not a folder.` }
			return { kind: 'local', dir }
		} catch (error) {
			return {
				kind: 'invalid',
				reason: `The source "${source}" cannot be used: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}
	if (isRecord(source)) {
		const kind = typeof source.source === 'string' ? source.source : ''
		if (DOWNLOAD_KINDS.includes(kind))
			return {
				kind: 'unsupported',
				reason: `${entry.name} comes from a download (${kind}), which this version of Namzu cannot fetch yet.`,
			}
		return {
			kind: 'unsupported',
			reason: `${entry.name} is obtained by ${kind === '' ? 'an unknown means' : kind}, which Namzu does not install: it would run a package manager or another program to get the code.`,
		}
	}
	return { kind: 'invalid', reason: 'The entry has no usable source.' }
}

export type MarketplaceAddress =
	| { readonly kind: 'path'; readonly path: string }
	| { readonly kind: 'remote'; readonly form: string; readonly text: string }
	| { readonly kind: 'refused'; readonly message: string }

const NOT_AN_ADDRESS =
	'Not a marketplace address. Use owner/repo, an https:// address, or a folder path.'

/**
 * Read what a person typed after `marketplace add`, in a fixed order and
 * without touching the disk. A folder path or a `.json` file path is
 * `path`; the forms that need a download are named so the command can say so;
 * anything else is refused with a sentence.
 */
export function parseMarketplaceAddress(input: string, cwd: string): MarketplaceAddress {
	const value = input.trim()
	if (value === '') return { kind: 'refused', message: NOT_AN_ADDRESS }
	if (/^http:\/\//i.test(value))
		return { kind: 'refused', message: 'Only https:// addresses are accepted, not http://.' }
	if (/^file:\/\//i.test(value))
		return { kind: 'refused', message: 'Use a folder path, not a file:// address.' }
	if (/^\\\\/.test(value) || /^\/\/[^/]/.test(value))
		return {
			kind: 'refused',
			message: 'A network share is not accepted. Copy the marketplace to this computer first.',
		}
	if (/^(\.{1,2}([\\/]|$)|\/|~|[A-Za-z]:[\\/])/.test(value)) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
		const expanded = value === '~' || /^~[\\/]/.test(value) ? join(home, value.slice(1)) : value
		return { kind: 'path', path: resolve(cwd, expanded) }
	}
	if (/^[\w.-]+@[\w.-]+:[^/\\].*/.test(value)) return { kind: 'remote', form: 'git', text: value }
	if (/^https:\/\//i.test(value)) {
		let url: URL
		try {
			url = new URL(value)
		} catch {
			return { kind: 'refused', message: NOT_AN_ADDRESS }
		}
		if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
			return {
				kind: 'refused',
				message: 'Remove the sign-in details from the address; Namzu uses your own Git setup.',
			}
		if (/^github\.com$/i.test(url.hostname) && /\/(tree|blob)\//.test(url.pathname))
			return {
				kind: 'refused',
				message: 'Use the repository address (owner/repo), not a page inside it.',
			}
		return { kind: 'remote', form: 'https', text: value }
	}
	if (/^[\w.-]+\/[\w.-]+(#.+)?$/.test(value)) return { kind: 'remote', form: 'github', text: value }
	return { kind: 'refused', message: NOT_AN_ADDRESS }
}

/** A path as the file system names it, or `undefined` when it does not exist. */
export function realPathOf(path: string): string | undefined {
	try {
		return realpathSync.native(path)
	} catch {
		return undefined
	}
}
