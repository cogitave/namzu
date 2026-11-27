/**
 * `namzu plugin install | uninstall | update | prune` and
 * `namzu plugin marketplace add | list | remove`: the command line over the
 * install writers (`integrations/plugins/install.ts`), for local sources: a
 * marketplace that is a folder or a `.json` file on this computer, a plugin
 * folder, or a plugin archive.
 *
 * Installing a plugin runs nothing and fetches nothing. The plugin is copied
 * to a staging folder and read there; the person sees every runnable thing in
 * it (hooks, servers, modules, scripts, pre-approved tools) and a digest of
 * that surface, and only a yes (typed, `--yes`, or `--accept-surface` with the
 * digest that was shown) moves it into place. With no terminal and neither
 * flag the preview is printed and the command exits 75: nothing is installed
 * on a guess.
 *
 * `--json` prints one object on standard output and nothing else there; every
 * prompt and notice goes to standard error.
 *
 * Exit status: 0 done (also "nothing to do"), 1 failed or declined, 64 the
 * command line is wrong, 65 refused data (an unsafe archive, a plugin Namzu
 * cannot take), 66 not found or a record could not be read, 69 unavailable
 * (an address that needs a download), 75 a yes is needed and none can be
 * asked, 77 the folder is not trusted.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
	EXIT_DATAERR,
	EXIT_FAIL,
	EXIT_NEEDS_CONSENT,
	EXIT_NOINPUT,
	EXIT_OK,
	EXIT_UNAVAILABLE,
	EXIT_UNTRUSTED,
	EXIT_USAGE,
} from '../exit-codes.js'
import {
	type RecordLayer,
	readRecordLayer,
	recordLayerPath,
	removeExtraKnownMarketplace,
	setEnabledPlugin,
	setExtraKnownMarketplace,
} from '../integrations/plugins/enabled-records.js'
import { readInstallManifest } from '../integrations/plugins/install-manifest.js'
import {
	type InstallPlan,
	type InstallSource,
	PlanRefusal,
	discardStaging,
	planInstall,
	usedPluginNames,
} from '../integrations/plugins/install-plan.js'
import { renderInstallPreview } from '../integrations/plugins/install-preview.js'
import {
	InstallConflict,
	type InstallStep,
	SimulatedCrash,
	commitInstall,
	commitUpdate,
	prune,
	removeInstall,
} from '../integrations/plugins/install.js'
import { readLayers } from '../integrations/plugins/installed-source.js'
import {
	type Catalog,
	LOCAL_UPLOADS_MARKETPLACE,
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
	installedPluginDataFolder,
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
import { isExecutablePath, surfaceChanges } from '../integrations/plugins/surface.js'
import {
	type PluginRecordsDeps,
	applicable,
	failure,
	oneLine,
	resolveId,
	stateFailure,
} from './plugin-records.js'

export const PLUGIN_INSTALL_VERBS = ['install', 'uninstall', 'update', 'prune'] as const
export type PluginInstallVerb = (typeof PLUGIN_INSTALL_VERBS)[number]
export const MARKETPLACE_VERBS = ['add', 'list', 'remove'] as const
export type MarketplaceVerb = (typeof MARKETPLACE_VERBS)[number]

export const PLUGIN_INSTALL_HELP = [
	'Install from a folder or file on this computer:',
	'  namzu plugin marketplace add <folder|file.json> [--scope user|project|local] [--dry-run] [--json]',
	'  namzu plugin marketplace list [--json]',
	'  namzu plugin marketplace remove <name> [--yes] [--json]',
	'  namzu plugin install <name>@<marketplace> | <folder> | <file.zip|file.plugin>',
	'                       [--scope user|project|local] [--dry-run] [--enable-loading]',
	'                       [--yes | --accept-surface <sha256>] [--json]',
	'  namzu plugin update <id> [--yes | --accept-surface <sha256>] [--json]',
	'  namzu plugin uninstall <id> [--scope user|project|local] [--delete-data] [--yes] [--json]',
	'  namzu plugin prune [--dry-run] [--yes]',
	'',
	'install   Copies the plugin aside, shows everything in it that runs, and installs it only after',
	'          you say yes. --yes accepts what is shown; --accept-surface accepts only the surface',
	'          whose digest you pass. With no terminal and neither flag it prints the preview and exits 75.',
	'update    Reads the plugin again from where it came from and shows what changed in what runs.',
	'uninstall Removes the install. The plugin’s data is kept unless --delete-data.',
	'prune     Removes copies no record names, and leftovers of installs that did not finish.',
].join('\n')

export interface PluginInstallDeps extends PluginRecordsDeps {
	/** Standard input and error are a terminal, so a yes can be asked. */
	readonly interactive: boolean
	/** Ask a yes or no question on standard error. */
	readonly ask: (question: string) => Promise<boolean>
	readonly now: () => Date
	/** Write `plugins.enabled: true` to the user config; returns the sentence to print. */
	readonly enableLoading: () => string
	/** Test hook: called at each step of an install or update. */
	readonly faults?: (step: InstallStep) => void
}

interface Flags {
	readonly json: boolean
	readonly scope?: RecordScope
	readonly cwd?: string
	readonly yes: boolean
	readonly acceptSurface?: string
	readonly dryRun: boolean
	readonly enableLoading: boolean
	readonly deleteData: boolean
	readonly positional: readonly string[]
	readonly error?: string
}

const BOOLEAN_FLAGS: Readonly<Record<string, keyof Flags>> = {
	'--json': 'json',
	'--yes': 'yes',
	'--dry-run': 'dryRun',
	'--enable-loading': 'enableLoading',
	'--delete-data': 'deleteData',
}

function parseFlags(args: readonly string[]): Flags {
	const flags: {
		json: boolean
		yes: boolean
		dryRun: boolean
		enableLoading: boolean
		deleteData: boolean
		scope?: RecordScope
		cwd?: string
		acceptSurface?: string
		positional: string[]
		error?: string
	} = {
		json: false,
		yes: false,
		dryRun: false,
		enableLoading: false,
		deleteData: false,
		positional: [],
	}
	const bad = (message: string): Flags => ({ ...flags, error: message })
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		const [name, inline] =
			arg.startsWith('--') && arg.includes('=') ? splitOnce(arg) : [arg, undefined]
		const flag = BOOLEAN_FLAGS[name]
		if (flag !== undefined) {
			if (inline !== undefined) return bad(`${name} takes no value.`)
			;(flags as Record<string, unknown>)[flag] = true
		} else if (name === '--scope') {
			const v = inline ?? args[++i]
			if (v !== 'user' && v !== 'project' && v !== 'local')
				return bad('--scope is user, project or local.')
			flags.scope = v
		} else if (name === '--cwd') {
			const v = inline ?? args[++i]
			if (v === undefined || v === '') return bad('--cwd needs a folder.')
			flags.cwd = v
		} else if (name === '--accept-surface') {
			const v = inline ?? args[++i]
			if (v === undefined || v === '')
				return bad('--accept-surface needs the digest that was shown.')
			flags.acceptSurface = v.replace(/^sha256:/i, '').toLowerCase()
		} else if (arg.startsWith('-') && arg !== '-') return bad(`unknown option: ${arg}`)
		else flags.positional.push(arg)
	}
	if (flags.yes && flags.acceptSurface !== undefined)
		return bad('--yes and --accept-surface conflict: use one.')
	return flags
}

function splitOnce(arg: string): [string, string] {
	const at = arg.indexOf('=')
	return [arg.slice(0, at), arg.slice(at + 1)]
}

interface Context {
	readonly cwd: string
	readonly trusted: boolean
}

function contextOf(deps: PluginInstallDeps, flags: Flags): Context {
	const cwd = resolve(deps.cwd(), flags.cwd ?? '.')
	return { cwd: realPathOrResolved(cwd), trusted: deps.isTrusted(cwd) }
}

const UNTRUSTED = 'This folder is not trusted yet. Open it with namzu once, or use --scope user.'

function scopeLine(scope: RecordScope): string {
	return scope === 'user'
		? 'scope: user (every folder on this computer)'
		: scope === 'project'
			? 'scope: project (this folder, shared in .namzu/settings.json)'
			: 'scope: local (this folder, only on this computer)'
}

function sayJson(deps: PluginInstallDeps, value: unknown): void {
	deps.out(`${JSON.stringify(value)}\n`)
}

/** Prompts and previews: standard error in JSON mode so standard output stays one object. */
function show(deps: PluginInstallDeps, json: boolean, text: string): void {
	if (json) deps.err(`${text}\n`)
	else deps.out(`${text}\n`)
}

function declined(
	deps: PluginInstallDeps,
	json: boolean,
	command: string,
	code: number,
	message: string,
	extra: Record<string, unknown> = {},
): number {
	if (json) sayJson(deps, { command, outcome: 'declined', message, ...extra })
	else deps.err(`${message}\n`)
	return code
}

/** The exit status and sentence for a refusal thrown while planning or committing. */
function describeError(error: unknown): { code: number; message: string } {
	// A stand-in for the process dying is not a failure to report.
	if (error instanceof SimulatedCrash) throw error
	if (error instanceof PlanRefusal) return { code: error.code, message: error.message }
	if (error instanceof InstallConflict) return { code: error.code, message: error.message }
	return stateFailure(error)
}

type Consent = { readonly ok: true } | { readonly ok: false; readonly code: number }

interface ConsentInput {
	readonly command: string
	readonly preview: string
	readonly question: string
	readonly digest: string
	/** A sentence that needs `--yes` and is not satisfied by a digest alone. */
	readonly needsYes?: string
	readonly extra: Record<string, unknown>
	readonly declinedMessage: string
}

async function consentFor(
	deps: PluginInstallDeps,
	flags: Flags,
	input: ConsentInput,
): Promise<Consent> {
	if (flags.yes) {
		// --yes accepts what is shown; it still shows it, on stderr, so a log keeps what was accepted.
		if (!flags.json) deps.err(`${input.preview}\n`)
		return { ok: true }
	}
	if (flags.acceptSurface !== undefined) {
		if (flags.acceptSurface !== input.digest)
			return {
				ok: false,
				code: declined(
					deps,
					flags.json,
					input.command,
					EXIT_NEEDS_CONSENT,
					'What this plugin does changed since you read it. Read it again with --dry-run.',
					input.extra,
				),
			}
		if (input.needsYes !== undefined)
			return {
				ok: false,
				code: declined(
					deps,
					flags.json,
					input.command,
					EXIT_NEEDS_CONSENT,
					`${input.needsYes} Add --yes to confirm.`,
					input.extra,
				),
			}
		return { ok: true }
	}
	show(deps, flags.json, input.preview)
	if (!deps.interactive)
		return {
			ok: false,
			code: declined(
				deps,
				flags.json,
				input.command,
				EXIT_NEEDS_CONSENT,
				'Nothing was changed: this runs code, and there is no terminal to ask on. Run it again with --yes, or with --accept-surface <sha256> using the digest above.',
				input.extra,
			),
		}
	if (input.needsYes !== undefined) show(deps, flags.json, input.needsYes)
	if (await deps.ask(input.question)) return { ok: true }
	return {
		ok: false,
		code: declined(deps, flags.json, input.command, EXIT_FAIL, input.declinedMessage, input.extra),
	}
}

function looksLikePath(arg: string): boolean {
	return (
		/[\\/]/.test(arg) || arg.startsWith('.') || arg.startsWith('~') || /\.(zip|plugin)$/i.test(arg)
	)
}

function expandHome(path: string): string {
	if (path === '~' || /^~[\\/]/.test(path))
		return join(process.env.HOME ?? process.env.USERPROFILE ?? '', path.slice(1))
	return path
}

interface Found {
	readonly marketplace: string
	readonly catalog: Catalog
}

function readKnown(deps: PluginInstallDeps) {
	const known = readKnownMarketplaces(deps.namzuHome)
	return known
}

function catalogOf(known: KnownMarketplace): ReturnType<typeof readCatalog> {
	const kind = known.source.source === 'file' ? 'file' : 'directory'
	return readCatalog(known.installLocation, kind)
}

async function sourceFor(
	deps: PluginInstallDeps,
	flags: Flags,
	command: string,
	arg: string,
): Promise<InstallSource | number> {
	if (looksLikePath(arg)) return { kind: 'path', path: resolve(deps.cwd(), expandHome(arg)) }
	const known = readKnown(deps)
	if (known.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The marketplace list could not be read, so nothing was changed (${known.reason}).`,
		)
	let wanted: string
	let from: string | undefined
	if (isPluginId(arg)) {
		const parts = splitPluginId(arg)
		wanted = parts.name
		from = parts.marketplace
	} else if (arg.includes('@'))
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			`"${arg}" is not a plugin id (name@marketplace).`,
		)
	else wanted = arg
	if (from === LOCAL_UPLOADS_MARKETPLACE)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			`${LOCAL_UPLOADS_MARKETPLACE} holds plugins installed from a file or folder. Give the folder or file to install it again.`,
		)
	const found: Found[] = []
	if (from !== undefined) {
		const market = known.marketplaces.get(from)
		if (market === undefined)
			return failure(
				deps,
				flags.json,
				command,
				EXIT_NOINPUT,
				`Marketplace "${from}" is not added. Add it first: namzu plugin marketplace add <folder|file.json>`,
			)
		const read = catalogOf(market)
		if (!read.ok)
			return failure(
				deps,
				flags.json,
				command,
				read.missing ? EXIT_NOINPUT : EXIT_FAIL,
				read.reason,
			)
		found.push({ marketplace: from, catalog: read.catalog })
	} else {
		for (const [name, market] of known.marketplaces) {
			const read = catalogOf(market)
			if (read.ok && read.catalog.entries.some((entry) => entry.name === wanted))
				found.push({ marketplace: name, catalog: read.catalog })
		}
		found.sort((a, b) => a.marketplace.localeCompare(b.marketplace))
		if (found.length > 1)
			return failure(
				deps,
				flags.json,
				command,
				EXIT_USAGE,
				`More than one marketplace has ${wanted}: ${found.map((f) => `${wanted}@${f.marketplace}`).join(', ')}. Name one of them.`,
			)
	}
	const hit = found[0]
	const entry = hit?.catalog.entries.find((candidate) => candidate.name === wanted)
	if (hit === undefined || entry === undefined) {
		const hint = existsSync(resolve(deps.cwd(), arg))
			? ` If you meant the folder, write ./${arg}.`
			: ''
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			from !== undefined
				? `Plugin "${wanted}" is not in marketplace "${from}". See what is added: namzu plugin marketplace list.${hint}`
				: `No added marketplace has a plugin named "${wanted}". See what is added: namzu plugin marketplace list.${hint}`,
		)
	}
	const resolved = await resolveEntrySource(entry, hit.catalog)
	if (resolved.kind === 'unsupported')
		return failure(deps, flags.json, command, EXIT_UNAVAILABLE, resolved.reason, {
			id: `${wanted}@${hit.marketplace}`,
		})
	if (resolved.kind === 'invalid')
		return failure(deps, flags.json, command, EXIT_DATAERR, `${entry.name}: ${resolved.reason}`)
	return { kind: 'catalog', marketplace: hit.marketplace, entry, dir: resolved.dir }
}

function dataOriginWarning(deps: PluginInstallDeps, plan: InstallPlan): string | undefined {
	try {
		const stamp = JSON.parse(
			readFileSync(
				join(installedPluginDataFolder(deps.namzuHome, plan.id), '.origin.json'),
				'utf8',
			),
		) as { source?: unknown }
		if (stamp.source === null || stamp.source === undefined) return undefined
		if (JSON.stringify(stamp.source) === JSON.stringify(plan.installedFrom)) return undefined
		return 'Data kept from an earlier install of this plugin came from another source.'
	} catch {
		return undefined
	}
}

async function offerLoading(
	deps: PluginInstallDeps,
	flags: Flags,
): Promise<{ loading: 'on' | 'off'; notes: string[] }> {
	const notes: string[] = []
	if (deps.loadingOn) return { loading: 'on', notes }
	const turnOn = async (): Promise<boolean> => {
		try {
			notes.push(deps.enableLoading())
			return true
		} catch (error) {
			notes.push(
				`Plugin loading could not be turned on (${error instanceof Error ? error.message : String(error)}). Run: namzu config set plugins.enabled true`,
			)
			return false
		}
	}
	if (flags.enableLoading) return { loading: (await turnOn()) ? 'on' : 'off', notes }
	if (deps.interactive && !flags.yes && flags.acceptSurface === undefined) {
		if (await deps.ask('Plugin loading is off on this computer. Turn it on?'))
			return { loading: (await turnOn()) ? 'on' : 'off', notes }
	}
	notes.push(
		'Plugin loading is off, so it will not run until you run: namzu config set plugins.enabled true',
	)
	return { loading: 'off', notes }
}

async function runInstall(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin install'
	if (flags.positional.length !== 1)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'plugin install takes one plugin: <name>@<marketplace>, a folder, or a .zip or .plugin file.',
		)
	if (flags.deleteData)
		return failure(deps, flags.json, command, EXIT_USAGE, 'unknown option: --delete-data')
	const ctx = contextOf(deps, flags)
	const scope: RecordScope = flags.scope ?? 'user'
	if (scope !== 'user' && !ctx.trusted)
		return failure(deps, flags.json, command, EXIT_UNTRUSTED, UNTRUSTED)
	const source = await sourceFor(deps, flags, command, flags.positional[0] as string)
	if (typeof source === 'number') return source
	let plan: InstallPlan
	try {
		plan = await planInstall(source, { home: deps.namzuHome, cwd: ctx.cwd })
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message)
	}
	try {
		const surfaceJson = {
			id: plan.id,
			scope,
			version: plan.version,
			commit: null,
			layout: plan.layout,
			findings: plan.findings,
			surface: plan.surface,
			surfaceSha256: plan.digest,
			inventory: plan.inventory,
		}
		const read = readInstalledPlugins(deps.namzuHome)
		const have =
			read.state === 'unreadable'
				? undefined
				: (read.plugins.get(plan.id) ?? []).find(
						(record) =>
							record.scope === scope &&
							(scope === 'user' ||
								(record.projectPath !== undefined && samePath(record.projectPath, ctx.cwd))),
					)
		const manifest = readInstallManifest(deps.namzuHome, plan.id)
		const own = readRecordLayer(recordLayerPath(scope, { home: deps.namzuHome, cwd: ctx.cwd }))
		const answered = own.state !== 'unreadable' && own.enabledPlugins.has(plan.id)
		if (
			have !== undefined &&
			have.version === plan.version &&
			answered &&
			manifest.state === 'ok' &&
			manifest.manifest.surfaceSha256 === plan.digest
		) {
			const message = `${plan.id} ${plan.version} is already installed (scope: ${scope}); nothing changed.`
			if (flags.json)
				sayJson(deps, {
					command,
					outcome: 'already-installed',
					message,
					...surfaceJson,
					loading: deps.loadingOn ? 'on' : 'off',
				})
			else deps.out(`${message}\n`)
			return EXIT_OK
		}
		const preview = renderInstallPreview(plan, { scopeLine: scopeLine(scope) })
		if (flags.dryRun) {
			if (flags.json)
				sayJson(deps, {
					command,
					outcome: 'dry-run',
					message: 'Nothing was installed.',
					...surfaceJson,
					loading: deps.loadingOn ? 'on' : 'off',
				})
			else deps.out(`${preview}\n\nDry run: nothing was installed.\n`)
			return EXIT_OK
		}
		const warning = dataOriginWarning(deps, plan)
		const consent = await consentFor(deps, flags, {
			command,
			preview,
			question: 'Install?',
			digest: plan.digest,
			extra: surfaceJson,
			declinedMessage: 'Not installed.',
			...(warning !== undefined ? { needsYes: warning } : {}),
		})
		if (!consent.ok) return consent.code
		let outcome: ReturnType<typeof commitInstall>
		try {
			outcome = commitInstall(plan, {
				home: deps.namzuHome,
				now: deps.now(),
				scope,
				cwd: ctx.cwd,
				consent: { by: 'cli', nonInteractive: !deps.interactive },
				...(deps.faults ? { faults: deps.faults } : {}),
			})
		} catch (error) {
			const failed = describeError(error)
			return failure(deps, flags.json, command, failed.code, failed.message, { id: plan.id })
		}
		const { loading, notes } = await offerLoading(deps, flags)
		const message =
			outcome.outcome === 'already-installed'
				? `${plan.id} ${plan.version} is already installed (scope: ${scope}); nothing changed.`
				: `Installed ${plan.id} ${plan.version} (scope: ${scope}). It loads in new conversations.`
		if (flags.json)
			sayJson(deps, {
				command,
				outcome: outcome.outcome,
				message,
				...surfaceJson,
				loading,
				...(notes.length > 0 ? { notes } : {}),
			})
		else deps.out(`${[message, ...notes].join('\n')}\n`)
		return EXIT_OK
	} finally {
		discardStaging(plan.stagingDir)
	}
}

async function runUpdate(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin update'
	if (flags.positional.length !== 1)
		return failure(deps, flags.json, command, EXIT_USAGE, 'plugin update takes one plugin id.')
	const ctx = contextOf(deps, flags)
	const resolved = resolveId(deps, flags.json, command, flags.positional[0] as string)
	if (typeof resolved === 'number') return resolved
	const { id, records } = resolved
	if (flags.scope !== undefined && !records.some((record) => record.scope === flags.scope))
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`${id} is not installed at scope ${flags.scope}.`,
			{ id },
		)
	const recorded = readInstallManifest(deps.namzuHome, id)
	if (recorded.state !== 'ok')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`${id} has no readable install manifest, so there is nothing to compare an update with. Reinstall it.`,
			{ id },
		)
	const from = recorded.manifest.installedFrom ?? {}
	const { name, marketplace } = splitPluginId(id)
	let source: InstallSource
	if (marketplace === LOCAL_UPLOADS_MARKETPLACE) {
		const path = typeof from.source === 'string' ? from.source : undefined
		if (path === undefined || !existsSync(path))
			return failure(
				deps,
				flags.json,
				command,
				EXIT_NOINPUT,
				`${id} was installed from ${path ?? 'a file or folder'}, which is not there now. Install it again from where it is.`,
				{ id },
			)
		source = { kind: 'path', path }
	} else {
		const found = await sourceFor(deps, flags, command, id)
		if (typeof found === 'number') return found
		source = found
	}
	let plan: InstallPlan
	try {
		plan = await planInstall(source, { home: deps.namzuHome, cwd: ctx.cwd })
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message, { id })
	}
	try {
		const current = records[0] as InstallRecord
		const surfaceJson = {
			id,
			from: current.version ?? null,
			to: plan.version,
			findings: plan.findings,
			surface: plan.surface,
			surfaceSha256: plan.digest,
		}
		if (plan.name !== name)
			return failure(
				deps,
				flags.json,
				command,
				EXIT_DATAERR,
				`The source now holds "${plan.name}", not ${name}.`,
				{ id },
			)
		if (current.version === plan.version && recorded.manifest.surfaceSha256 === plan.digest) {
			const message = `${id} is up to date (${plan.version}).`
			if (flags.json) sayJson(deps, { command, outcome: 'up-to-date', message, ...surfaceJson })
			else deps.out(`${message}\n`)
			return EXIT_OK
		}
		const before = recorded.manifest.surface as unknown as Parameters<typeof surfaceChanges>[0]
		const changes = surfaceChanges(before, plan.surface)
		// Nothing that runs changed: the same surface rows, and the only files that differ
		// are manifests (a version bump) or files that cannot run and configure nothing.
		const nothingRunsDifferently =
			JSON.stringify(before) === JSON.stringify(plan.surface) &&
			[...new Set([...Object.keys(plan.files), ...Object.keys(recorded.manifest.files)])]
				.filter((path) => plan.files[path] !== recorded.manifest.files[path])
				.every((path) => {
					const base = path.split('/').pop() ?? path
					if (base === 'plugin.json') return true
					return (
						!isExecutablePath(path, 0) &&
						!plan.surface.scripts.some((script) => script.path === path)
					)
				})
		const unchangedSurface =
			recorded.manifest.surfaceSha256 === plan.digest || nothingRunsDifferently
		if (!unchangedSurface) {
			const preview = renderInstallPreview(plan, {
				scopeLine: '',
				headline: `Update ${oneLine(id)} from ${oneLine(current.version ?? '?')} to ${oneLine(plan.version)}?`,
				changes: [
					...(current.version !== plan.version
						? [`Version ${oneLine(current.version ?? '?')} to ${oneLine(plan.version)}`]
						: []),
					...(changes.length > 0 ? changes : ['Files that configure or run the plugin changed.']),
				],
			})
			if (flags.dryRun) {
				if (flags.json)
					sayJson(deps, {
						command,
						outcome: 'dry-run',
						message: 'Nothing was updated.',
						changes,
						...surfaceJson,
					})
				else deps.out(`${preview}\n\nDry run: nothing was updated.\n`)
				return EXIT_OK
			}
			const consent = await consentFor(deps, flags, {
				command,
				preview,
				question: 'Update?',
				digest: plan.digest,
				extra: { ...surfaceJson, changes },
				declinedMessage: 'Not updated.',
			})
			if (!consent.ok) return consent.code
		} else if (flags.dryRun) {
			if (flags.json)
				sayJson(deps, {
					command,
					outcome: 'dry-run',
					message: 'Nothing was updated.',
					changes,
					...surfaceJson,
				})
			else
				deps.out(
					`${id} would change from ${current.version ?? '?'} to ${plan.version}. What runs does not change.\n`,
				)
			return EXIT_OK
		}
		let result: ReturnType<typeof commitUpdate>
		try {
			result = commitUpdate(plan, {
				home: deps.namzuHome,
				now: deps.now(),
				consent: { by: 'cli', nonInteractive: !deps.interactive },
				...(deps.faults ? { faults: deps.faults } : {}),
			})
		} catch (error) {
			const failed = describeError(error)
			return failure(deps, flags.json, command, failed.code, failed.message, { id })
		}
		const message =
			result.outcome === 'up-to-date'
				? `${id} is up to date (${plan.version}).`
				: `Updated ${id} from ${result.from ?? '?'} to ${result.to}. It loads in new conversations.`
		if (flags.json)
			sayJson(deps, { command, outcome: result.outcome, message, changes, ...surfaceJson })
		else
			deps.out(
				`${[...(unchangedSurface && changes.length === 0 ? [] : changes.map((change) => `  ${change}`)), message].join('\n')}\n`,
			)
		return EXIT_OK
	} finally {
		discardStaging(plan.stagingDir)
	}
}

async function runUninstall(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin uninstall'
	if (flags.positional.length !== 1)
		return failure(deps, flags.json, command, EXIT_USAGE, 'plugin uninstall takes one plugin id.')
	const ctx = contextOf(deps, flags)
	const arg = flags.positional[0] as string
	const read = readInstalledPlugins(deps.namzuHome)
	if (read.state !== 'unreadable' && !isPluginId(arg) && !arg.includes('@')) {
		const holder = (await usedPluginNames({ home: deps.namzuHome, cwd: ctx.cwd })).get(arg)
		const installed = [...read.plugins.keys()].some((id) => splitPluginId(id).name === arg)
		if (!installed && holder?.startsWith('the plugin folder'))
			return failure(
				deps,
				flags.json,
				command,
				EXIT_USAGE,
				'This plugin is a folder you placed in .namzu/plugins. Remove the folder yourself.',
			)
	}
	const resolved = resolveId(deps, flags.json, command, arg)
	if (typeof resolved === 'number') return resolved
	const { id } = resolved
	const found = applicable(resolved.records, ctx.cwd, ctx.trusted)
	let chosen: InstallRecord | undefined
	if (flags.scope !== undefined) chosen = found.here.find((record) => record.scope === flags.scope)
	else if (found.here.length === 1) chosen = found.here[0]
	else if (found.here.length > 1)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			`${id} is installed at more than one scope here (${found.here.map((r) => r.scope).join(', ')}). Say which with --scope.`,
			{ id },
		)
	if (chosen === undefined) {
		if (found.unread > 0 && flags.scope === undefined)
			return failure(deps, flags.json, command, EXIT_UNTRUSTED, UNTRUSTED, { id })
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			flags.scope
				? `${id} is not installed at scope ${flags.scope} here.`
				: `${id} is not installed for this folder or for you.`,
			{ id },
		)
	}
	if (chosen.scope !== 'user' && !ctx.trusted)
		return failure(deps, flags.json, command, EXIT_UNTRUSTED, UNTRUSTED, { id })
	const dataPath = installedPluginDataFolder(deps.namzuHome, id)
	if (chosen.scope === 'project' && !flags.yes) {
		const sharedFile = '.namzu/settings.json'
		if (!deps.interactive)
			return declined(
				deps,
				flags.json,
				command,
				EXIT_NEEDS_CONSENT,
				`Removing ${id} edits the shared ${sharedFile}, which your teammates use. Add --yes to do that, or run: namzu plugin disable ${id} to turn it off only for you.`,
				{ id, scope: chosen.scope },
			)
		if (!(await deps.ask(`Remove ${id} for everyone (edits the shared ${sharedFile})?`))) {
			if (await deps.ask('Turn it off for you only instead?')) {
				const path = recordLayerPath('local', { home: deps.namzuHome, cwd: ctx.cwd })
				try {
					setEnabledPlugin(path, deps.namzuHome, id, false)
				} catch (error) {
					const failed = stateFailure(error)
					return failure(deps, flags.json, command, failed.code, failed.message, { id })
				}
				const message = `Turned off ${id} for you only. It takes effect in new conversations.`
				if (flags.json)
					sayJson(deps, { command, outcome: 'disabled', id, scope: chosen.scope, message })
				else deps.out(`${message}\n`)
				return EXIT_OK
			}
			return declined(deps, flags.json, command, EXIT_FAIL, 'Nothing was removed.', { id })
		}
	}
	let result: ReturnType<typeof removeInstall>
	try {
		result = removeInstall(
			id,
			{
				scope: chosen.scope,
				...(chosen.projectPath !== undefined ? { projectPath: chosen.projectPath } : {}),
			},
			{ home: deps.namzuHome, now: deps.now(), deleteData: flags.deleteData },
		)
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message, { id })
	}
	if (!result.removedRecord)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`${id} is not installed at scope ${chosen.scope}.`,
			{ id },
		)
	const parts = [`Removed ${id} (scope: ${chosen.scope}).`]
	if (result.dataKept) parts.push(`Its data is kept in ${dataPath}; delete it with --delete-data.`)
	if (result.dataDeleted) parts.push('Its data was deleted.')
	if (result.remaining > 0)
		parts.push(
			`It is still installed at ${result.remaining} other ${result.remaining === 1 ? 'scope' : 'scopes'}.`,
		)
	const message = parts.join(' ')
	if (flags.json)
		sayJson(deps, {
			command,
			outcome: 'uninstalled',
			id,
			scope: chosen.scope,
			message,
			dataKept: result.dataKept,
			dataDeleted: result.dataDeleted,
			remaining: result.remaining,
		})
	else deps.out(`${message}\n`)
	return EXIT_OK
}

async function runPrune(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin prune'
	if (flags.positional.length > 0)
		return failure(deps, flags.json, command, EXIT_USAGE, 'plugin prune takes no arguments.')
	let plan: ReturnType<typeof prune>
	try {
		plan = prune(deps.namzuHome, deps.now(), false)
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message)
	}
	const listing = [
		...plan.items.map((item) => `  ${oneLine(item.path)}  (${item.reason})`),
		...plan.kept.map((item) => `  ${oneLine(item.path)}  (kept: ${item.reason})`),
	]
	if (plan.items.length === 0) {
		const message = 'Nothing to remove.'
		if (flags.json)
			sayJson(deps, { command, outcome: 'nothing-to-do', message, items: [], kept: plan.kept })
		else deps.out(`${[message, ...listing].join('\n')}\n`)
		return EXIT_OK
	}
	if (flags.dryRun) {
		if (flags.json)
			sayJson(deps, { command, outcome: 'dry-run', items: plan.items, kept: plan.kept })
		else deps.out(`Would remove:\n${listing.join('\n')}\n`)
		return EXIT_OK
	}
	if (!flags.yes) {
		show(deps, flags.json, `Would remove:\n${listing.join('\n')}`)
		if (!deps.interactive)
			return declined(
				deps,
				flags.json,
				command,
				EXIT_NEEDS_CONSENT,
				'Nothing was removed. Add --yes to remove these.',
				{ items: plan.items },
			)
		if (!(await deps.ask('Remove them?')))
			return declined(deps, flags.json, command, EXIT_FAIL, 'Nothing was removed.')
	}
	let done: ReturnType<typeof prune>
	try {
		done = prune(deps.namzuHome, deps.now(), true)
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message)
	}
	const message = `Removed ${done.items.length} ${done.items.length === 1 ? 'item' : 'items'}.`
	if (flags.json)
		sayJson(deps, { command, outcome: 'pruned', message, items: done.items, kept: done.kept })
	else deps.out(`${message}\n`)
	return EXIT_OK
}

export async function runPluginInstall(
	verb: PluginInstallVerb,
	args: readonly string[],
	deps: PluginInstallDeps,
): Promise<number> {
	const flags = parseFlags(args)
	if (flags.error) return failure(deps, flags.json, `plugin ${verb}`, EXIT_USAGE, flags.error)
	if (flags.deleteData && verb !== 'uninstall')
		return failure(deps, flags.json, `plugin ${verb}`, EXIT_USAGE, 'unknown option: --delete-data')
	if (flags.enableLoading && verb !== 'install')
		return failure(
			deps,
			flags.json,
			`plugin ${verb}`,
			EXIT_USAGE,
			'unknown option: --enable-loading',
		)
	switch (verb) {
		case 'install':
			return runInstall(deps, flags)
		case 'update':
			return runUpdate(deps, flags)
		case 'uninstall':
			return runUninstall(deps, flags)
		case 'prune':
			return runPrune(deps, flags)
	}
}

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

const MARKETPLACE_NOTICE = [
	'Plugins from a marketplace can run programs on this computer, with access to',
	'your files. Namzu does not control this marketplace or its plugins, and its',
	'owner can change them later. Add only marketplaces you trust.',
].join('\n')

async function runMarketplaceAdd(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin marketplace add'
	if (flags.positional.length !== 1)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'plugin marketplace add takes one folder or .json file.',
		)
	if (flags.enableLoading || flags.deleteData || flags.acceptSurface !== undefined)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'that option does not belong to marketplace add.',
		)
	const ctx = contextOf(deps, flags)
	const scope: RecordScope = flags.scope ?? 'user'
	const address = parseMarketplaceAddress(flags.positional[0] as string, deps.cwd())
	if (address.kind === 'refused')
		return failure(deps, flags.json, command, EXIT_USAGE, address.message)
	if (address.kind === 'remote')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_UNAVAILABLE,
			`${oneLine(address.text)} needs a download, which this version of Namzu does not do yet. Add a folder or a .json file instead.`,
		)
	if (scope !== 'user' && !ctx.trusted)
		return failure(deps, flags.json, command, EXIT_UNTRUSTED, UNTRUSTED)
	const real = realPathOf(address.path)
	if (real === undefined)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`${oneLine(address.path)} was not found.`,
		)
	if (/^\\\\/.test(real))
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'A network share is not accepted. Copy the marketplace to this computer first.',
		)
	let kind: 'directory' | 'file'
	try {
		const stat = lstatSync(real)
		if (stat.isDirectory()) kind = 'directory'
		else if (stat.isFile() && real.toLowerCase().endsWith('.json')) kind = 'file'
		else
			return failure(
				deps,
				flags.json,
				command,
				EXIT_USAGE,
				'Not a marketplace address. A marketplace is a folder or a .json file.',
			)
	} catch {
		return failure(deps, flags.json, command, EXIT_NOINPUT, `${oneLine(real)} was not found.`)
	}
	const source = { source: kind, path: real }
	if (flags.dryRun) {
		if (flags.json)
			sayJson(deps, { command, outcome: 'dry-run', source, notice: MARKETPLACE_NOTICE })
		else deps.out(`Would add the marketplace at ${oneLine(real)}.\n\n${MARKETPLACE_NOTICE}\n`)
		return EXIT_OK
	}
	const read = readCatalog(real, kind)
	if (!read.ok)
		return failure(
			deps,
			flags.json,
			command,
			read.missing ? EXIT_NOINPUT : EXIT_DATAERR,
			read.reason,
		)
	const { catalog } = read
	const problem = marketplaceNameProblem(catalog.name)
	if (problem !== undefined) return failure(deps, flags.json, command, EXIT_DATAERR, problem)
	const known = readKnownMarketplaces(deps.namzuHome)
	if (known.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The marketplace list could not be read, so nothing was changed (${known.reason}).`,
		)
	const existing = known.marketplaces.get(catalog.name)
	if (existing !== undefined) {
		if (existing.source.source === kind && samePath(String(existing.source.path ?? ''), real)) {
			// Added at another scope: this scope still needs its own declaration.
			const layerPath = recordLayerPath(scope, { home: deps.namzuHome, cwd: ctx.cwd })
			const layer = readRecordLayer(layerPath)
			if (layer.state !== 'unreadable' && !layer.marketplaces.has(catalog.name)) {
				try {
					setExtraKnownMarketplace(layerPath, deps.namzuHome, catalog.name, source)
				} catch (error) {
					const failed = stateFailure(error)
					return failure(deps, flags.json, command, failed.code, failed.message)
				}
				const added = `Marketplace "${catalog.name}" was already added; it is now also declared for scope ${scope}.`
				if (flags.json)
					sayJson(deps, {
						command,
						outcome: 'added',
						name: catalog.name,
						source,
						scope,
						message: added,
					})
				else deps.out(`${added}\n`)
				return EXIT_OK
			}
			const message = `Marketplace "${catalog.name}" is already added; nothing changed.`
			if (flags.json)
				sayJson(deps, { command, outcome: 'already-added', name: catalog.name, source, message })
			else deps.out(`${message}\n`)
			return EXIT_OK
		}
		return failure(
			deps,
			flags.json,
			command,
			EXIT_DATAERR,
			`A marketplace named "${catalog.name}" is already added from another place (${oneLine(String(existing.source.path ?? existing.source.source))}). Remove it first: namzu plugin marketplace remove ${catalog.name}`,
		)
	}
	show(deps, flags.json, MARKETPLACE_NOTICE)
	const now = deps.now().toISOString()
	try {
		putKnownMarketplace(deps.namzuHome, catalog.name, {
			source,
			installLocation: real,
			lastUpdated: now,
			autoUpdate: false,
			consent: { at: now, by: 'cli', notice: 'marketplace-v1' },
		})
		setExtraKnownMarketplace(
			recordLayerPath(scope, { home: deps.namzuHome, cwd: ctx.cwd }),
			deps.namzuHome,
			catalog.name,
			source,
		)
	} catch (error) {
		const failed = stateFailure(error)
		return failure(deps, flags.json, command, failed.code, failed.message)
	}
	const unsupported = (
		await Promise.all(
			catalog.entries.map(async (entry) => (await resolveEntrySource(entry, catalog)).kind),
		)
	).filter((entryKind) => entryKind !== 'local').length
	const message = `Added marketplace "${catalog.name}" (${catalog.entries.length} ${catalog.entries.length === 1 ? 'plugin' : 'plugins'}${unsupported > 0 ? `, ${unsupported} cannot be installed here` : ''}).`
	if (flags.json)
		sayJson(deps, {
			command,
			outcome: 'added',
			name: catalog.name,
			source,
			scope,
			plugins: catalog.entries.length,
			notInstallable: unsupported,
			warnings: catalog.warnings,
			message,
		})
	else deps.out(`${[message, ...catalog.warnings.map((w) => `Note: ${oneLine(w)}`)].join('\n')}\n`)
	return EXIT_OK
}

async function runMarketplaceList(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin marketplace list'
	if (flags.positional.length > 0)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'plugin marketplace list takes no arguments.',
		)
	const ctx = contextOf(deps, flags)
	const known = readKnownMarketplaces(deps.namzuHome)
	if (known.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The marketplace list could not be read (${known.reason}). Nothing was changed.`,
		)
	const installed = readInstalledPlugins(deps.namzuHome)
	const counts = new Map<string, number>()
	if (installed.state !== 'unreadable')
		for (const id of installed.plugins.keys()) {
			const { marketplace } = splitPluginId(id)
			counts.set(marketplace, (counts.get(marketplace) ?? 0) + 1)
		}
	const rows = [...known.marketplaces.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((market) => {
			const read = catalogOf(market)
			return {
				name: market.name,
				source: market.source,
				installLocation: market.installLocation,
				lastUpdated: market.lastUpdated ?? null,
				autoUpdate: market.autoUpdate ?? false,
				plugins: read.ok ? read.catalog.entries.length : null,
				installed: counts.get(market.name) ?? 0,
				commit: market.commit ?? null,
				...(read.ok ? {} : { problem: read.reason }),
			}
		})
	const layers = readLayers(deps.namzuHome, ctx.cwd, ctx.trusted)
	const declared: { name: string; declaredBy: RecordLayer; source: unknown }[] = []
	for (const layer of ['project', 'local'] as const) {
		const read = layers[layer]
		if (read === undefined || read.state === 'unreadable') continue
		for (const market of read.marketplaces.values())
			if (!known.marketplaces.has(market.name))
				declared.push({ name: market.name, declaredBy: layer, source: market.source })
	}
	if (flags.json) {
		sayJson(deps, {
			command,
			marketplaces: rows,
			declaredByProject: declared,
			problems: known.invalid.map((p) => `${p.id}: ${p.reason}`),
		})
		return EXIT_OK
	}
	const lines: string[] = []
	if (rows.length === 0) lines.push('No marketplaces are added.')
	for (const row of rows)
		lines.push(
			`${oneLine(row.name)}  ${oneLine(String(row.source.path ?? row.source.source))}  ${row.plugins ?? '?'} plugins, ${row.installed} installed  auto-update ${row.autoUpdate ? 'on' : 'off'}${'problem' in row ? `\n  ${oneLine(String(row.problem))}` : ''}`,
		)
	if (declared.length > 0) {
		lines.push('', 'Declared by this project, not added:')
		for (const item of declared) lines.push(`  ${oneLine(item.name)}`)
	}
	deps.out(`${lines.join('\n')}\n`)
	return EXIT_OK
}

async function runMarketplaceRemove(deps: PluginInstallDeps, flags: Flags): Promise<number> {
	const command = 'plugin marketplace remove'
	if (flags.positional.length !== 1)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			'plugin marketplace remove takes one marketplace name.',
		)
	const name = flags.positional[0] as string
	if (name === LOCAL_UPLOADS_MARKETPLACE)
		return failure(
			deps,
			flags.json,
			command,
			EXIT_USAGE,
			`${LOCAL_UPLOADS_MARKETPLACE} is not a marketplace; remove its plugins one by one with: namzu plugin uninstall <id>`,
		)
	const ctx = contextOf(deps, flags)
	const known = readKnownMarketplaces(deps.namzuHome)
	if (known.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The marketplace list could not be read, so nothing was changed (${known.reason}).`,
		)
	if (!known.marketplaces.has(name))
		return failure(deps, flags.json, command, EXIT_NOINPUT, `Marketplace "${name}" is not added.`)
	const installed = readInstalledPlugins(deps.namzuHome)
	if (installed.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The install record could not be read, so nothing was changed: ${installedPluginsPath(deps.namzuHome)} (${installed.reason}).`,
		)
	const doomed: { id: string; record: InstallRecord }[] = []
	for (const [id, records] of installed.plugins)
		if (splitPluginId(id).marketplace === name)
			for (const record of records) doomed.push({ id, record })
	const layers: RecordLayer[] = ['user']
	if (ctx.trusted) layers.push('project', 'local')
	const goes = layers.filter((layer) => {
		const read = readRecordLayer(recordLayerPath(layer, { home: deps.namzuHome, cwd: ctx.cwd }))
		return read.state !== 'unreadable' && read.marketplaces.has(name)
	})
	const lines = [
		`Remove marketplace "${name}"?`,
		doomed.length > 0
			? `  Its installed plugins are uninstalled (their data is kept): ${doomed
					.map((d) => `${d.id} (${d.record.scope})`)
					.map(oneLine)
					.join(', ')}`
			: '  No plugins from it are installed.',
		...goes.map((layer) => `  Its entry in the ${layer} settings goes.`),
		'  The marketplace’s own folder is never touched.',
	]
	if (!flags.yes) {
		show(deps, flags.json, lines.join('\n'))
		if (!deps.interactive)
			return declined(
				deps,
				flags.json,
				command,
				EXIT_NEEDS_CONSENT,
				'Nothing was removed. Add --yes to remove it.',
				{ name },
			)
		if (!(await deps.ask('Remove it?')))
			return declined(deps, flags.json, command, EXIT_FAIL, 'Nothing was removed.', { name })
	}
	const removed: string[] = []
	try {
		for (const { id, record } of doomed) {
			const result = removeInstall(
				id,
				{
					scope: record.scope,
					...(record.projectPath !== undefined ? { projectPath: record.projectPath } : {}),
				},
				{ home: deps.namzuHome, now: deps.now(), deleteData: false },
			)
			if (result.removedRecord) removed.push(`${id} (${record.scope})`)
		}
		removeKnownMarketplace(deps.namzuHome, name)
		for (const layer of goes)
			removeExtraKnownMarketplace(
				recordLayerPath(layer, { home: deps.namzuHome, cwd: ctx.cwd }),
				deps.namzuHome,
				name,
			)
	} catch (error) {
		const failed = describeError(error)
		return failure(deps, flags.json, command, failed.code, failed.message, { name, removed })
	}
	const message = `Removed marketplace "${name}"${removed.length > 0 ? ` and uninstalled ${removed.length} ${removed.length === 1 ? 'plugin' : 'plugins'}` : ''}.`
	if (flags.json)
		sayJson(deps, { command, outcome: 'removed', name, uninstalled: removed, message })
	else deps.out(`${message}\n`)
	return EXIT_OK
}

export async function runMarketplace(
	args: readonly string[],
	deps: PluginInstallDeps,
): Promise<number> {
	const [sub, ...rest] = args
	if (sub === undefined || !(MARKETPLACE_VERBS as readonly string[]).includes(sub))
		return failure(
			deps,
			false,
			'plugin marketplace',
			EXIT_USAGE,
			sub === undefined
				? 'plugin marketplace needs add, list or remove.'
				: `unknown plugin marketplace command: ${sub}. The ones there are: ${MARKETPLACE_VERBS.join(', ')}.`,
		)
	const flags = parseFlags(rest)
	if (flags.error)
		return failure(deps, flags.json, `plugin marketplace ${sub}`, EXIT_USAGE, flags.error)
	switch (sub as MarketplaceVerb) {
		case 'add':
			return runMarketplaceAdd(deps, flags)
		case 'list':
			return runMarketplaceList(deps, flags)
		case 'remove':
			return runMarketplaceRemove(deps, flags)
	}
}
