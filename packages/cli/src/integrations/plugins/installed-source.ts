/**
 * The plugins this computer installed, as the runtime's third source.
 *
 * What to load comes from the install records, not from a folder scan, so
 * `plugins.autoDiscovery: false` does not hide an installed plugin: it is an
 * explicit record. For each id the plan names the one record that applies here,
 * says whether the recorded answer is on, and proves the installed copy is what
 * was accepted. A plugin that fails any of it is skipped and reported; it never
 * stops the others.
 *
 * Project and local records, and the project's two settings files, are read
 * only when the folder is trusted: an untrusted folder reads none of them.
 */

import { type PluginManifest, loadPluginManifestWithFindings, readCommonLayout } from '@namzu/sdk'

import type { PluginScope } from '../../config/schema.js'
import {
	type EnabledAnswer,
	type LayerReads,
	type RecordLayer,
	installedHere,
	readRecordLayer,
	recordLayerPath,
	resolveEnabled,
} from './enabled-records.js'
import { verifyInstalledCopy } from './install-manifest.js'
import {
	type InstallRecord,
	type RecordScope,
	installedPluginDataFolder,
	installedPluginsPath,
	readInstalledPlugins,
	realPathOrResolved,
	samePath,
	splitPluginId,
} from './records.js'

/** What the loader needs to know about one installed plugin to admit it. */
export interface InstalledCandidate {
	readonly id: string
	readonly name: string
	readonly record: InstallRecord
	/** The scope the lifecycle manager admits it under; a local record is the project's. */
	readonly scope: PluginScope
	/** The canonical folder the plugin runs from. */
	readonly installPath: string
	readonly answer: EnabledAnswer
}

export interface InstalledProblem {
	readonly id: string | undefined
	readonly message: string
}

export interface InstalledPlan {
	readonly candidates: readonly InstalledCandidate[]
	readonly problems: readonly InstalledProblem[]
	/** The settings layers as read, for listings that explain who said what. */
	readonly layers: LayerReads
	/** Whether the folder's own records were read. */
	readonly projectRead: boolean
}

export interface PlanInstalledOptions {
	readonly home: string
	readonly cwd: string
	/** The folder is trusted: only then are its records and settings files read. */
	readonly projectTrusted: boolean
	readonly allowedScopes: readonly PluginScope[]
}

/** A record's scope as `plugins.allowedScopes` counts it: a local record is the project's. */
export function admissionScope(scope: RecordScope): PluginScope {
	return scope === 'user' ? 'user' : 'project'
}

const SPECIFICITY: Readonly<Record<RecordScope, number>> = { local: 3, project: 2, user: 1 }

/** The layers a plan reads: the user's always, the folder's two only in a trusted folder. */
export function readLayers(home: string, cwd: string, projectTrusted: boolean): LayerReads {
	const layers: Partial<Record<RecordLayer, ReturnType<typeof readRecordLayer>>> = {
		user: readRecordLayer(recordLayerPath('user', { home, cwd })),
	}
	if (projectTrusted) {
		layers.project = readRecordLayer(recordLayerPath('project', { home, cwd }))
		layers.local = readRecordLayer(recordLayerPath('local', { home, cwd }))
	}
	return layers
}

function unreadableLayerProblems(
	layers: LayerReads,
	home: string,
	cwd: string,
): InstalledProblem[] {
	const out: InstalledProblem[] = []
	for (const [layer, read] of Object.entries(layers)) {
		if (read?.state === 'unreadable')
			out.push({
				id: undefined,
				message: `The plugin records in ${recordLayerPath(layer as RecordLayer, { home, cwd })} could not be read (${read.reason}), so what it says was not used.`,
			})
	}
	return out
}

export function planInstalledPlugins(options: PlanInstalledOptions): InstalledPlan {
	const { home, cwd, projectTrusted } = options
	const layers = readLayers(home, cwd, projectTrusted)
	const problems: InstalledProblem[] = unreadableLayerProblems(layers, home, cwd)
	const read = readInstalledPlugins(home)
	if (read.state === 'unreadable') {
		problems.push({
			id: undefined,
			message: `The install record could not be read, so no installed plugin was loaded: ${installedPluginsPath(home)} (${read.reason}). Nothing was changed.`,
		})
		return { candidates: [], problems, layers, projectRead: projectTrusted }
	}
	for (const bad of read.invalid)
		problems.push({ id: bad.id, message: `A record of ${bad.id} was skipped: ${bad.reason}.` })

	const candidates: InstalledCandidate[] = []
	for (const [id, records] of [...read.plugins.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const applicable = records.filter((record) => {
			if (!options.allowedScopes.includes(admissionScope(record.scope))) return false
			if (record.scope === 'user') return true
			return projectTrusted && record.projectPath !== undefined && samePath(record.projectPath, cwd)
		})
		if (applicable.length === 0) continue
		const chosen = [...applicable].sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope])[0]
		if (chosen === undefined) continue
		const verdict = verifyInstalledCopy(home, id, chosen.installPath, chosen.surfaceSha256)
		if (!verdict.ok) {
			problems.push({ id, message: `${id}: ${verdict.message}` })
			continue
		}
		candidates.push({
			id,
			name: splitPluginId(id).name,
			record: chosen,
			scope: admissionScope(chosen.scope),
			installPath: realPathOrResolved(chosen.installPath),
			answer: resolveEnabled(id, layers, installedHere(records, cwd)),
		})
	}
	// Between two installed plugins with one name the first installed wins.
	candidates.sort(
		(a, b) =>
			(a.record.installedAt ?? '').localeCompare(b.record.installedAt ?? '') ||
			a.id.localeCompare(b.id),
	)
	return { candidates, problems, layers, projectRead: projectTrusted }
}

/** The recorded answer for one id now, read again: what a listing or a toggle shows. */
export function currentEnabledAnswer(
	options: { readonly home: string; readonly cwd: string; readonly projectTrusted: boolean },
	id: string,
): EnabledAnswer {
	const layers = readLayers(options.home, options.cwd, options.projectTrusted)
	const read = readInstalledPlugins(options.home)
	const records = read.state === 'unreadable' ? [] : (read.plugins.get(id) ?? [])
	return resolveEnabled(id, layers, installedHere(records, options.cwd))
}

/**
 * The manifest of one installed plugin, read from its cache folder. A plugin
 * read in the common plugin layout gets its install sidecar read too (the
 * record names this folder, so the sidecar is trusted here and nowhere else);
 * a refusal throws with the reason. `manifest` is absent for a folder with
 * Namzu's own `plugin.json`, which the loader reads itself.
 */
export async function readInstalledManifest(
	candidate: InstalledCandidate,
	where: {
		readonly home: string
		readonly cwd: string
		readonly installedNames: ReadonlySet<string>
	},
): Promise<{
	readonly manifest?: PluginManifest
	readonly findings: readonly { readonly level: string; readonly message: string }[]
}> {
	if (candidate.record.layout !== 'common') return { findings: [] }
	const read = await readCommonLayout(candidate.installPath, {
		entrySidecar: true,
		installedIds: where.installedNames,
		paths: () => ({
			project: where.cwd,
			data: installedPluginDataFolder(where.home, candidate.id),
		}),
		...(candidate.record.version !== undefined ? { version: candidate.record.version } : {}),
	})
	if (read.refusal !== undefined) throw new Error(read.refusal.message)
	return read.manifest !== undefined
		? { manifest: read.manifest, findings: read.findings }
		: { findings: [] }
}

/** The manifest a candidate will be admitted with, for callers that read it without admitting it. */
export async function loadInstalledManifest(
	candidate: InstalledCandidate,
	where: {
		readonly home: string
		readonly cwd: string
		readonly installedNames: ReadonlySet<string>
	},
): Promise<PluginManifest> {
	const read = await readInstalledManifest(candidate, where)
	if (read.manifest !== undefined) return read.manifest
	return (await loadPluginManifestWithFindings(candidate.installPath, { skillsSupported: true }))
		.manifest
}
