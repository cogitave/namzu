/**
 * What `namzu plugin marketplace add | update` and the Desktop's Customize page do with a marketplace
 * that lives in a repository or at an https address, written once. The command line
 * (`commands/plugin-install.ts`) and the desktop host (`commands/desktop-host-plugins.ts`) call
 * these functions, so the consent text, the refusals, the pin rule and the way a fetched folder is
 * moved into place cannot drift apart. Nothing here asks a question or prints: a caller does that.
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import { COMMON_MARKETPLACE_DIR, COMMON_MARKETPLACE_FILE } from '@namzu/sdk'

import { terminalDisplayText } from '../../tui/terminal-display.js'
import { setExtraKnownMarketplace } from './enabled-records.js'
import type { FetchOptions } from './fetch/git.js'
import { type FetchedMarketplace, fetchMarketplace } from './fetch/index.js'
import {
	type MarketplaceSource,
	type RemoteEntrySource,
	describeSource,
	isBlockedSource,
	isCommitId,
} from './fetch/source.js'
import { discardStaging, stagingFolder } from './install-plan.js'
import { trashFolder } from './install.js'
import { type Catalog, readCatalog, resolveEntrySource } from './marketplace.js'
import {
	type KnownMarketplace,
	type RecordScope,
	marketplacesFolder,
	putKnownMarketplace,
	readInstalledPlugins,
	splitPluginId,
} from './records.js'

export const oneLine = (value: string): string =>
	terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')

export const MARKETPLACE_NOTICE = [
	'Plugins from a marketplace can run programs on this computer, with access to',
	'your files. Namzu does not control this marketplace or its plugins, and its',
	'owner can change them later. Add only marketplaces you trust.',
].join('\n')

export const MARKETPLACE_BLOCKED = 'Adding this marketplace is turned off in your settings.'
export const DOWNLOAD_BLOCKED = 'Downloading from this marketplace is turned off in your settings.'

/** The sentence for a plugin that kept its version while its files changed: an update cannot apply it. */
export function sameVersionChanged(id: string, version: string): string {
	return `${id} still says version ${version} but its files changed. Ask its author to raise the version, or remove it and install it again.`
}

/** A plain sentence for what adding a source will do, from the typed address alone. */
export function describeAddition(source: MarketplaceSource): string {
	const where = describeSource(source)
	if (source.source === 'url') return `Will add the marketplace file at ${where}`
	return `Will add ${where}${source.ref !== undefined ? ` (${isCommitId(source.ref) ? 'commit' : 'branch or tag'} ${source.ref})` : ' (default branch)'}`
}

/** Whether two marketplace sources name the same thing. */
export function sameSource(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): boolean {
	const norm = (v: Readonly<Record<string, unknown>>) =>
		JSON.stringify([
			v.source,
			v.repo ?? v.url ?? v.path ?? null,
			v.ref ?? null,
			[...((v.sparsePaths as string[] | undefined) ?? [])].sort(),
		])
	return norm(a) === norm(b)
}

/** The refusal for a marketplace name that is already added from a different source; says so when only the ref or the sparse folders differ. */
export function anotherPlace(
	name: string,
	existing: Readonly<Record<string, unknown>>,
	wanted: Readonly<Record<string, unknown>>,
	remove = `Remove it first: namzu plugin marketplace remove ${name}`,
): string {
	const sameRepo =
		existing.source === wanted.source &&
		(existing.repo ?? existing.url ?? existing.path ?? null) ===
			(wanted.repo ?? wanted.url ?? wanted.path ?? null) &&
		wanted.source !== 'directory'
	if (sameRepo) {
		const pin = (v: Readonly<Record<string, unknown>>): string => {
			const sparse = (v.sparsePaths as string[] | undefined) ?? []
			return [
				v.ref !== undefined ? `ref ${String(v.ref)}` : 'default branch',
				...(sparse.length > 0 ? [`folders ${sparse.join(', ')}`] : []),
			].join(', ')
		}
		return `A marketplace named "${name}" is already added from this repository at a different ref or folder set (added: ${oneLine(pin(existing))}; asked for: ${oneLine(pin(wanted))}). ${remove}`
	}
	return `A marketplace named "${name}" is already added from another place (${oneLine(describeSource(existing as { source: string }))}). ${remove}`
}

/** The text a person agrees to before a fetched marketplace is kept. */
export function marketplaceConsentText(
	name: string,
	display: string,
	catalog: Catalog,
	notInstallable: number,
	commit: string | undefined,
	ref: string | undefined,
): string {
	return [
		`Add marketplace "${oneLine(name)}" from ${oneLine(display)}?`,
		'',
		MARKETPLACE_NOTICE,
		'',
		`  Owner:    ${catalog.owner !== undefined ? oneLine(catalog.owner) : '(not stated)'}`,
		`  Plugins:  ${catalog.entries.length}${notInstallable > 0 ? ` (${notInstallable} cannot be installed here)` : ''}`,
		...(commit !== undefined
			? [`  Commit:   ${commit.slice(0, 7)}${ref !== undefined ? `  (${oneLine(ref)})` : ''}`]
			: []),
		'',
		'You will see what a plugin does before you install it.',
	].join('\n')
}

/** How many of a catalog's plugins cannot be installed here (a source that is not a folder or a fetchable repository or archive). */
export async function countNotInstallable(
	catalog: Catalog,
	hosted: boolean,
	allowFileProtocol: boolean,
): Promise<number> {
	const kinds = await Promise.all(
		catalog.entries.map(
			async (entry) =>
				(
					await resolveEntrySource(entry, catalog, {
						hosted,
						...(allowFileProtocol ? { allowFileProtocol: true } : {}),
					})
				).kind,
		),
	)
	return kinds.filter((kind) => kind !== 'local' && kind !== 'remote').length
}

/** The marketplace source an entry's download comes from, as a block-list entry is compared with it. */
export function entryAddress(remote: RemoteEntrySource): {
	source: string
	[key: string]: unknown
} {
	return remote.kind === 'github'
		? { source: 'github', repo: remote.repo }
		: remote.kind === 'archive'
			? { source: 'url', url: remote.url }
			: { source: 'git', url: remote.url }
}

/** Whether the settings forbid downloading a catalog entry: its marketplace or its own address is blocked. */
export function downloadBlocked(
	market: KnownMarketplace | undefined,
	remote: RemoteEntrySource,
	blocked: readonly string[] | undefined,
): boolean {
	return (
		(market !== undefined && isBlockedSource(market.source, blocked)) ||
		isBlockedSource(entryAddress(remote), blocked)
	)
}

export type FetchedCatalog =
	| { readonly ok: true; readonly catalog: Catalog }
	| { readonly ok: false; readonly message: string }

/** The catalog of a freshly fetched marketplace folder, or the sentence saying why it is not one. */
export function readFetchedCatalog(dir: string, display: string): FetchedCatalog {
	const read = readCatalog(dir, 'directory')
	if (!read.ok)
		return {
			ok: false,
			message: read.missing
				? `${oneLine(display)} is not a marketplace: it has no ${COMMON_MARKETPLACE_DIR}/${COMMON_MARKETPLACE_FILE}.`
				: `${oneLine(display)} is not a marketplace: ${read.reason}`,
		}
	return { ok: true, catalog: read.catalog }
}

/** Sentences a person should read about a fetched marketplace besides its own warnings. */
export function fetchNotes(fetched: FetchedMarketplace): string[] {
	return [
		...(fetched.lfsPointers > 0
			? [
					`${fetched.lfsPointers} Git LFS ${fetched.lfsPointers === 1 ? 'file was' : 'files were'} not downloaded and stay as pointer files.`,
				]
			: []),
		...(fetched.submodules > 0
			? [
					`The repository lists ${fetched.submodules} ${fetched.submodules === 1 ? 'submodule' : 'submodules'}; none was downloaded.`,
				]
			: []),
	]
}

export interface PlaceOptions {
	readonly home: string
	/** The folder whose settings file the `project` and `local` scopes name. */
	readonly cwd: string
	readonly scope: RecordScope
	readonly now: Date
	readonly by: 'cli' | 'desktop'
	/** Writes the declaration in the scope's settings file. */
	readonly layerPath: string
}

/** Moves a fetched marketplace folder into Namzu's marketplaces folder and records the yes. */
export function placeMarketplace(
	catalog: Catalog,
	source: MarketplaceSource,
	fetched: FetchedMarketplace,
	options: PlaceOptions,
): void {
	const dest = join(marketplacesFolder(options.home), catalog.name)
	const at = options.now.toISOString()
	if (lstatExists(dest)) trashFolder(options.home, dest)
	mkdirSync(marketplacesFolder(options.home), { recursive: true, mode: 0o700 })
	renameSync(fetched.dir, dest)
	putKnownMarketplace(options.home, catalog.name, {
		source,
		installLocation: dest,
		lastUpdated: at,
		autoUpdate: false,
		...(fetched.commit !== undefined ? { commit: fetched.commit } : {}),
		consent: { at, by: options.by, notice: 'marketplace-v1' },
	})
	setExtraKnownMarketplace(options.layerPath, options.home, catalog.name, source)
}

/** A staging folder for one fetch; the caller removes it with `discardStaging`. */
export function newStaging(home: string): string {
	const staging = join(stagingFolder(home), randomUUID())
	mkdirSync(staging, { recursive: true, mode: 0o700 })
	return staging
}

export function lstatExists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

export interface UpdateRow {
	readonly name: string
	readonly outcome: 'updated' | 'up-to-date' | 'pinned' | 're-read' | 'failed'
	readonly message: string
	readonly from?: string | null
	readonly to?: string | null
	readonly newPlugins: readonly string[]
	readonly changedPlugins: readonly string[]
	readonly newer: readonly { id: string; installed: string; available: string }[]
}

export function diffCatalogs(
	before: ReturnType<typeof readCatalog>,
	after: Catalog,
): { added: string[]; changed: string[] } {
	const old = new Map(before.ok ? before.catalog.entries.map((e) => [e.name, e]) : [])
	const added: string[] = []
	const changed: string[] = []
	for (const entry of after.entries) {
		const prior = old.get(entry.name)
		if (prior === undefined) added.push(entry.name)
		else if (JSON.stringify(prior.raw) !== JSON.stringify(entry.raw)) changed.push(entry.name)
	}
	return { added, changed }
}

/** Installed plugins of a marketplace whose catalog entry now names another version. */
export function newerVersions(home: string, name: string, catalog: Catalog): UpdateRow['newer'] {
	const installed = readInstalledPlugins(home)
	if (installed.state === 'unreadable') return []
	const out: { id: string; installed: string; available: string }[] = []
	for (const [id, records] of installed.plugins) {
		const parts = splitPluginId(id)
		if (parts.marketplace !== name) continue
		const entry = catalog.entries.find((candidate) => candidate.name === parts.name)
		const have = records[0]?.version
		if (entry?.version !== undefined && have !== undefined && entry.version !== have)
			out.push({ id, installed: have, available: entry.version })
	}
	return out
}

export function isInside(outer: string, inner: string): boolean {
	const rel = relative(outer, inner)
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface RefreshOptions {
	readonly home: string
	readonly now: Date
	readonly blockedMarketplaces?: readonly string[]
	readonly fetch?: FetchOptions
	/** The sentence for an error; the command line's own wording by default. */
	readonly describe?: (error: unknown) => string
}

/**
 * Reads a remote marketplace again from where it came from: fetched aside, compared, then put in
 * place of the old copy. A source pinned to one commit is not fetched, a blocked one is not
 * touched, and a copy outside Namzu's marketplaces folder is not replaced. A fetch the person
 * cancelled throws; every other failure is a `failed` row.
 */
export async function refreshRemoteMarketplace(
	market: KnownMarketplace,
	options: RefreshOptions,
): Promise<UpdateRow> {
	const { home } = options
	const describe = options.describe ?? failureText
	const name = market.name
	const row = (
		partial: Partial<UpdateRow> & Pick<UpdateRow, 'outcome' | 'message'>,
	): UpdateRow => ({
		name,
		newPlugins: [],
		changedPlugins: [],
		newer: [],
		...partial,
	})
	const kind = market.source.source
	if (isBlockedSource(market.source, options.blockedMarketplaces))
		return row({ outcome: 'failed', message: 'refreshing it is turned off in your settings.' })
	const ref = typeof market.source.ref === 'string' ? market.source.ref : undefined
	if ((kind === 'github' || kind === 'git') && ref !== undefined && isCommitId(ref))
		return row({ outcome: 'pinned', message: `pinned at ${ref.slice(0, 7)}` })
	if (!isInside(marketplacesFolder(home), market.installLocation))
		return row({
			outcome: 'failed',
			message: 'its folder is not under Namzu’s marketplaces folder, so it is not replaced.',
		})
	const staging = newStaging(home)
	try {
		let fetched: FetchedMarketplace
		try {
			fetched = await fetchMarketplace(
				market.source as unknown as MarketplaceSource,
				staging,
				options.fetch,
			)
		} catch (error) {
			if (options.fetch?.signal?.aborted) throw error
			return row({ outcome: 'failed', message: describe(error) })
		}
		const read = readCatalog(fetched.dir, 'directory')
		if (!read.ok)
			return row({ outcome: 'failed', message: `it is no longer a marketplace: ${read.reason}` })
		if (read.catalog.name !== name)
			return row({
				outcome: 'failed',
				message: `it now calls itself "${read.catalog.name}", so it was not updated.`,
			})
		const before = readCatalog(market.installLocation, 'directory')
		const diff = diffCatalogs(before, read.catalog)
		const unchanged =
			fetched.commit !== undefined
				? fetched.commit === market.commit
				: before.ok &&
					diff.added.length === 0 &&
					diff.changed.length === 0 &&
					before.catalog.entries.length === read.catalog.entries.length
		const newer = newerVersions(home, name, read.catalog)
		if (unchanged) return row({ outcome: 'up-to-date', message: 'already up to date', newer })
		try {
			if (lstatExists(market.installLocation)) trashFolder(home, market.installLocation)
			renameSync(fetched.dir, market.installLocation)
			putKnownMarketplace(home, name, {
				source: market.source,
				installLocation: market.installLocation,
				lastUpdated: options.now.toISOString(),
				...(fetched.commit !== undefined ? { commit: fetched.commit } : {}),
			})
		} catch (error) {
			return row({ outcome: 'failed', message: describe(error) })
		}
		const counts = `${diff.added.length} new, ${diff.changed.length} changed`
		return row({
			outcome: 'updated',
			message:
				fetched.commit !== undefined
					? `updated ${(market.commit ?? '?').slice(0, 7)} to ${fetched.commit.slice(0, 7)} (${counts})`
					: `updated (${counts})`,
			from: market.commit ?? null,
			to: fetched.commit ?? null,
			newPlugins: diff.added,
			changedPlugins: diff.changed,
			newer,
		})
	} finally {
		discardStaging(staging)
	}
}

/** The sentence for an error thrown while fetching or placing a marketplace. */
export function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
