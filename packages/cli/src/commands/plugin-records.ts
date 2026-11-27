/**
 * `namzu plugin list | details | enable | disable`: the command line over the
 * install records (`integrations/plugins/records.ts`), the settings records
 * (`enabled-records.ts`) and the tamper check (`install-manifest.ts`).
 *
 * Nothing here runs a plugin or fetches anything: it reads the records and the
 * installed copy's files, and `enable` and `disable` change one `enabledPlugins`
 * entry. `--json` prints one object on standard output and nothing else there.
 *
 * Exit status: 0 done (also "already so"), 1 failed, 64 the command line is
 * wrong, 66 not installed or a record could not be read, 77 the folder is not
 * trusted.
 */

import { lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { EXIT_FAIL, EXIT_NOINPUT, EXIT_OK, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import {
	type EnabledAnswer,
	type RecordLayer,
	readRecordLayer,
	recordLayerPath,
	setEnabledPlugin,
} from '../integrations/plugins/enabled-records.js'
import { listMarkdownNames, resolvePluginFileDirs } from '../integrations/plugins/files.js'
import {
	readInstallManifest,
	verifyInstalledCopy,
} from '../integrations/plugins/install-manifest.js'
import {
	type InstalledCandidate,
	admissionScope,
	currentEnabledAnswer,
	loadInstalledManifest,
	readLayers,
} from '../integrations/plugins/installed-source.js'
import { readPluginManifestDetails } from '../integrations/plugins/manifest-details.js'
import {
	type InstallRecord,
	type RecordScope,
	installedPluginDataFolder,
	installedPluginsPath,
	isPluginId,
	readInstalledPlugins,
	readKnownMarketplaces,
	realPathOrResolved,
	samePath,
	splitPluginId,
} from '../integrations/plugins/records.js'
import { StateFileBusyError, StateFileUnreadableError } from '../integrations/state/state-file.js'
import { terminalDisplayText } from '../tui/terminal-display.js'

export const PLUGIN_RECORD_VERBS = ['list', 'details', 'enable', 'disable'] as const
export type PluginRecordVerb = (typeof PLUGIN_RECORD_VERBS)[number]

export const PLUGIN_RECORD_HELP = [
	'Usage:',
	'  namzu plugin list [--cwd <dir>] [--json]',
	'  namzu plugin details <id> [--cwd <dir>] [--json]',
	'  namzu plugin enable <id> [--scope user|project|local] [--cwd <dir>] [--json]',
	'  namzu plugin disable <id> [--scope user|project|local] [--cwd <dir>] [--json]',
	'',
	'list     The installed plugins that apply here: id, version, scope, on or off, and what needs attention.',
	'details  One plugin: what it brings by its exact names, the record, who turned it on, where its data is.',
	'enable   Record a yes for an installed plugin. It takes effect in new conversations.',
	'disable  Record a no. Nothing is removed; the plugin stays installed.',
	'',
	'An id is <name>@<marketplace>; a bare name works when only one installed plugin has it.',
	'Without --scope a user plugin is changed in your own settings file, and a project plugin in',
	'this computer’s file for the folder (.namzu/settings.local.json), so a shared file is not',
	'edited by a toggle. --scope project edits the shared .namzu/settings.json.',
	'',
	'Options:',
	'  --scope user|project|local  The record to act on, and the settings file it is written to',
	'  --cwd <dir>                 The folder whose project plugins are meant (default: here)',
	'  --json                      Print one JSON object on standard output',
	'',
	'Exit status: 0 done, 1 something failed, 64 the command line is wrong,',
	'66 not installed or a record could not be read, 77 the folder is not trusted.',
].join('\n')

export interface PluginRecordsDeps {
	readonly out: (text: string) => void
	readonly err: (text: string) => void
	readonly cwd: () => string
	/** The Namzu home (`~/.namzu`, or `NAMZU_HOME`). */
	readonly namzuHome: string
	readonly isTrusted: (dir: string) => boolean
	/** `plugins.enabled` of the loaded configuration. */
	readonly loadingOn: boolean
}

interface Flags {
	readonly json: boolean
	readonly scope?: RecordScope
	readonly cwd?: string
	readonly positional: readonly string[]
	readonly error?: string
}

function parseFlags(args: readonly string[]): Flags {
	let json = false
	let scope: RecordScope | undefined
	let cwd: string | undefined
	const positional: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		const value = (name: string): string | undefined => {
			if (arg === name) return args[++i]
			if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
			return undefined
		}
		if (arg === '--json') json = true
		else if (arg === '--scope' || arg.startsWith('--scope=')) {
			const v = value('--scope')
			if (v !== 'user' && v !== 'project' && v !== 'local')
				return { json, positional, error: '--scope is user, project or local.' }
			scope = v
		} else if (arg === '--cwd' || arg.startsWith('--cwd=')) {
			const v = value('--cwd')
			if (v === undefined || v === '') return { json, positional, error: '--cwd needs a folder.' }
			cwd = v
		} else if (arg.startsWith('-') && arg !== '-')
			return { json, positional, error: `unknown option: ${arg}` }
		else positional.push(arg)
	}
	return { json, ...(scope ? { scope } : {}), ...(cwd ? { cwd } : {}), positional }
}

const oneLine = (value: string): string => terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')

function failure(
	deps: PluginRecordsDeps,
	json: boolean,
	command: string,
	code: number,
	message: string,
	extra: Record<string, unknown> = {},
): number {
	if (json) deps.out(`${JSON.stringify({ command, outcome: 'failed', message, ...extra })}\n`)
	else deps.err(`${message}\n`)
	return code
}

/** What a state-file refusal says, with the way the plugin commands name it. */
function stateFailure(error: unknown): { code: number; message: string } {
	if (error instanceof StateFileUnreadableError)
		return {
			code: EXIT_NOINPUT,
			message: `The install record could not be read, so nothing was changed: ${error.file}\n${error.sentence((p) => p)}`,
		}
	if (error instanceof StateFileBusyError)
		return { code: EXIT_FAIL, message: error.sentence((p) => p) }
	return { code: EXIT_FAIL, message: error instanceof Error ? error.message : String(error) }
}

interface Resolved {
	readonly id: string
	readonly records: readonly InstallRecord[]
}

/** An id, or a bare name that exactly one installed plugin has, with its records. */
function resolveId(
	deps: PluginRecordsDeps,
	json: boolean,
	command: string,
	arg: string,
): Resolved | number {
	const read = readInstalledPlugins(deps.namzuHome)
	if (read.state === 'unreadable')
		return failure(
			deps,
			json,
			command,
			EXIT_NOINPUT,
			`The install record could not be read, so nothing was changed: ${installedPluginsPath(deps.namzuHome)} (${read.reason}). Fix or remove the file, then try again.`,
		)
	if (isPluginId(arg)) {
		const records = read.plugins.get(arg)
		if (!records)
			return failure(
				deps,
				json,
				command,
				EXIT_NOINPUT,
				`${arg} is not installed on this computer.`,
				{
					id: arg,
				},
			)
		return { id: arg, records }
	}
	if (arg.includes('@') || arg === '')
		return failure(
			deps,
			json,
			command,
			EXIT_USAGE,
			`"${arg}" is not a plugin id (name@marketplace).`,
		)
	const matches = [...read.plugins.keys()].filter((id) => splitPluginId(id).name === arg)
	if (matches.length === 0)
		return failure(deps, json, command, EXIT_NOINPUT, `${arg} is not installed on this computer.`)
	if (matches.length > 1)
		return failure(
			deps,
			json,
			command,
			EXIT_USAGE,
			`More than one installed plugin is named ${arg}: ${matches.join(', ')}. Name one of them.`,
			{ matches },
		)
	const id = matches[0] as string
	return { id, records: read.plugins.get(id) as InstallRecord[] }
}

/** The records that apply to the folder, most specific first. */
function applicable(
	records: readonly InstallRecord[],
	cwd: string,
	trusted: boolean,
): { readonly here: InstallRecord[]; readonly unread: number } {
	const rank: Record<RecordScope, number> = { local: 3, project: 2, user: 1 }
	const here: InstallRecord[] = []
	let unread = 0
	for (const record of records) {
		if (record.scope === 'user') here.push(record)
		else if (record.projectPath !== undefined && samePath(record.projectPath, cwd)) {
			if (trusted) here.push(record)
			else unread++
		}
	}
	here.sort((a, b) => rank[b.scope] - rank[a.scope])
	return { here, unread }
}

interface Context {
	readonly cwd: string
	readonly trusted: boolean
}

function contextOf(deps: PluginRecordsDeps, flags: Flags): Context {
	const cwd = resolve(deps.cwd(), flags.cwd ?? '.')
	return { cwd: realPathOrResolved(cwd), trusted: deps.isTrusted(cwd) }
}

function layerSentence(by: RecordLayer | undefined, answer: boolean): string {
	if (by === undefined) return 'no setting says so'
	return by === 'user'
		? `your settings say ${answer ? 'yes' : 'no'}`
		: by === 'project'
			? `the folder’s shared settings say ${answer ? 'yes' : 'no'}`
			: `this computer’s settings for the folder say ${answer ? 'yes' : 'no'}`
}

function candidateFor(
	id: string,
	record: InstallRecord,
	answer: EnabledAnswer,
): InstalledCandidate {
	return {
		id,
		name: splitPluginId(id).name,
		record,
		scope: admissionScope(record.scope),
		installPath: realPathOrResolved(record.installPath),
		answer,
	}
}

interface ListRow {
	readonly id: string
	readonly name: string
	readonly marketplace: string
	readonly version: string | null
	readonly scope: RecordScope
	readonly projectPath?: string
	readonly enabled: boolean
	readonly enabledBy: RecordLayer | null
	readonly state: 'on' | 'off' | 'blocked'
	readonly attention: number
	readonly problem?: string
	readonly layout: string | null
	readonly installPath: string
}

function runList(deps: PluginRecordsDeps, flags: Flags): number {
	const command = 'plugin list'
	if (flags.positional.length > 0)
		return failure(deps, flags.json, command, EXIT_USAGE, 'plugin list takes no arguments.')
	const ctx = contextOf(deps, flags)
	const read = readInstalledPlugins(deps.namzuHome)
	if (read.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The install record could not be read: ${installedPluginsPath(deps.namzuHome)} (${read.reason}). Nothing was changed.`,
		)
	const layers = readLayers(deps.namzuHome, ctx.cwd, ctx.trusted)
	const problems: string[] = read.invalid.map((bad) => `${bad.id}: ${bad.reason}`)
	for (const [layer, layerRead] of Object.entries(layers)) {
		if (layerRead?.state === 'unreadable')
			problems.push(
				`${recordLayerPath(layer as RecordLayer, { home: deps.namzuHome, cwd: ctx.cwd })} could not be read (${layerRead.reason}), so what it says was not used`,
			)
	}
	const rows: ListRow[] = []
	let unread = 0
	for (const [id, records] of [...read.plugins.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const found = applicable(records, ctx.cwd, ctx.trusted)
		unread += found.unread
		if (found.here.length === 0) continue
		const answer = currentEnabledAnswer(
			{ home: deps.namzuHome, cwd: ctx.cwd, projectTrusted: ctx.trusted },
			id,
		)
		for (const record of found.here) {
			const verdict = verifyInstalledCopy(
				deps.namzuHome,
				id,
				record.installPath,
				record.surfaceSha256,
			)
			const notes = record.findings.filter(
				(f) => f.level === 'notUsed' || f.level === 'refused',
			).length
			const { name, marketplace } = splitPluginId(id)
			rows.push({
				id,
				name,
				marketplace,
				version: record.version ?? null,
				scope: record.scope,
				...(record.projectPath ? { projectPath: record.projectPath } : {}),
				enabled: answer.on,
				enabledBy: answer.by ?? null,
				state: verdict.ok ? (answer.on ? 'on' : 'off') : 'blocked',
				attention: notes + (verdict.ok ? 0 : 1),
				...(verdict.ok ? {} : { problem: verdict.message }),
				layout: record.layout ?? null,
				installPath: record.installPath,
			})
		}
	}
	// What this folder's own files ask for that this computer does not have.
	const asked: { id: string; layer: RecordLayer; installed: boolean }[] = []
	for (const layer of ['project', 'local'] as const) {
		const layerRead = layers[layer]
		if (layerRead === undefined || layerRead.state === 'unreadable') continue
		for (const [id, value] of layerRead.enabledPlugins) {
			if (!value) continue
			const have = rows.some((row) => row.id === id)
			if (!have) asked.push({ id, layer, installed: false })
		}
	}
	const declared: { name: string; layer: RecordLayer; source: unknown; added: boolean }[] = []
	const known = readKnownMarketplaces(deps.namzuHome)
	for (const layer of ['project', 'local'] as const) {
		const layerRead = layers[layer]
		if (layerRead === undefined || layerRead.state === 'unreadable') continue
		for (const market of layerRead.marketplaces.values())
			declared.push({
				name: market.name,
				layer,
				source: market.source,
				added: known.state !== 'unreadable' && known.marketplaces.has(market.name),
			})
	}
	const notice =
		unread > 0
			? `${unread} plugin ${unread === 1 ? 'record' : 'records'} for this folder ${unread === 1 ? 'was' : 'were'} not read because the folder is not trusted yet.`
			: undefined
	if (flags.json) {
		deps.out(
			`${JSON.stringify({
				command,
				cwd: ctx.cwd,
				trusted: ctx.trusted,
				loading: deps.loadingOn ? 'on' : 'off',
				plugins: rows,
				asked,
				declaredMarketplaces: declared,
				problems,
				...(notice ? { notice } : {}),
			})}\n`,
		)
		return EXIT_OK
	}
	const lines: string[] = []
	if (rows.length === 0) lines.push('No plugins are installed here.')
	else {
		const width = (pick: (row: ListRow) => string): number =>
			Math.max(...rows.map((row) => pick(row).length))
		const wId = width((r) => oneLine(r.id))
		const wVer = width((r) => oneLine(r.version ?? '-'))
		const wScope = width((r) => r.scope)
		for (const row of rows) {
			lines.push(
				`${oneLine(row.id).padEnd(wId)}  ${oneLine(row.version ?? '-').padEnd(wVer)}  ${row.scope.padEnd(wScope)}  ${row.state}${row.attention > 0 ? `  (${row.attention} to look at)` : ''}`,
			)
			if (row.problem) lines.push(`  ${oneLine(row.problem)}`)
		}
	}
	for (const ask of asked)
		lines.push(`${oneLine(ask.id)} is asked for here and is not installed on this computer.`)
	for (const market of declared)
		lines.push(
			`${oneLine(market.name)} is declared by this project, ${market.added ? 'and added' : 'not added'}.`,
		)
	for (const problem of problems) lines.push(`Not used: ${oneLine(problem)}`)
	if (notice) lines.push(notice)
	if (!deps.loadingOn && rows.length > 0)
		lines.push(
			'Plugin loading is off, so none of these run. Turn it on: namzu config set plugins.enabled true',
		)
	deps.out(`${lines.join('\n')}\n`)
	return EXIT_OK
}

function dataSize(path: string): number | null {
	let total = 0
	let seen = 0
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (++seen > 20_000) return
			const full = join(dir, entry)
			const stat = lstatSync(full)
			if (stat.isDirectory()) walk(full)
			else total += stat.size
		}
	}
	try {
		if (!lstatSync(path).isDirectory()) return null
		walk(path)
		return total
	} catch {
		return null
	}
}

async function runDetails(deps: PluginRecordsDeps, flags: Flags): Promise<number> {
	const command = 'plugin details'
	if (flags.positional.length !== 1)
		return failure(deps, flags.json, command, EXIT_USAGE, 'plugin details takes one plugin id.')
	const ctx = contextOf(deps, flags)
	const resolved = resolveId(deps, flags.json, command, flags.positional[0] as string)
	if (typeof resolved === 'number') return resolved
	const { id } = resolved
	const found = applicable(resolved.records, ctx.cwd, ctx.trusted)
	if (found.here.length === 0)
		return failure(
			deps,
			flags.json,
			command,
			found.unread > 0 ? EXIT_UNTRUSTED : EXIT_NOINPUT,
			found.unread > 0
				? 'This folder is not trusted yet. Open it with namzu once, or use --scope user.'
				: `${id} is not installed for this folder or for you.`,
			{ id },
		)
	const record = found.here[0] as InstallRecord
	const answer = currentEnabledAnswer(
		{ home: deps.namzuHome, cwd: ctx.cwd, projectTrusted: ctx.trusted },
		id,
	)
	const verdict = verifyInstalledCopy(deps.namzuHome, id, record.installPath, record.surfaceSha256)
	const manifestRead = readInstallManifest(deps.namzuHome, id)
	const { name, marketplace } = splitPluginId(id)
	const known = readKnownMarketplaces(deps.namzuHome)
	const source =
		known.state !== 'unreadable' ? (known.marketplaces.get(marketplace)?.source ?? null) : null
	const dataPath = installedPluginDataFolder(deps.namzuHome, id)

	let inventory: Record<string, unknown> | undefined
	if (verdict.ok) {
		try {
			const candidate = candidateFor(id, record, answer)
			const manifest = await loadInstalledManifest(candidate, {
				home: deps.namzuHome,
				cwd: ctx.cwd,
				installedNames: new Set<string>(),
			})
			const details = await readPluginManifestDetails(candidate.installPath, manifest)
			const prefix = `${manifest.name}__`
			const files = (declared: readonly string[] | undefined): string[] =>
				resolvePluginFileDirs(
					manifest.name,
					candidate.installPath,
					declared,
					manifest.layout,
				).dirs.flatMap((source) =>
					listMarkdownNames(source.dir, source.only).map((file) => `${prefix}${file}`),
				)
			inventory = {
				description: manifest.description,
				skills: (details.skills ?? []).map((skill) => skill.name),
				commands: files(manifest.commands),
				agents: files(manifest.agents),
				servers: (manifest.mcpServers ?? []).map((server) => server.name),
				...(details.author ? { author: details.author } : {}),
			}
		} catch (error) {
			inventory = { error: error instanceof Error ? error.message : String(error) }
		}
	}
	const surface = manifestRead.state === 'ok' ? manifestRead.manifest.surface : null
	const output = {
		command,
		id,
		name,
		marketplace,
		enabled: answer.on,
		enabledBy: answer.by ?? null,
		verification: verdict.ok
			? { ok: true }
			: { ok: false, code: verdict.code, message: verdict.message },
		records: found.here.map((r) => ({
			scope: r.scope,
			...(r.projectPath ? { projectPath: r.projectPath } : {}),
			installPath: r.installPath,
			version: r.version ?? null,
			installedAt: r.installedAt ?? null,
			lastUpdated: r.lastUpdated ?? null,
			gitCommitSha: r.gitCommitSha ?? null,
			layout: r.layout ?? null,
			findings: r.findings,
		})),
		origin: source,
		surface,
		surfaceSha256: manifestRead.state === 'ok' ? manifestRead.manifest.surfaceSha256 : null,
		executableFiles: manifestRead.state === 'ok' ? manifestRead.manifest.executable : [],
		consent: manifestRead.state === 'ok' ? (manifestRead.manifest.consent ?? null) : null,
		data: { path: dataPath, bytes: dataSize(dataPath) },
		inventory: inventory ?? null,
	}
	if (flags.json) {
		deps.out(`${JSON.stringify(output)}\n`)
		return EXIT_OK
	}
	const lines = [`${oneLine(id)}${record.version ? ` ${oneLine(record.version)}` : ''}`]
	const inv = inventory as { description?: string } | undefined
	if (inv?.description) lines.push(oneLine(inv.description))
	lines.push(
		`  State:    ${answer.on ? 'on' : 'off'} (${layerSentence(answer.by, answer.on)})`,
		`  Scope:    ${found.here.map((r) => r.scope).join(', ')}`,
		`  Origin:   ${source ? oneLine(JSON.stringify(source)) : `marketplace ${marketplace}`}`,
		`  Folder:   ${oneLine(record.installPath)}`,
		`  Data:     ${oneLine(dataPath)}${output.data.bytes === null ? ' (none yet)' : ` (${output.data.bytes} bytes)`}`,
	)
	if (!verdict.ok) lines.push(`  Blocked:  ${oneLine(verdict.message)}`)
	const listed = (label: string, items: unknown): void => {
		if (Array.isArray(items) && items.length > 0)
			lines.push(`  ${label}${items.map((item) => oneLine(String(item))).join(', ')}`)
	}
	if (inventory) {
		listed('Skills:   ', inventory.skills)
		listed('Commands: ', inventory.commands)
		listed('Agents:   ', inventory.agents)
		listed('Servers:  ', inventory.servers)
	}
	if (manifestRead.state === 'ok') {
		lines.push(
			`  Runs code: ${manifestRead.manifest.executable.length} executable ${manifestRead.manifest.executable.length === 1 ? 'file' : 'files'}, surface sha256:${manifestRead.manifest.surfaceSha256.slice(0, 12)}`,
		)
		const consent = manifestRead.manifest.consent
		if (consent && typeof consent.at === 'string')
			lines.push(
				`  Accepted: ${oneLine(consent.at)}${typeof consent.by === 'string' ? ` by ${oneLine(consent.by)}` : ''}`,
			)
	}
	for (const finding of record.findings)
		if (finding.level === 'notUsed' || finding.level === 'refused')
			lines.push(
				`  ${finding.level === 'refused' ? 'Refused' : 'Not used'}: ${oneLine(finding.message)}`,
			)
	deps.out(`${lines.join('\n')}\n`)
	return EXIT_OK
}

function runToggle(deps: PluginRecordsDeps, flags: Flags, enable: boolean): number {
	const command = enable ? 'plugin enable' : 'plugin disable'
	const verb = enable ? 'on' : 'off'
	if (flags.positional.length !== 1)
		return failure(deps, flags.json, command, EXIT_USAGE, `${command} takes one plugin id.`)
	const ctx = contextOf(deps, flags)
	const untrusted = 'This folder is not trusted yet. Open it with namzu once, or use --scope user.'
	if (!ctx.trusted && (flags.scope === 'project' || flags.scope === 'local'))
		return failure(deps, flags.json, command, EXIT_UNTRUSTED, untrusted)
	const resolved = resolveId(deps, flags.json, command, flags.positional[0] as string)
	if (typeof resolved === 'number') return resolved
	const { id } = resolved
	const found = applicable(resolved.records, ctx.cwd, ctx.trusted)
	const chosen = flags.scope ? found.here.find((r) => r.scope === flags.scope) : found.here[0]
	if (chosen === undefined) {
		if (!flags.scope && found.unread > 0)
			return failure(deps, flags.json, command, EXIT_UNTRUSTED, untrusted, { id })
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
	// Where the answer is written: the scope asked for, else the user's own file for a user
	// install and this computer's file for a folder's plugin ("off for me").
	const layer: RecordLayer = flags.scope ?? (chosen.scope === 'user' ? 'user' : 'local')
	const path = recordLayerPath(layer, { home: deps.namzuHome, cwd: ctx.cwd })
	const own = readRecordLayer(path)
	if (own.state === 'unreadable')
		return failure(
			deps,
			flags.json,
			command,
			EXIT_NOINPUT,
			`The plugin records in ${path} could not be read (${own.reason}), so nothing was changed.`,
			{ id },
		)
	let changed = false
	if (own.enabledPlugins.get(id) !== enable) {
		try {
			setEnabledPlugin(path, deps.namzuHome, id, enable)
			changed = true
		} catch (error) {
			const failed = stateFailure(error)
			return failure(deps, flags.json, command, failed.code, failed.message, { id })
		}
	}
	const answer = currentEnabledAnswer(
		{ home: deps.namzuHome, cwd: ctx.cwd, projectTrusted: ctx.trusted },
		id,
	)
	const notes: string[] = []
	if (answer.on !== enable)
		notes.push(
			`It is still ${answer.on ? 'on' : 'off'} here: ${layerSentence(answer.by, answer.on)}.`,
		)
	if (enable && !deps.loadingOn)
		notes.push(
			'Plugin loading is off, so it will not run until you run: namzu config set plugins.enabled true',
		)
	const message = changed
		? `Turned ${verb} ${id} (scope: ${layer}). It takes effect in new conversations.`
		: `${id} is already ${verb} at scope ${layer}.`
	if (flags.json)
		deps.out(
			`${JSON.stringify({
				command,
				outcome: changed ? (enable ? 'enabled' : 'disabled') : 'unchanged',
				id,
				scope: layer,
				message,
				effective: { enabled: answer.on, by: answer.by ?? null },
				loading: deps.loadingOn ? 'on' : 'off',
				...(notes.length > 0 ? { notes } : {}),
			})}\n`,
		)
	else deps.out(`${[message, ...notes].join('\n')}\n`)
	return EXIT_OK
}

export async function runPluginRecords(
	verb: PluginRecordVerb,
	args: readonly string[],
	deps: PluginRecordsDeps,
): Promise<number> {
	const flags = parseFlags(args)
	if (flags.error) return failure(deps, flags.json, `plugin ${verb}`, EXIT_USAGE, flags.error)
	switch (verb) {
		case 'list':
			return runList(deps, flags)
		case 'details':
			return runDetails(deps, flags)
		case 'enable':
			return runToggle(deps, flags, true)
		case 'disable':
			return runToggle(deps, flags, false)
	}
}
