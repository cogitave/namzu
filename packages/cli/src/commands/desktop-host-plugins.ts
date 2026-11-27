/**
 * The Customize page's plugin and marketplace actions over the desktop host. Every rule lives in
 * the command line's modules (`integrations/plugins/`: the marketplace reader, the install plan,
 * the writers, the recorded yes); this file validates the request, keeps what was read in memory
 * between "show" and "yes", and maps the outcomes to the shapes `shared/customize-protocol.ts`
 * reads.
 *
 * Nothing is installed on a guess. `plan` copies the plugin aside (the CLI's staging folder), reads
 * it and answers with the consent surface and its digest; `install` takes that digest back,
 * recomputes it from the staged files and refuses a mismatch, so the renderer can only install what
 * the person was shown. Stages and plans live in this process for ten minutes (at most four of
 * each); a leftover staging folder after a crash is what `namzu plugin prune` removes.
 *
 * A long step takes an `opId` the page chose: progress goes out as `namzu/ops/progress`, and
 * `namzu/ops/cancel` stops the step at its next check, before anything is written.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
	type RecordLayer,
	readRecordLayer,
	recordLayerPath,
	removeExtraKnownMarketplace,
	setEnabledPlugin,
	setExtraKnownMarketplace,
} from '../integrations/plugins/enabled-records.js'
import { FetchError, type FetchOptions } from '../integrations/plugins/fetch/git.js'
import { fetchMarketplace } from '../integrations/plugins/fetch/index.js'
import {
	type MarketplaceSource,
	describeSource,
	isBlockedSource,
} from '../integrations/plugins/fetch/source.js'
import { readInstallManifest, surfaceDigest } from '../integrations/plugins/install-manifest.js'
import {
	type InstallPlan,
	type InstallSource,
	PlanRefusal,
	discardStaging,
	planInstall,
} from '../integrations/plugins/install-plan.js'
import { renderInstallPreview } from '../integrations/plugins/install-preview.js'
import {
	InstallConflict,
	SimulatedCrash,
	commitInstall,
	commitUpdate,
	removeInstall,
} from '../integrations/plugins/install.js'
import {
	currentEnabledAnswer,
	loadInstalledManifest,
	planInstalledPlugins,
	readLayers,
} from '../integrations/plugins/installed-source.js'
import { readPluginManifestDetails } from '../integrations/plugins/manifest-details.js'
import {
	type Catalog,
	LOCAL_UPLOADS_MARKETPLACE,
	MAX_CATALOG_PLUGINS,
	marketplaceNameProblem,
	parseMarketplaceAddress,
	readCatalog,
	realPathOf,
	resolveEntrySource,
} from '../integrations/plugins/marketplace.js'
import {
	type InstallRecord,
	type KnownMarketplace,
	type RecordScope,
	installedPluginsPath,
	isPluginId,
	putKnownMarketplace,
	readInstalledPlugins,
	readKnownMarketplaces,
	realPathOrResolved,
	removeKnownMarketplace,
	samePath,
	splitPluginId,
} from '../integrations/plugins/records.js'
import {
	DOWNLOAD_BLOCKED,
	MARKETPLACE_BLOCKED,
	MARKETPLACE_NOTICE,
	anotherPlace,
	countNotInstallable,
	describeAddition,
	downloadBlocked,
	fetchNotes,
	newStaging,
	placeMarketplace,
	readFetchedCatalog,
	refreshRemoteMarketplace,
	sameSource,
	sameVersionChanged,
} from '../integrations/plugins/remote-marketplace.js'
import { hashExecutableFiles } from '../integrations/plugins/surface.js'
import { compareUpdate } from '../integrations/plugins/update-compare.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { stateFailure } from './plugin-records.js'

export const PLUGIN_STAGE_TTL_MS = 10 * 60 * 1000
export const PLUGIN_STAGE_MAX = 4
export const PLUGIN_PLAN_MAX = 4
export const PLUGIN_PATH_MAX_CHARS = 4096
export const OP_PROGRESS_NOTIFICATION = 'namzu/ops/progress'

export const PLUGIN_PAL_MESSAGE = 'Host plugins are not inherited by Pals.'
export const PLUGIN_TRUST_MESSAGE = 'Trust this folder first.'
export const PLUGIN_CHANGED_MESSAGE = 'What it does changed. Read it again.'
export const PLUGIN_GONE_MESSAGE = 'This was shown a while ago. Choose the plugin again.'
export const PLUGIN_CANCELLED_MESSAGE = 'Cancelled.'
export const PLUGIN_LOADS_NEXT_NOTE = 'It loads in new conversations.'
export const PLUGIN_PLACE_MESSAGE = 'Read it again for this place before installing.'

const LINE_MAX = 300
/** A runnable string longer than this is refused, never cut: the person must read all of it. */
const RUN_MAX = 2000
const LIST_MAX = 100
const FINDINGS_MAX = 50
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/
const SCOPES: readonly RecordScope[] = ['user', 'project', 'local']

type Notify = (method: string, params: Record<string, unknown>) => void

export interface PluginActionDeps {
	/** The project folder this host serves. */
	readonly cwd: string
	/** True when the host serves a Pal workspace. */
	readonly pal: () => boolean
	readonly isTrusted: (cwd: string) => boolean
	/** The OS home folder (tests); absent means `NAMZU_HOME` and the real home. */
	readonly home?: string
	readonly now?: () => number
	/** Progress notifications to the app. */
	readonly notify?: Notify
	/** `plugins.enabled` of the configuration now. */
	readonly loadingOn: () => boolean
	/** Writes `plugins.enabled: true`; returns the sentence to show. */
	readonly enableLoading: () => string
	/** `plugins.blockedMarketplaces` of the configuration now (user and managed files). */
	readonly blockedMarketplaces?: () => readonly string[]
	/** How downloads are made. Tests replace parts of it; the app never sets it. */
	readonly fetch?: FetchOptions
}

interface Held {
	readonly plan: InstallPlan
	readonly expiresAt: number
}

interface PlanEntry extends Held {
	readonly scope: RecordScope
	/** The stage this plan was read from, when it came from one. */
	readonly stageId?: string
}

/** What a step in progress can be asked to stop. */
export interface OpContext {
	readonly signal: AbortSignal
	/** Tells the app which phase a long step is in. */
	readonly progress: (phase: 'checking' | 'downloading' | 'reading') => void
	/** Throws {@link PLUGIN_CANCELLED_MESSAGE} when the person asked to stop. */
	readonly check: () => void
}

function exactKeys(
	params: unknown,
	allowed: readonly string[],
	required: readonly string[],
	what: string,
): Record<string, unknown> {
	if (!params || typeof params !== 'object' || Array.isArray(params))
		throw new Error(`Invalid ${what} request.`)
	const record = params as Record<string, unknown>
	if (Object.keys(record).some((key) => !allowed.includes(key)))
		throw new Error(`Invalid ${what} request.`)
	for (const key of required)
		if (record[key] === undefined) throw new Error(`Invalid ${what} request.`)
	return record
}

function field(record: Record<string, unknown>, key: string, max: number): string {
	const value = record[key]
	if (
		typeof value !== 'string' ||
		value.trim() === '' ||
		value.length > max ||
		value.includes('\0')
	)
		throw new Error(`Invalid ${key}.`)
	return value
}

function scopeOf(record: Record<string, unknown>, key = 'scope'): RecordScope {
	const value = record[key]
	if (!SCOPES.includes(value as RecordScope)) throw new Error(`Invalid ${key}.`)
	return value as RecordScope
}

function flag(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
	return value
}

function pluginId(record: Record<string, unknown>, key = 'id'): string {
	const id = field(record, key, 200)
	if (!isPluginId(id)) throw new Error(`Invalid ${key}.`)
	return id
}

const line = (text: string): string =>
	text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text

/** The sentence for a failure: the command line's own words for a refusal, a conflict or a record. */
function reason(error: unknown): string {
	if (error instanceof SimulatedCrash) throw error
	if (
		error instanceof PlanRefusal ||
		error instanceof InstallConflict ||
		error instanceof FetchError
	)
		return error.message
	return stateFailure(error).message
}

/** Throws the person-readable sentence for whatever went wrong. */
function rethrow(error: unknown): never {
	if (error instanceof Error && error.message === PLUGIN_CANCELLED_MESSAGE) throw error
	throw new Error(line(reason(error)))
}

function recomputeDigest(plan: InstallPlan): string | undefined {
	try {
		const hashed = hashExecutableFiles(plan.root)
		return surfaceDigest(plan.surface, hashed.files, hashed.executable)
	} catch {
		return undefined
	}
}

/**
 * Refuses to plan when the consent view could not show everything that runs: a list past its cap
 * or a runnable string past RUN_MAX. Cutting it would hide the tail from the person who says yes.
 */
function assertViewable(surface: InstallPlan['surface']): void {
	const runnable: string[] = []
	for (const h of surface.hooks) runnable.push(h.event, h.matcher ?? '', h.run, h.from ?? '')
	for (const h of surface.fileHooks) runnable.push(h.name, h.event, h.run)
	for (const m of surface.mcpLocal)
		runnable.push(m.name, m.command, ...m.args, ...Object.keys(m.env))
	for (const m of surface.mcpRemote) runnable.push(m.name, m.origin, ...m.sendsEnv, ...m.headers)
	for (const m of surface.modules) runnable.push(m.path, ...(m.declares ?? []), m.refused ?? '')
	for (const r of surface.allowedTools) runnable.push(r.name, ...r.tools)
	const lists = [
		surface.hooks,
		surface.fileHooks,
		surface.mcpLocal,
		surface.mcpRemote,
		surface.modules,
		surface.allowedTools,
	]
	const tooMany = lists.some((l) => l.length > LIST_MAX)
	const tooLong = runnable.some((v) => v.length > RUN_MAX)
	if (tooMany || tooLong)
		throw new PlanRefusal(
			64,
			'This plugin runs more than can be shown in full here, so it was not read. Install it from the command line, which lists everything.',
		)
}

export interface PluginSurfaceView {
	hooks: { event: string; matcher?: string; type: string; run: string; from?: string }[]
	fileHooks: { kind: string; name: string; event: string; type: string; run: string }[]
	mcpLocal: {
		name: string
		command: string
		args: string[]
		envNames: string[]
		needsSetup?: true
	}[]
	mcpRemote: {
		name: string
		origin: string
		transport: string
		sendsEnv: string[]
		headers: string[]
		needsSetup?: true
	}[]
	modules: { path: string; declares?: string[]; isolated?: boolean; refused?: string }[]
	allowedTools: { kind: string; name: string; tools: string[] }[]
	scripts: { path: string; bytes: number; exec: boolean }[]
	scriptsTotal: number
	unpinnedDownload: boolean
}

/**
 * The consent surface as the page reads it: every runnable kind, bounded. A local server's
 * environment is named, never valued: a value the plugin wrote may be a secret.
 */
export function surfaceView(surface: InstallPlan['surface']): PluginSurfaceView {
	assertViewable(surface)
	// Runnable text is shown whole: assertViewable refused anything that would need cutting.
	const text = (value: string) => value
	const names = (values: readonly string[]) => values.map(text)
	return {
		hooks: surface.hooks.map((hook) => ({
			event: text(hook.event),
			...(hook.matcher !== undefined ? { matcher: text(hook.matcher) } : {}),
			type: hook.type,
			run: text(hook.run),
			...(hook.from !== undefined ? { from: text(hook.from) } : {}),
		})),
		fileHooks: surface.fileHooks.map((hook) => ({
			kind: hook.kind,
			name: text(hook.name),
			event: text(hook.event),
			type: hook.type,
			run: text(hook.run),
		})),
		mcpLocal: surface.mcpLocal.map((server) => ({
			name: text(server.name),
			command: text(server.command),
			args: names(server.args),
			envNames: names(Object.keys(server.env)),
			...(server.needsSetup ? { needsSetup: true as const } : {}),
		})),
		mcpRemote: surface.mcpRemote.map((server) => ({
			name: text(server.name),
			origin: text(server.origin),
			transport: server.transport,
			sendsEnv: names(server.sendsEnv),
			headers: names(server.headers),
			...(server.needsSetup ? { needsSetup: true as const } : {}),
		})),
		modules: surface.modules.map((module) => ({
			path: text(module.path),
			...(module.declares !== undefined ? { declares: names(module.declares) } : {}),
			...(module.isolated !== undefined ? { isolated: module.isolated } : {}),
			...(module.refused !== undefined ? { refused: text(module.refused) } : {}),
		})),
		allowedTools: surface.allowedTools.map((row) => ({
			kind: row.kind,
			name: text(row.name),
			tools: names(row.tools),
		})),
		scripts: surface.scripts.slice(0, LIST_MAX).map((script) => ({
			path: text(script.path),
			bytes: script.bytes,
			exec: script.exec,
		})),
		scriptsTotal: surface.scripts.length,
		unpinnedDownload: surface.unpinnedDownload,
	}
}

function findingsView(plan: InstallPlan) {
	return plan.findings
		.filter((finding) => finding.level !== 'used')
		.slice(0, FINDINGS_MAX)
		.map((finding) => ({
			level: finding.level,
			code: finding.code,
			...(finding.field !== undefined ? { field: line(finding.field) } : {}),
			message: line(finding.message),
		}))
}

function scopeSentence(scope: RecordScope): string {
	return scope === 'user'
		? 'scope: user (every folder on this computer)'
		: scope === 'project'
			? 'scope: project (this folder, shared in .namzu/settings.json)'
			: 'scope: local (this folder, only on this computer)'
}

export function createDesktopPluginActions(deps: PluginActionDeps) {
	const now = deps.now ?? (() => Date.now())
	const home = namzuHomePath(deps.home)
	const stages = new Map<string, Held>()
	const plans = new Map<string, PlanEntry>()
	const ops = new Map<string, AbortController>()
	/** The newest version a check found, by id: what the list calls `updateKnown`. */
	const knownUpdates = new Map<string, string>()

	const trusted = (): boolean => deps.isTrusted(deps.cwd)
	const guard = (scope?: RecordScope): void => {
		if (deps.pal()) throw new Error(PLUGIN_PAL_MESSAGE)
		if (scope !== undefined && scope !== 'user' && !trusted()) throw new Error(PLUGIN_TRUST_MESSAGE)
	}
	/** The folder plans and records read: an untrusted folder's own plugins are not read. */
	const effectiveCwd = (): string => realPathOrResolved(trusted() ? deps.cwd : home)
	const projectCwd = (): string => realPathOrResolved(deps.cwd)

	const release = (plan: InstallPlan): void => {
		const used =
			[...stages.values()].some((held) => held.plan === plan) ||
			[...plans.values()].some((held) => held.plan === plan)
		if (!used) discardStaging(plan.stagingDir)
	}
	const prune = (): void => {
		const at = now()
		for (const [id, held] of stages) {
			if (held.expiresAt > at) continue
			stages.delete(id)
			release(held.plan)
		}
		for (const [id, held] of plans) {
			if (held.expiresAt > at) continue
			plans.delete(id)
			release(held.plan)
		}
	}
	const evictOldest = <T extends Held>(map: Map<string, T>, max: number): void => {
		while (map.size >= max) {
			const oldest = map.keys().next().value
			if (oldest === undefined) return
			const held = map.get(oldest)
			map.delete(oldest)
			if (held) release(held.plan)
		}
	}

	const op = (
		raw: unknown,
		first: 'checking' | 'reading' = 'checking',
	): OpContext & { end(): void } => {
		const opId = raw === undefined ? undefined : typeof raw === 'string' ? raw : ''
		if (opId !== undefined && !OP_ID.test(opId)) throw new Error('Invalid opId.')
		if (opId !== undefined && ops.has(opId)) throw new Error('That step is already running.')
		const controller = new AbortController()
		if (opId !== undefined) ops.set(opId, controller)
		const context: OpContext & { end(): void } = {
			signal: controller.signal,
			progress: (phase) => {
				if (opId !== undefined) deps.notify?.(OP_PROGRESS_NOTIFICATION, { opId, phase })
			},
			check: () => {
				if (controller.signal.aborted) throw new Error(PLUGIN_CANCELLED_MESSAGE)
			},
			end: () => {
				if (opId !== undefined) ops.delete(opId)
			},
		}
		context.progress(first)
		return context
	}

	const knownRead = () => {
		const known = readKnownMarketplaces(home)
		if (known.state === 'unreadable')
			throw new Error(
				`The marketplace list could not be read, so nothing was changed (${known.reason}).`,
			)
		return known
	}
	const installedRead = () => {
		const read = readInstalledPlugins(home)
		if (read.state === 'unreadable')
			throw new Error(
				`The install record could not be read, so nothing was changed: ${installedPluginsPath(home)} (${read.reason}).`,
			)
		return read
	}
	const catalogOf = (known: KnownMarketplace) =>
		readCatalog(known.installLocation, known.source.source === 'file' ? 'file' : 'directory')

	/** The catalog entry an id names, as a source the planner reads. */
	const blocked = (): readonly string[] => deps.blockedMarketplaces?.() ?? []
	/** What a download is given: the test options, and the step's signal so a cancel kills Git. */
	const fetchOf = (context?: OpContext): FetchOptions => ({
		...(deps.fetch ?? {}),
		...(context ? { signal: context.signal } : {}),
	})
	const allowFile = deps.fetch?.allowFileProtocol === true
	const sourceForId = async (id: string): Promise<InstallSource> => {
		const { name, marketplace } = splitPluginId(id)
		if (marketplace === LOCAL_UPLOADS_MARKETPLACE) {
			const recorded = readInstallManifest(home, id)
			const from = recorded.state === 'ok' ? recorded.manifest.installedFrom?.source : undefined
			if (typeof from !== 'string' || !existsSync(from))
				throw new Error(
					`${id} was installed from ${typeof from === 'string' ? from : 'a file or folder'}, which is not there now. Choose the file or folder again.`,
				)
			return { kind: 'path', path: from }
		}
		const market = knownRead().marketplaces.get(marketplace)
		if (market === undefined)
			throw new Error(`Marketplace "${marketplace}" is not added. Add it first.`)
		const read = catalogOf(market)
		if (!read.ok) throw new Error(read.reason)
		const entry = read.catalog.entries.find((candidate) => candidate.name === name)
		if (entry === undefined)
			throw new Error(`Plugin "${name}" is not in marketplace "${marketplace}".`)
		const resolved = await resolveEntrySource(entry, read.catalog, {
			hosted: market.source.source === 'url',
			...(allowFile ? { allowFileProtocol: true } : {}),
		})
		if (resolved.kind === 'unsupported') throw new Error(resolved.reason)
		if (resolved.kind === 'invalid')
			throw new Error(
				resolved.reason.startsWith(`${entry.name}: `)
					? resolved.reason
					: `${entry.name}: ${resolved.reason}`,
			)
		if (resolved.kind === 'remote') {
			// Before any download: a marketplace or a source the settings block is never fetched from.
			if (downloadBlocked(market, resolved.remote, blocked())) throw new Error(DOWNLOAD_BLOCKED)
			return { kind: 'remote-catalog', marketplace, entry, remote: resolved.remote }
		}
		const commit =
			market.source.source === 'github' || market.source.source === 'git'
				? market.commit
				: undefined
		return {
			kind: 'catalog',
			marketplace,
			entry,
			dir: resolved.dir,
			...(commit !== undefined ? { commit } : {}),
		}
	}

	/**
	 * A plugin from a marketplace that lives at an address is checked against that marketplace as it
	 * is now: only that one marketplace is fetched, and only because the person asked to check.
	 */
	const refreshOwnMarketplace = async (id: string, context: OpContext): Promise<void> => {
		const { marketplace } = splitPluginId(id)
		if (marketplace === LOCAL_UPLOADS_MARKETPLACE) return
		const market = knownRead().marketplaces.get(marketplace)
		if (market === undefined) return
		if (market.source.source === 'directory' || market.source.source === 'file') return
		context.check()
		context.progress('downloading')
		const row = await refreshRemoteMarketplace(market, {
			home,
			now: new Date(now()),
			blockedMarketplaces: blocked(),
			fetch: fetchOf(context),
		})
		if (row.outcome === 'failed')
			throw new Error(`Could not read marketplace "${marketplace}" again: ${row.message}`)
	}

	const planOf = async (source: InstallSource, context: OpContext): Promise<InstallPlan> => {
		context.check()
		context.progress(source.kind === 'remote-catalog' ? 'downloading' : 'reading')
		let plan: InstallPlan
		try {
			plan = await planInstall(source, {
				home,
				cwd: effectiveCwd(),
				fetch: fetchOf(context),
			})
		} catch (error) {
			rethrow(error)
		}
		if (context.signal.aborted) {
			discardStaging(plan.stagingDir)
			throw new Error(PLUGIN_CANCELLED_MESSAGE)
		}
		return plan
	}

	const recordsOf = (id: string, scope: RecordScope): InstallRecord | undefined =>
		(installedRead().plugins.get(id) ?? []).find(
			(record) =>
				record.scope === scope &&
				(scope === 'user' ||
					(record.projectPath !== undefined && samePath(record.projectPath, projectCwd()))),
		)

	/** `marketplaces/add` for a repository or an https address: fetch aside, read, then move into place. */
	const addRemote = async (source: MarketplaceSource, scope: RecordScope, context: OpContext) => {
		const display = describeSource(source)
		// Before anything is fetched: the settings may forbid this marketplace.
		if (isBlockedSource(source, blocked())) throw new Error(MARKETPLACE_BLOCKED)
		const known = knownRead()
		const staging = newStaging(home)
		try {
			context.check()
			context.progress('downloading')
			const fetched = await fetchMarketplace(source, staging, fetchOf(context))
			context.check()
			context.progress('reading')
			const read = readFetchedCatalog(fetched.dir, display)
			if (!read.ok) throw new Error(read.message)
			const { catalog } = read
			const problem = marketplaceNameProblem(catalog.name)
			if (problem !== undefined) throw new Error(problem)
			const where = { home, cwd: effectiveCwd() }
			const notInstallable = await countNotInstallable(catalog, source.source === 'url', allowFile)
			const notes = [
				...fetchNotes(fetched),
				...(notInstallable > 0
					? [`${notInstallable} of its plugins cannot be installed here.`]
					: []),
			]
			const summary = (outcome: string) => ({
				name: catalog.name,
				plugins: catalog.entries.length,
				outcome,
				warnings: [...catalog.warnings, ...notes].slice(0, FINDINGS_MAX).map(line),
			})
			const existing = known.marketplaces.get(catalog.name)
			if (existing !== undefined) {
				if (!sameSource(existing.source, source))
					throw new Error(anotherPlace(catalog.name, existing.source, source, 'Remove it first.'))
				const layerPath = recordLayerPath(scope, where)
				const layer = readRecordLayer(layerPath)
				if (layer.state !== 'unreadable' && !layer.marketplaces.has(catalog.name)) {
					setExtraKnownMarketplace(layerPath, home, catalog.name, source)
					return summary('declared')
				}
				return summary('already-added')
			}
			context.check()
			placeMarketplace(catalog, source, fetched, {
				home,
				cwd: effectiveCwd(),
				scope,
				now: new Date(now()),
				by: 'desktop',
				layerPath: recordLayerPath(scope, where),
			})
			return summary('added')
		} finally {
			discardStaging(staging)
		}
	}

	const methods = {
		/** What an address would be, from its text alone: no network, no disk beyond the path. */
		'namzu/marketplaces/preview': (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['source'], ['source'], 'marketplace preview')
			const source = field(record, 'source', PLUGIN_PATH_MAX_CHARS)
			const address = parseMarketplaceAddress(source, deps.cwd)
			if (address.kind === 'refused') return { error: line(address.message) }
			if (address.kind === 'remote')
				return {
					source: line(address.text),
					kind: address.form,
					remote: true,
					description: line(describeAddition(address.source)),
					notice: MARKETPLACE_NOTICE,
					...(isBlockedSource(address.source, blocked()) ? { blocked: MARKETPLACE_BLOCKED } : {}),
				}
			return {
				source: line(address.path),
				kind: 'path',
				remote: false,
				notice: MARKETPLACE_NOTICE,
			}
		},
		'namzu/marketplaces/add': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['source', 'scope', 'accepted', 'opId'],
				['source', 'scope', 'accepted'],
				'marketplace add',
			)
			const source = field(record, 'source', PLUGIN_PATH_MAX_CHARS)
			const scope = scopeOf(record)
			if (record.accepted !== 'marketplace-v1') throw new Error('Read the notice first.')
			guard(scope)
			const context = op(record.opId)
			try {
				const address = parseMarketplaceAddress(source, deps.cwd)
				if (address.kind === 'refused') throw new Error(address.message)
				if (address.kind === 'remote') return await addRemote(address.source, scope, context)
				const real = realPathOf(address.path)
				if (real === undefined) throw new Error(`${line(address.path)} was not found.`)
				if (/^\\\\/.test(real))
					throw new Error(
						'A network share is not accepted. Copy the marketplace to this computer first.',
					)
				let kind: 'directory' | 'file'
				try {
					const stat = lstatSync(real)
					if (stat.isDirectory()) kind = 'directory'
					else if (stat.isFile() && real.toLowerCase().endsWith('.json')) kind = 'file'
					else
						throw new Error('Not a marketplace address. A marketplace is a folder or a .json file.')
				} catch (error) {
					if (error instanceof Error && error.message.startsWith('Not a marketplace')) throw error
					throw new Error(`${line(real)} was not found.`)
				}
				context.check()
				context.progress('reading')
				const read = readCatalog(real, kind)
				if (!read.ok) throw new Error(read.reason)
				const { catalog } = read
				const problem = marketplaceNameProblem(catalog.name)
				if (problem !== undefined) throw new Error(problem)
				context.check()
				const known = knownRead()
				const where = { home, cwd: effectiveCwd() }
				const sourceRecord = { source: kind, path: real }
				const existing = known.marketplaces.get(catalog.name)
				const summary = (outcome: string) => ({
					name: catalog.name,
					plugins: catalog.entries.length,
					outcome,
					warnings: catalog.warnings.slice(0, FINDINGS_MAX).map(line),
				})
				if (existing !== undefined) {
					if (
						existing.source.source === kind &&
						samePath(String(existing.source.path ?? ''), real)
					) {
						const layerPath = recordLayerPath(scope, where)
						const layer = readRecordLayer(layerPath)
						if (layer.state !== 'unreadable' && !layer.marketplaces.has(catalog.name)) {
							setExtraKnownMarketplace(layerPath, home, catalog.name, sourceRecord)
							return summary('declared')
						}
						return summary('already-added')
					}
					throw new Error(
						`A marketplace named "${catalog.name}" is already added from another place (${line(String(existing.source.path ?? existing.source.source))}). Remove it first.`,
					)
				}
				const at = new Date(now()).toISOString()
				putKnownMarketplace(home, catalog.name, {
					source: sourceRecord,
					installLocation: real,
					lastUpdated: at,
					autoUpdate: false,
					consent: { at, by: 'desktop', notice: 'marketplace-v1' },
				})
				setExtraKnownMarketplace(recordLayerPath(scope, where), home, catalog.name, sourceRecord)
				return summary('added')
			} catch (error) {
				rethrow(error)
			} finally {
				context.end()
			}
		},
		'namzu/marketplaces/list': (params: Record<string, unknown>) => {
			guard()
			exactKeys(params ?? {}, [], [], 'marketplace list')
			const known = knownRead()
			const installed = readInstalledPlugins(home)
			const counts = new Map<string, number>()
			if (installed.state !== 'unreadable')
				for (const id of installed.plugins.keys()) {
					const { marketplace } = splitPluginId(id)
					counts.set(marketplace, (counts.get(marketplace) ?? 0) + 1)
				}
			const marketplaces = [...known.marketplaces.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, LIST_MAX)
				.map((market) => {
					const read = catalogOf(market)
					return {
						name: market.name,
						source: line(describeSource(market.source)),
						kind: market.source.source,
						lastUpdated: market.lastUpdated ?? null,
						autoUpdate: market.autoUpdate ?? false,
						plugins: read.ok ? read.catalog.entries.length : null,
						installed: counts.get(market.name) ?? 0,
						...(read.ok ? {} : { problem: line(read.reason) }),
					}
				})
			const layers = readLayers(home, effectiveCwd(), trusted())
			const declaredByProject: { name: string; declaredBy: RecordLayer }[] = []
			for (const layer of ['project', 'local'] as const) {
				const read = layers[layer]
				if (read === undefined || read.state === 'unreadable') continue
				for (const market of read.marketplaces.values())
					if (!known.marketplaces.has(market.name))
						declaredByProject.push({ name: line(market.name), declaredBy: layer })
			}
			return {
				marketplaces,
				declaredByProject: declaredByProject.slice(0, LIST_MAX),
				problems: known.invalid.slice(0, FINDINGS_MAX).map((p) => line(`${p.id}: ${p.reason}`)),
			}
		},
		'namzu/marketplaces/remove': (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['name', 'confirm'],
				['name', 'confirm'],
				'marketplace remove',
			)
			const name = field(record, 'name', 64)
			if (record.confirm !== true) throw new Error('Confirm the removal first.')
			if (name === LOCAL_UPLOADS_MARKETPLACE)
				throw new Error(
					`${LOCAL_UPLOADS_MARKETPLACE} is not a marketplace; remove its plugins one by one.`,
				)
			const known = knownRead()
			if (!known.marketplaces.has(name)) throw new Error(`Marketplace "${name}" is not added.`)
			const installed = installedRead()
			const layers: RecordLayer[] = ['user']
			if (trusted()) layers.push('project', 'local')
			try {
				const removedPlugins: string[] = []
				const here = resolve(effectiveCwd())
				const inOtherFolders: string[] = []
				const isMine = (record: { scope: RecordScope; projectPath?: string }): boolean =>
					record.scope === 'user' ||
					(trusted() && record.projectPath !== undefined && resolve(record.projectPath) === here)
				for (const [id, records] of installed.plugins)
					if (splitPluginId(id).marketplace === name)
						for (const record of records)
							if (!isMine(record)) inOtherFolders.push(`${id} (${record.scope})`)
				// Another folder's settings are not written from here: say so before anything is removed.
				if (inOtherFolders.length > 0)
					throw new PlanRefusal(
						64,
						line(
							`${inOtherFolders.length === 1 ? 'A plugin' : 'Plugins'} from it ${inOtherFolders.length === 1 ? 'is' : 'are'} installed in another folder (${inOtherFolders.slice(0, 5).join(', ')}). Remove ${inOtherFolders.length === 1 ? 'it' : 'them'} there first.`,
						),
					)
				for (const [id, records] of installed.plugins) {
					if (splitPluginId(id).marketplace !== name) continue
					for (const record of records) {
						const result = removeInstall(
							id,
							{
								scope: record.scope,
								...(record.projectPath !== undefined ? { projectPath: record.projectPath } : {}),
							},
							{ home, now: new Date(now()), deleteData: false },
						)
						if (result.removedRecord) removedPlugins.push(`${id} (${record.scope})`)
					}
					knownUpdates.delete(id)
				}
				removeKnownMarketplace(home, name)
				for (const layer of layers) {
					const path = recordLayerPath(layer, { home, cwd: effectiveCwd() })
					const read = readRecordLayer(path)
					if (read.state !== 'unreadable' && read.marketplaces.has(name))
						removeExtraKnownMarketplace(path, home, name)
				}
				return {
					outcome: 'removed' as const,
					name,
					removedPlugins: removedPlugins.map(line),
				}
			} catch (error) {
				rethrow(error)
			}
		},
		/** Reads each marketplace again from where it is; a local one is a read of its folder. */
		'namzu/marketplaces/update': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['name', 'opId'], [], 'marketplace update')
			const only = record.name === undefined ? undefined : field(record, 'name', 64)
			const context = op(record.opId)
			try {
				const known = knownRead()
				if (only !== undefined && !known.marketplaces.has(only))
					throw new Error(`Marketplace "${only}" is not added.`)
				const results: {
					name: string
					outcome: 'updated' | 'up-to-date' | 'pinned' | 'failed'
					plugins?: number
					error?: string
					message?: string
				}[] = []
				for (const market of [...known.marketplaces.values()]
					.filter((m) => only === undefined || m.name === only)
					.sort((a, b) => a.name.localeCompare(b.name))
					.slice(0, LIST_MAX)) {
					context.check()
					const remote = market.source.source !== 'directory' && market.source.source !== 'file'
					if (remote) {
						context.progress('downloading')
						const row = await refreshRemoteMarketplace(market, {
							home,
							now: new Date(now()),
							blockedMarketplaces: blocked(),
							fetch: fetchOf(context),
						})
						if (row.outcome === 'failed') {
							results.push({ name: market.name, outcome: 'failed', error: line(row.message) })
							continue
						}
						for (const item of row.newer) knownUpdates.set(item.id, item.available)
						const reread = readKnownMarketplaces(home)
						const fresh =
							reread.state === 'unreadable' ? undefined : reread.marketplaces.get(market.name)
						const catalog = catalogOf(fresh ?? market)
						results.push({
							name: market.name,
							outcome: row.outcome as 'updated' | 'up-to-date' | 'pinned',
							...(catalog.ok ? { plugins: catalog.catalog.entries.length } : {}),
							message: line(row.message),
						})
						continue
					}
					const read = catalogOf(market)
					if (!read.ok) {
						results.push({ name: market.name, outcome: 'failed', error: line(read.reason) })
						continue
					}
					putKnownMarketplace(home, market.name, {
						source: market.source,
						installLocation: market.installLocation,
						lastUpdated: new Date(now()).toISOString(),
					})
					results.push({
						name: market.name,
						outcome: 'updated',
						plugins: read.catalog.entries.length,
					})
				}
				return { results }
			} catch (error) {
				rethrow(error)
			} finally {
				context.end()
			}
		},
		/** The plugins one marketplace offers, and which of them can be installed here. */
		'namzu/marketplaces/available': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['marketplace'], ['marketplace'], 'marketplace available')
			const name = field(record, 'marketplace', 64)
			const market = knownRead().marketplaces.get(name)
			if (market === undefined) throw new Error(`Marketplace "${name}" is not added.`)
			const read = catalogOf(market)
			if (!read.ok) throw new Error(line(read.reason))
			const catalog: Catalog = read.catalog
			const installed = readInstalledPlugins(home)
			const plugins = []
			for (const entry of catalog.entries.slice(0, MAX_CATALOG_PLUGINS)) {
				const id = `${entry.name}@${name}`
				const resolved = await resolveEntrySource(entry, catalog, {
					hosted: market.source.source === 'url',
					...(allowFile ? { allowFileProtocol: true } : {}),
				})
				const scopes =
					installed.state === 'unreadable'
						? []
						: [...new Set((installed.plugins.get(id) ?? []).map((r) => r.scope))]
				plugins.push({
					name: line(entry.name),
					id,
					...(entry.description !== undefined ? { description: line(entry.description) } : {}),
					...(entry.version !== undefined ? { version: line(entry.version) } : {}),
					...(entry.author !== undefined ? { author: line(entry.author) } : {}),
					installable: resolved.kind === 'local' || resolved.kind === 'remote',
					...(resolved.kind === 'local' || resolved.kind === 'remote'
						? {}
						: { reason: line(resolved.reason) }),
					installedAt: scopes,
				})
			}
			return {
				marketplace: name,
				plugins,
				warnings: catalog.warnings.slice(0, FINDINGS_MAX).map(line),
			}
		},
		/** Reads a plugin from a marketplace or a stage and says what it would do. Installs nothing. */
		'namzu/plugins/plan': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['id', 'stageId', 'scope', 'opId'], ['scope'], 'plugin plan')
			if ((record.id === undefined) === (record.stageId === undefined))
				throw new Error('Invalid plugin plan request.')
			const scope = scopeOf(record)
			guard(scope)
			prune()
			const context = op(record.opId)
			try {
				let plan: InstallPlan
				let stageId: string | undefined
				if (record.stageId !== undefined) {
					stageId = field(record, 'stageId', 100)
					const stage = stages.get(stageId)
					if (!stage) throw new Error(PLUGIN_GONE_MESSAGE)
					plan = stage.plan
				} else {
					plan = await planOf(await sourceForId(pluginId(record)), context)
				}
				evictOldest(plans, PLUGIN_PLAN_MAX)
				const planId = randomUUID()
				const expiresAt = now() + PLUGIN_STAGE_TTL_MS
				plans.set(planId, { plan, scope, expiresAt, ...(stageId ? { stageId } : {}) })
				const have = recordsOf(plan.id, scope)
				return {
					planId,
					digest: plan.digest,
					id: plan.id,
					name: line(plan.name),
					version: line(plan.version),
					layout: plan.layout,
					scope,
					components: {
						skills: plan.inventory.skills.slice(0, LIST_MAX).map(line),
						commands: plan.inventory.commands.slice(0, LIST_MAX).map(line),
						agents: plan.inventory.agents.slice(0, LIST_MAX).map(line),
					},
					surface: surfaceView(plan.surface),
					findings: findingsView(plan),
					warnings: plan.warnings.slice(0, FINDINGS_MAX).map(line),
					preview: renderInstallPreview(plan, { scopeLine: scopeSentence(scope) }).slice(0, 20_000),
					...(have !== undefined ? { installed: { version: have.version ?? null } } : {}),
					loadingOn: deps.loadingOn(),
					expiresAt: new Date(expiresAt).toISOString(),
				}
			} catch (error) {
				rethrow(error)
			} finally {
				context.end()
			}
		},
		/** Reads a chosen archive or folder aside, so what is shown is the copy that would run. */
		'namzu/plugins/stage': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['path', 'opId'], ['path'], 'plugin stage')
			const path = field(record, 'path', PLUGIN_PATH_MAX_CHARS)
			if (!isAbsolute(path)) throw new Error('That path cannot be used.')
			prune()
			const context = op(record.opId)
			try {
				let stat: ReturnType<typeof lstatSync>
				try {
					stat = lstatSync(path)
				} catch {
					throw new Error('That file or folder could not be read.')
				}
				if (stat.isSymbolicLink())
					throw new Error('That is a link. Plugins are added as plain files and folders only.')
				if (!stat.isFile() && !stat.isDirectory())
					throw new Error('That is not a file or a folder.')
				const plan = await planOf({ kind: 'path', path: resolve(path) }, context)
				evictOldest(stages, PLUGIN_STAGE_MAX)
				const stageId = randomUUID()
				const expiresAt = now() + PLUGIN_STAGE_TTL_MS
				stages.set(stageId, { plan, expiresAt })
				return {
					stageId,
					name: line(plan.name),
					version: line(plan.version),
					expiresAt: new Date(expiresAt).toISOString(),
				}
			} catch (error) {
				rethrow(error)
			} finally {
				context.end()
			}
		},
		/** Installs what `plan` showed, once, only with the digest the person saw. */
		'namzu/plugins/install': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['planId', 'digest', 'scope', 'consent', 'enableLoading', 'opId'],
				['planId', 'digest', 'scope', 'consent'],
				'plugin install',
			)
			const planId = field(record, 'planId', 100)
			const digest = field(record, 'digest', 64).toLowerCase()
			const scope = scopeOf(record)
			if (record.consent !== true) throw new Error('Say yes to what it does first.')
			const enableLoading = flag(record, 'enableLoading') === true
			guard(scope)
			prune()
			const entry = plans.get(planId)
			if (!entry) throw new Error(PLUGIN_GONE_MESSAGE)
			if (entry.scope !== scope) throw new Error(PLUGIN_PLACE_MESSAGE)
			if (digest !== entry.plan.digest) throw new Error(PLUGIN_CHANGED_MESSAGE)
			const context = op(record.opId)
			try {
				context.check()
				if (recomputeDigest(entry.plan) !== entry.plan.digest) {
					plans.delete(planId)
					release(entry.plan)
					throw new Error(PLUGIN_CHANGED_MESSAGE)
				}
				plans.delete(planId)
				if (entry.stageId) stages.delete(entry.stageId)
				let outcome: ReturnType<typeof commitInstall>
				try {
					outcome = commitInstall(entry.plan, {
						home,
						now: new Date(now()),
						scope,
						cwd: projectCwd(),
						consent: { by: 'desktop', nonInteractive: false },
					})
				} finally {
					// Left in place after a failed move, the copy is still there for `prune`; after a
					// good one the staging folder is empty.
					for (const [id, held] of plans) if (held.plan === entry.plan) plans.delete(id)
					for (const [id, held] of stages) if (held.plan === entry.plan) stages.delete(id)
					discardStaging(entry.plan.stagingDir)
				}
				let loading: 'on' | 'off' = deps.loadingOn() ? 'on' : 'off'
				const notes: string[] = []
				if (loading === 'off' && enableLoading) {
					try {
						notes.push(deps.enableLoading())
						loading = 'on'
					} catch (error) {
						notes.push(
							`Plugin loading could not be turned on (${error instanceof Error ? error.message : String(error)}).`,
						)
					}
				}
				if (loading === 'off')
					notes.push('Plugin loading is off, so it will not run until it is turned on.')
				knownUpdates.delete(entry.plan.id)
				const id = entry.plan.id
				return {
					id,
					outcome: outcome.outcome,
					loading,
					message:
						outcome.outcome === 'already-installed'
							? `${id} ${entry.plan.version} is already installed (scope: ${scope}); nothing changed.`
							: `Installed ${id} ${entry.plan.version} (scope: ${scope}). ${PLUGIN_LOADS_NEXT_NOTE}`,
					...(notes.length > 0 ? { notes: notes.map(line) } : {}),
				}
			} catch (error) {
				rethrow(error)
			} finally {
				context.end()
			}
		},
		/** Writes the saved yes or no for an installed plugin; the per-conversation switch is separate. */
		'namzu/plugins/enable': (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['id', 'scope', 'enabled'],
				['id', 'scope', 'enabled'],
				'plugin enable',
			)
			const id = pluginId(record)
			const scope = scopeOf(record)
			if (typeof record.enabled !== 'boolean') throw new Error('Invalid enabled.')
			guard(scope)
			const records = installedRead().plugins.get(id) ?? []
			if (
				!records.some(
					(r) =>
						r.scope === 'user' ||
						(r.projectPath !== undefined && samePath(r.projectPath, projectCwd())),
				)
			)
				throw new Error(`${id} is not installed for this folder or for you.`)
			const path = recordLayerPath(scope, { home, cwd: effectiveCwd() })
			const own = readRecordLayer(path)
			if (own.state === 'unreadable')
				throw new Error(
					`The plugin records in ${path} could not be read (${own.reason}), so nothing was changed.`,
				)
			let changed = false
			try {
				if (own.enabledPlugins.get(id) !== record.enabled) {
					setEnabledPlugin(path, home, id, record.enabled)
					changed = true
				}
			} catch (error) {
				rethrow(error)
			}
			const answer = currentEnabledAnswer(
				{ home, cwd: effectiveCwd(), projectTrusted: trusted() },
				id,
			)
			return {
				outcome: changed ? (record.enabled ? 'enabled' : 'disabled') : 'unchanged',
				id,
				scope,
				effective: { enabled: answer.on, ...(answer.by ? { by: answer.by } : {}) },
				loading: deps.loadingOn() ? ('on' as const) : ('off' as const),
				note: PLUGIN_LOADS_NEXT_NOTE,
			}
		},
		/** Re-reads the source of that plugin's own marketplace (the folder is replaced and its update record refreshed) and says whether a newer version is there. */
		'namzu/plugins/update_check': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['id', 'opId'], ['id'], 'plugin update check')
			const id = pluginId(record)
			const context = op(record.opId)
			let plan: InstallPlan | undefined
			try {
				const current = (installedRead().plugins.get(id) ?? [])[0]
				if (current === undefined) throw new Error(`${id} is not installed.`)
				const recorded = readInstallManifest(home, id)
				if (recorded.state !== 'ok')
					throw new Error(`${id} has no readable install manifest. Install it again.`)
				await refreshOwnMarketplace(id, context)
				plan = await planOf(await sourceForId(id), context)
				if (plan.name !== splitPluginId(id).name)
					throw new Error(`The source now holds "${plan.name}", not ${splitPluginId(id).name}.`)
				if (current.version === plan.version && recorded.manifest.surfaceSha256 !== plan.digest)
					throw new Error(sameVersionChanged(id, plan.version))
				const comparison = compareUpdate(recorded.manifest, plan)
				const upToDate =
					current.version === plan.version && recorded.manifest.surfaceSha256 === plan.digest
				if (upToDate) knownUpdates.delete(id)
				else knownUpdates.set(id, plan.version)
				return {
					id,
					current: current.version ?? null,
					latest: line(plan.version),
					upToDate,
					changesExecutable: !comparison.unchangedSurface,
				}
			} catch (error) {
				rethrow(error)
			} finally {
				if (plan) discardStaging(plan.stagingDir)
				context.end()
			}
		},
		/**
		 * Brings an installed plugin to what its source holds now. When what runs changed, nothing is
		 * written until the call comes back with the digest of what was shown (`acceptDigest`).
		 */
		'namzu/plugins/update': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['id', 'acceptDigest', 'opId'], ['id'], 'plugin update')
			const id = pluginId(record)
			const accepted =
				record.acceptDigest === undefined
					? undefined
					: field(record, 'acceptDigest', 64).toLowerCase()
			const context = op(record.opId)
			let plan: InstallPlan | undefined
			try {
				const current = (installedRead().plugins.get(id) ?? [])[0]
				if (current === undefined) throw new Error(`${id} is not installed.`)
				if (current.scope !== 'user' && !trusted()) throw new Error(PLUGIN_TRUST_MESSAGE)
				const recorded = readInstallManifest(home, id)
				if (recorded.state !== 'ok')
					throw new Error(`${id} has no readable install manifest. Install it again.`)
				plan = await planOf(await sourceForId(id), context)
				if (plan.name !== splitPluginId(id).name)
					throw new Error(`The source now holds "${plan.name}", not ${splitPluginId(id).name}.`)
				if (current.version === plan.version && recorded.manifest.surfaceSha256 === plan.digest) {
					knownUpdates.delete(id)
					return {
						outcome: 'up-to-date' as const,
						id,
						from: current.version ?? null,
						to: line(plan.version),
						message: `${id} is up to date (${plan.version}).`,
					}
				}
				// The same version with other files cannot be applied: say so before a question that could only end in a refusal.
				if (current.version === plan.version) throw new Error(sameVersionChanged(id, plan.version))
				const { changes, unchangedSurface } = compareUpdate(recorded.manifest, plan)
				if (!unchangedSurface && accepted !== plan.digest) {
					return {
						outcome: 'needs-consent' as const,
						id,
						from: current.version ?? null,
						to: line(plan.version),
						digest: plan.digest,
						changes: changes.slice(0, FINDINGS_MAX).map(line),
						surface: surfaceView(plan.surface),
						preview: renderInstallPreview(plan, {
							scopeLine: '',
							headline: `Update ${id} from ${current.version ?? '?'} to ${plan.version}?`,
							changes: [
								...(current.version !== plan.version
									? [`Version ${current.version ?? '?'} to ${plan.version}`]
									: []),
								...(changes.length > 0
									? changes
									: ['Files that configure or run the plugin changed.']),
							],
						}).slice(0, 20_000),
					}
				}
				context.check()
				const result = commitUpdate(plan, {
					home,
					now: new Date(now()),
					consent: { by: 'desktop', nonInteractive: false },
				})
				knownUpdates.delete(id)
				return {
					outcome: result.outcome,
					id,
					from: result.from ?? null,
					to: line(result.to),
					message:
						result.outcome === 'up-to-date'
							? `${id} is up to date (${plan.version}).`
							: `Updated ${id} from ${result.from ?? '?'} to ${result.to}. ${PLUGIN_LOADS_NEXT_NOTE}`,
				}
			} catch (error) {
				rethrow(error)
			} finally {
				if (plan) discardStaging(plan.stagingDir)
				context.end()
			}
		},
		'namzu/plugins/uninstall': (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['id', 'scope', 'deleteData', 'confirm'],
				['id', 'scope', 'confirm'],
				'plugin uninstall',
			)
			const id = pluginId(record)
			const scope = scopeOf(record)
			if (record.confirm !== true) throw new Error('Confirm the removal first.')
			const deleteData = flag(record, 'deleteData') === true
			guard(scope)
			const chosen = recordsOf(id, scope)
			if (chosen === undefined) throw new Error(`${id} is not installed at scope ${scope} here.`)
			try {
				const result = removeInstall(
					id,
					{
						scope,
						...(chosen.projectPath !== undefined ? { projectPath: chosen.projectPath } : {}),
					},
					{ home, now: new Date(now()), deleteData },
				)
				if (!result.removedRecord) throw new Error(`${id} is not installed at scope ${scope}.`)
				if (result.remaining === 0) knownUpdates.delete(id)
				return {
					outcome: 'uninstalled' as const,
					id,
					scope,
					dataKept: result.dataKept,
					dataDeleted: result.dataDeleted,
					remaining: result.remaining,
				}
			} catch (error) {
				rethrow(error)
			}
		},
		'namzu/ops/cancel': (params: Record<string, unknown>) => {
			const record = exactKeys(params, ['opId'], ['opId'], 'cancel')
			const opId = field(record, 'opId', 64)
			if (!OP_ID.test(opId)) throw new Error('Invalid opId.')
			const controller = ops.get(opId)
			if (!controller) return { cancelled: false }
			controller.abort()
			return { cancelled: true }
		},
	}

	/** What `namzu/plugins/list` adds to each row: its id, where it came from, and what it is. */
	const enrichList = <T extends { plugins: readonly { name: string }[] }>(view: T): T => {
		const read = readInstalledPlugins(home)
		if (read.state === 'unreadable') return view
		const byName = new Map<string, { id: string; records: readonly InstallRecord[] }>()
		for (const [id, records] of read.plugins) byName.set(splitPluginId(id).name, { id, records })
		return {
			...view,
			plugins: view.plugins.map((plugin) => {
				const found = byName.get(plugin.name)
				if (!found) return plugin
				const first = found.records[0]
				const counts: Record<string, number> = {}
				for (const finding of first?.findings ?? [])
					counts[finding.level] = (counts[finding.level] ?? 0) + 1
				return {
					...plugin,
					id: found.id,
					marketplace: splitPluginId(found.id).marketplace,
					...(first?.layout ? { layout: first.layout } : {}),
					installed: [...new Set(found.records.map((r) => r.scope))],
					findings: counts,
					...(knownUpdates.has(found.id) ? { updateKnown: true } : {}),
				}
			}),
		}
	}

	/**
	 * The plugins installed here that the listing did not name: with no conversation open the
	 * listing reads only the plugin folders, so a plugin installed from a marketplace or an upload
	 * would be missing from the page that installed it. A row is read from the install record and
	 * its own manifest; nothing is run.
	 */
	const withInstalled = async <
		T extends { plugins: readonly { name: string }[]; live?: boolean; notice?: string },
	>(
		given: T,
	): Promise<T> => {
		// The listing was read with the settings the host started with; loading turned on since then
		// (by an install that asked for it) is not "off", so the old line would contradict the page.
		let view = given
		if (view.notice === 'Plugins are off for this project.' && deps.loadingOn()) {
			const { notice: _stale, ...rest } = view
			view = rest as T
		}
		const plan = planInstalledPlugins({
			home,
			cwd: effectiveCwd(),
			projectTrusted: trusted(),
			allowedScopes: ['user', 'project'],
		})
		const listed = new Set(view.plugins.map((plugin) => plugin.name))
		const missing = plan.candidates.filter((candidate) => !listed.has(candidate.name))
		if (missing.length === 0) return view
		const where = {
			home,
			cwd: effectiveCwd(),
			installedNames: new Set(plan.candidates.map((candidate) => candidate.name)),
		}
		const rows: Record<string, unknown>[] = []
		for (const candidate of missing.slice(0, 100)) {
			try {
				const manifest = await loadInstalledManifest(candidate, where)
				rows.push({
					...(await readPluginManifestDetails(candidate.installPath, manifest)),
					name: line(manifest.name),
					version: line(manifest.version ?? candidate.record.version ?? ''),
					description: line(manifest.description ?? ''),
					scope: candidate.scope,
					status: view.live === true && !candidate.answer.on ? 'disabled' : 'installed',
					startupEnabled: candidate.answer.on,
				})
			} catch {
				rows.push({
					name: line(candidate.name),
					version: line(candidate.record.version ?? ''),
					description: '',
					scope: candidate.scope,
					status: 'error',
					startupError: 'This plugin’s manifest could not be read or validated.',
				})
			}
		}
		return { ...view, plugins: [...view.plugins, ...(rows as unknown as T['plugins'])] }
	}

	return { methods, enrichList, withInstalled, stages, plans, ops, prune }
}
