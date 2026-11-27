/**
 * The two plugin keys a settings file may carry, and nothing else of it:
 *
 * - `enabledPlugins`: `{ "<name>@<marketplace>": true | false }`, the recorded
 *   yes or no for an installed plugin.
 * - `extraKnownMarketplaces`: `{ "<name>": { "source": { "source": ... } } }`,
 *   marketplaces a layer suggests.
 *
 * They live in three files, one per layer: the user's `$NAMZU_HOME/settings.json`,
 * the project's `.namzu/settings.json` (shared) and `.namzu/settings.local.json`
 * (this computer). They are read here and not by the config layers, so config
 * precedence is untouched; every other key of the file is kept as written when
 * one of these changes.
 *
 * Who may say "on": the user's and the local file speak for themselves. A
 * project file's `true` counts only when this computer has a record for that
 * folder or the plugin installed at user scope: a repository cannot turn a
 * plugin on by naming it. A project file's `false` always counts.
 */

import { join, resolve } from 'node:path'

import { LOCAL_SETTINGS_FILE, PROJECT_SETTINGS_FILE } from '../../config/project-files.js'
import { isRecord, readJsonObject, updateJsonObject } from './json-state.js'
import {
	type InstallRecord,
	MARKETPLACE_NAME_PATTERN,
	isPluginId,
	parseMarketplaceSource,
	samePath,
} from './records.js'

/** The most keys either record may hold in one file. */
export const RECORD_KEY_CAP = 500

export type RecordLayer = 'user' | 'project' | 'local'

/** Highest first: the layer that speaks wins. */
export const RECORD_LAYERS_BY_PRECEDENCE: readonly RecordLayer[] = ['local', 'project', 'user']

export function recordLayerPath(layer: RecordLayer, where: { home: string; cwd: string }): string {
	if (layer === 'user') return join(where.home, 'settings.json')
	return resolve(
		where.cwd,
		...(layer === 'project' ? PROJECT_SETTINGS_FILE : LOCAL_SETTINGS_FILE).split('/'),
	)
}

export interface MarketplaceDeclaration {
	readonly name: string
	readonly source: Readonly<Record<string, unknown>> & { readonly source: string }
}

export type RecordLayerRead =
	| {
			readonly state: 'missing' | 'ok'
			readonly enabledPlugins: ReadonlyMap<string, boolean>
			readonly marketplaces: ReadonlyMap<string, MarketplaceDeclaration>
			/** Keys that are not a plugin id or a marketplace name, or whose value is not the right kind. */
			readonly ignored: readonly string[]
	  }
	| { readonly state: 'unreadable'; readonly reason: string }

function recordShape(raw: Record<string, unknown>): string | undefined {
	for (const key of ['enabledPlugins', 'extraKnownMarketplaces'] as const) {
		const value = raw[key]
		if (value === undefined) continue
		if (!isRecord(value)) return `its "${key}" entry is not a mapping`
		if (Object.keys(value).length > RECORD_KEY_CAP)
			return `its "${key}" entry has more than ${RECORD_KEY_CAP} keys`
	}
	return undefined
}

/**
 * One layer's two records. A file that does not read, or whose records are not
 * mappings or hold more than 500 keys, is `unreadable`: it says nothing, and the
 * caller treats that as "not on". A key that is not an id or a marketplace
 * name, and a value that is not a yes or a no, is left out and listed.
 */
export function readRecordLayer(path: string): RecordLayerRead {
	const read = readJsonObject(path, recordShape)
	if (read.state === 'unreadable') return read
	const enabledPlugins = new Map<string, boolean>()
	const marketplaces = new Map<string, MarketplaceDeclaration>()
	const ignored: string[] = []
	if (read.state === 'ok') {
		const enabled = read.raw.enabledPlugins
		if (isRecord(enabled)) {
			for (const [id, value] of Object.entries(enabled)) {
				if (isPluginId(id) && typeof value === 'boolean') enabledPlugins.set(id, value)
				else ignored.push(`enabledPlugins.${id}`)
			}
		}
		const declared = read.raw.extraKnownMarketplaces
		if (isRecord(declared)) {
			for (const [name, entry] of Object.entries(declared)) {
				const source = isRecord(entry) ? parseMarketplaceSource(entry.source) : 'not a mapping'
				if (MARKETPLACE_NAME_PATTERN.test(name) && typeof source !== 'string')
					marketplaces.set(name, { name, source })
				else ignored.push(`extraKnownMarketplaces.${name}`)
			}
		}
	}
	return { state: read.state, enabledPlugins, marketplaces, ignored }
}

/**
 * Set (`true` or `false`) or clear (`undefined`) one plugin's entry in one
 * layer's file. A new key past 500 is refused.
 */
export function setEnabledPlugin(
	path: string,
	home: string,
	id: string,
	value: boolean | undefined,
): void {
	if (!isPluginId(id)) throw new Error(`"${id}" is not a plugin id (name@marketplace).`)
	updateJsonObject(
		path,
		{
			home,
			check: recordShape,
			remedy: 'Fix or remove the file, then try again. Nothing was changed.',
		},
		(raw) => {
			const current = isRecord(raw.enabledPlugins) ? { ...raw.enabledPlugins } : {}
			if (value === undefined) {
				if (!(id in current)) return false
				delete current[id]
			} else {
				if (!(id in current) && Object.keys(current).length >= RECORD_KEY_CAP)
					throw new Error(
						`${path} already lists ${RECORD_KEY_CAP} plugins, which is the most a settings file keeps, so ${id} was not added.`,
					)
				current[id] = value
			}
			raw.enabledPlugins = current
			return true
		},
	)
}

/** Add one marketplace declaration to one layer's file; a new key past 500 is refused. */
export function setExtraKnownMarketplace(
	path: string,
	home: string,
	name: string,
	source: unknown,
): void {
	if (!MARKETPLACE_NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a marketplace name.`)
	const checked = parseMarketplaceSource(source)
	if (typeof checked === 'string') throw new Error(`Not a valid marketplace: ${checked}.`)
	updateJsonObject(path, { home, check: recordShape }, (raw) => {
		const current = isRecord(raw.extraKnownMarketplaces) ? { ...raw.extraKnownMarketplaces } : {}
		if (!(name in current) && Object.keys(current).length >= RECORD_KEY_CAP)
			throw new Error(
				`${path} already declares ${RECORD_KEY_CAP} marketplaces, which is the most a settings file keeps, so ${name} was not added.`,
			)
		current[name] = { source }
		raw.extraKnownMarketplaces = current
		return true
	})
}

/** Remove one marketplace declaration from one layer's file; false when it was not there. */
export function removeExtraKnownMarketplace(path: string, home: string, name: string): boolean {
	return updateJsonObject(path, { home, check: recordShape }, (raw) => {
		if (!isRecord(raw.extraKnownMarketplaces) || !(name in raw.extraKnownMarketplaces)) return false
		const current = { ...raw.extraKnownMarketplaces }
		delete current[name]
		raw.extraKnownMarketplaces = current
		return true
	})
}

export type LayerReads = Readonly<Partial<Record<RecordLayer, RecordLayerRead>>>

export interface EnabledAnswer {
	readonly on: boolean
	/** The layer that spoke; absent when none did. */
	readonly by?: RecordLayer
}

/** Whether this computer has the plugin installed for the folder, or for the user. */
export function installedHere(records: readonly InstallRecord[], cwd: string): boolean {
	return records.some(
		(record) =>
			record.scope === 'user' ||
			(record.projectPath !== undefined && samePath(record.projectPath, cwd)),
	)
}

/**
 * The recorded answer for one plugin: local, then project, then user; the
 * highest layer that speaks wins. A project `true` is skipped (it does not
 * speak) unless `installed` says this computer has the plugin for the folder or
 * for the user. A layer that did not read does not speak. No layer speaking
 * means off: an installed plugin needs a recorded yes.
 */
export function resolveEnabled(id: string, layers: LayerReads, installed: boolean): EnabledAnswer {
	for (const layer of RECORD_LAYERS_BY_PRECEDENCE) {
		const read = layers[layer]
		if (read === undefined || read.state === 'unreadable') continue
		const value = read.enabledPlugins.get(id)
		if (value === undefined) continue
		if (layer === 'project' && value && !installed) continue
		return { on: value, by: layer }
	}
	return { on: false }
}
