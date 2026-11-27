/**
 * The one module marketplaces and plugins are fetched through. Everything it
 * writes goes under the staging folder the caller gives it; nothing it fetches
 * is run.
 */

import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { COMMON_MARKETPLACE_DIR, COMMON_MARKETPLACE_FILE, resolveWithinReal } from '@namzu/sdk'

import { EXIT_DATAERR } from '../../../exit-codes.js'
import { type ArchiveDownload, downloadArchive } from './archive.js'
import { FetchError, type FetchOptions, cloneRepository } from './git.js'
import { type MarketplaceSource, type RemoteEntrySource, gitUrlOf } from './source.js'
import { fetchCatalogText } from './url.js'

export interface FetchedMarketplace {
	/** A folder with the catalog where the common plugin layout keeps it. */
	readonly dir: string
	readonly commit?: string
	readonly lfsPointers: number
	readonly submodules: number
}

/**
 * Fetch a remote marketplace into `<staging>/m`. A repository is cloned
 * shallowly (sparsely when asked, always with the catalog's own folder); a
 * hosted `marketplace.json` is saved where a catalog is expected.
 */
export async function fetchMarketplace(
	source: MarketplaceSource,
	staging: string,
	options: FetchOptions = {},
): Promise<FetchedMarketplace> {
	const dir = join(staging, 'm')
	if (source.source === 'url') {
		const text = await fetchCatalogText(source.url, options)
		const file = join(dir, COMMON_MARKETPLACE_DIR, COMMON_MARKETPLACE_FILE)
		mkdirSync(join(dir, COMMON_MARKETPLACE_DIR), { recursive: true, mode: 0o700 })
		writeFileSync(file, text, { mode: 0o600 })
		return { dir, lfsPointers: 0, submodules: 0 }
	}
	const sparse = source.sparsePaths
	const result = await cloneRepository(
		{
			url: gitUrlOf(source),
			...(source.ref !== undefined ? { ref: source.ref } : {}),
			...(sparse !== undefined && sparse.length > 0
				? { sparsePaths: [...new Set([...sparse, COMMON_MARKETPLACE_DIR])] }
				: {}),
			dest: dir,
		},
		options,
	)
	return {
		dir,
		commit: result.commit,
		lfsPointers: result.lfsPointers,
		submodules: result.submodules,
	}
}

export interface FetchedPlugin {
	/** The folder holding the plugin, when it came from a repository. */
	readonly dir?: string
	/** The archive on disk, when it came from one. */
	readonly archive?: ArchiveDownload
	readonly commit?: string
	readonly lfsPointers: number
	readonly submodules: number
}

/** Fetch a plugin named by a catalog entry into `<staging>/fetched` (or `<staging>/plugin.zip`). */
export async function fetchPlugin(
	source: RemoteEntrySource,
	staging: string,
	options: FetchOptions = {},
): Promise<FetchedPlugin> {
	if (source.kind === 'archive') {
		const archive = await downloadArchive(
			source.url,
			join(staging, 'plugin.zip'),
			source.sha256,
			options,
		)
		return { archive, lfsPointers: 0, submodules: 0 }
	}
	const dest = join(staging, 'fetched')
	const result = await cloneRepository(
		{
			url: source.kind === 'github' ? `https://github.com/${source.repo}.git` : source.url,
			...(source.ref !== undefined ? { ref: source.ref } : {}),
			...(source.sha !== undefined ? { sha: source.sha } : {}),
			...(source.kind === 'git-subdir' ? { sparsePaths: [source.path] } : {}),
			dest,
		},
		options,
	)
	let dir = dest
	if (source.kind === 'git-subdir') {
		try {
			dir = await resolveWithinReal(dest, source.path)
			if (!lstatSync(dir).isDirectory()) throw new Error('not a folder')
		} catch {
			throw new FetchError(
				EXIT_DATAERR,
				`The repository has no folder "${source.path}", or it leaves the repository.`,
				'path',
			)
		}
	}
	return {
		dir,
		commit: result.commit,
		lfsPointers: result.lfsPointers,
		submodules: result.submodules,
	}
}
