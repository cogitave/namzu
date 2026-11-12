import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The command line's half of the guard behind `DATA_EPOCH` (the engine's half is
 * `packages/sdk/src/__tests__/data-epoch-guard.test.ts`). Every on-disk format
 * this package stamps with a version is listed with its current version; a
 * version that changes, appears or disappears fails here, so changing what an
 * older command line would meet on disk is a decision with a name. The inventory,
 * including the formats with no stamp, is `docs/sdk/kernel-facts.md`.
 */

const RULE = [
	'RULE: raise DATA_EPOCH (packages/sdk/src/constants/data-epoch.ts, and its recorded value in',
	'packages/sdk/src/__tests__/data-epoch-guard.test.ts) when an older command line can no longer safely',
	'read or write what this one writes (it would refuse the file, drop fields it does not know and write them',
	'back without, or misread it). Raising it means an installed desktop application stops using this',
	'build until the application itself is updated, so do it only when it is true.',
	'Otherwise (an older command line reads and writes the new form the same way, or ignores it) record the',
	'new value in this table and say why in the same commit. The inventory is docs/sdk/kernel-facts.md.',
].join('\n')

/** `file#NAME` of a version constant. `onDisk` false: not a file format. */
const CONSTANTS: Record<string, { version: number; onDisk: boolean }> = {
	'checkpoints/manifest.ts#MANIFEST_VERSION': { version: 1, onDisk: true },
	'computer/run.ts#COMPUTER_JSON_VERSION': { version: 1, onDisk: false },
	'integrations/harness/model-cache.ts#VERSION': { version: 1, onDisk: true },
	'integrations/mcp/project-approval.ts#FILE_VERSION': { version: 1, onDisk: true },
	// The `--json` report of `namzu plugin validate`: printed, never stored.
	'integrations/plugins/validate.ts#PLUGIN_VALIDATION_REPORT_VERSION': {
		version: 1,
		onDisk: false,
	},
	'integrations/providers/credential-store.ts#CREDENTIALS_FILE_VERSION': {
		version: 1,
		onDisk: true,
	},
	'integrations/providers/preferences.ts#PREFERENCES_FILE_VERSION': { version: 3, onDisk: true },
	// <home>/spend-ledger.json: a rebuildable summary of the session logs. An older command line
	// ignores the file; a newer or older version of it is rebuilt from the logs, never migrated.
	'integrations/spend/ledger.ts#SPEND_LEDGER_VERSION': { version: 3, onDisk: true },
	// `namzu cost --json`: printed for scripts, never written to disk.
	'integrations/spend/report.ts#SPEND_REPORT_SCHEMA_VERSION': { version: 1, onDisk: false },
	'integrations/trust/store.ts#TRUST_FILE_VERSION': { version: 1, onDisk: true },
	'memory/usage.ts#VERSION': { version: 1, onDisk: true },
	'permissions/consent.ts#VERSION': { version: 1, onDisk: true },
	'schedule/types.ts#SCHEDULE_FORMAT_VERSION': { version: 3, onDisk: true },
	'schedule/types.ts#SCHEDULE_FORMAT_VERSION_LEGACY': { version: 1, onDisk: true },
	'schedule/types.ts#SCHEDULE_FORMAT_VERSION_SCRIPT': { version: 2, onDisk: true },
}

/** `packages/`, where the capability packages the command line ships with keep their sources. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Stamps that a capability package writes under the person's home or in a cache. The packages are
 * leaves, so the guard for them sits here, in the composition root that ships them. `file` is
 * relative to `packages/`.
 */
const CAPABILITY_STAMPS: { format: string; file: string; pattern: RegExp; version: number }[] = [
	{
		format: 'browser profile descriptor (browser/profiles/<name>.json)',
		file: 'browser/src/profiles.ts',
		pattern: /export interface BrowserProfileDescriptor \{\s*readonly v: (\d+)/,
		version: 1,
	},
	{
		format: 'browser profile lease (browser/leases/<name>/<pid>-<session>.json)',
		file: 'browser/src/profiles.ts',
		pattern: /export interface BrowserLeaseRecord \{\s*readonly v: (\d+)/,
		version: 1,
	},
	{
		format: 'analysis index cache (the version is part of the file name)',
		file: 'analysis/src/store.ts',
		pattern: /export const SCHEMA_VERSION = (\d+)/,
		version: 3,
	},
]

/** Stamps written as a literal in a type. `pattern` has one capture group: the version. */
const LITERAL_STAMPS: { format: string; file: string; pattern: RegExp; version: number }[] = [
	{
		format: 'workspaces.json (the window layout)',
		file: 'workspaces/store.ts',
		pattern: /readonly version: (\d+)/,
		version: 3,
	},
	{
		format: 'mcp-oauth/<endpoint>.json',
		file: 'integrations/mcp/oauth-store.ts',
		pattern: /readonly version: (\d+)/,
		version: 1,
	},
	{
		format: 'plugin-settings/<plugin>.json',
		file: 'integrations/plugins/settings.ts',
		pattern: /version: (\d+), rootDir/,
		version: 1,
	},
	{
		format: 'learning generator.json',
		file: 'integrations/learning/generator-state.ts',
		pattern: /readonly version: (\d+)/,
		version: 1,
	},
	{
		format: 'schedule/daemon/endpoint.json',
		file: 'schedule/daemon/endpoint.ts',
		pattern: /readonly v: (\d+)\s*readonly kind: 'schedule-endpoint'/,
		version: 1,
	},
	{
		format: 'schedule source delivery record',
		file: 'schedule/delivery.ts',
		pattern: /readonly v: (\d+)\s*readonly kind: 'schedule-source-delivery'/,
		version: 1,
	},
	{
		format: 'schedule/service.json',
		file: 'schedule/service/manifest.ts',
		pattern: /readonly v: (\d+)/,
		version: 1,
	},
	{
		format: 'schedule script state',
		file: 'schedule/store/script-state.ts',
		pattern: /readonly v: (\d+)/,
		version: 1,
	},
	{
		format: 'skills/.suggestions.json',
		file: 'tui/skills/suggestion-ledger.ts',
		pattern: /readonly v: (\d+)/,
		version: 1,
	},
	{
		format: 'session loops file',
		file: 'tui/schedule/loop-host.ts',
		pattern: /readonly v: (\d+)\s*readonly kind: 'session-loops'/,
		version: 1,
	},
	{
		format: 'schedule notification throttle',
		file: 'integrations/notifications/desktop/throttle.ts',
		pattern: /readonly v: (\d+)/,
		version: 1,
	},
]

const SRC = join(dirname(fileURLToPath(import.meta.url)))

function sources(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === '__fixtures__') continue
			out.push(...sources(path))
		} else if (
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts') &&
			!entry.name.endsWith('.proc-test.ts')
		) {
			out.push(path)
		}
	}
	return out
}

const files = sources(SRC).map((path) => ({
	name: relative(SRC, path).split('\\').join('/'),
	text: readFileSync(path, 'utf8'),
}))

describe('data epoch guard (command line)', () => {
	it('knows every version constant', () => {
		const found: Record<string, number> = {}
		const pattern =
			/^\s*(?:export )?const ((?:[A-Z0-9]+_)*VERSION(?:_[A-Z0-9]+)*)(?::\s*\w+)? = (\d+)(?: as const)?\s*$/gm
		for (const file of files) {
			for (const match of file.text.matchAll(pattern)) {
				found[`${file.name}#${match[1]}`] = Number(match[2])
			}
		}
		const recorded = Object.fromEntries(Object.entries(CONSTANTS).map(([k, v]) => [k, v.version]))
		const diff: string[] = []
		for (const [key, version] of Object.entries(found)) {
			if (!(key in recorded)) diff.push(`added: ${key} = ${version}`)
			else if (recorded[key] !== version)
				diff.push(`changed: ${key} ${recorded[key]} -> ${version}`)
		}
		for (const key of Object.keys(recorded)) {
			if (!(key in found)) diff.push(`removed or no longer found: ${key}`)
		}
		expect(diff, `A version constant changed.\n${diff.join('\n')}\n${RULE}`).toEqual([])
	})

	it('knows every literal stamp it lists', () => {
		const diff: string[] = []
		for (const stamp of LITERAL_STAMPS) {
			const file = files.find((candidate) => candidate.name === stamp.file)
			const match = file ? stamp.pattern.exec(file.text) : null
			if (!match) diff.push(`not found: ${stamp.format} in ${stamp.file}`)
			else if (Number(match[1]) !== stamp.version) {
				diff.push(`changed: ${stamp.format} ${stamp.version} -> ${match[1]}`)
			}
		}
		expect(diff, `A literal stamp changed or moved.\n${diff.join('\n')}\n${RULE}`).toEqual([])
	})

	it('knows the stamps of the capability packages this program ships with', () => {
		const diff: string[] = []
		for (const stamp of CAPABILITY_STAMPS) {
			let text = ''
			try {
				text = readFileSync(join(PACKAGES, stamp.file), 'utf8')
			} catch {
				// reported below as not found
			}
			const match = stamp.pattern.exec(text)
			if (!match) diff.push(`not found: ${stamp.format} in packages/${stamp.file}`)
			else if (Number(match[1]) !== stamp.version) {
				diff.push(`changed: ${stamp.format} ${stamp.version} -> ${match[1]}`)
			}
		}
		expect(
			diff,
			`A capability package stamp changed or moved.\n${diff.join('\n')}\n${RULE}`,
		).toEqual([])
	})

	it('names no stamp twice', () => {
		const names = LITERAL_STAMPS.map((stamp) => stamp.format)
		expect(new Set(names).size).toBe(names.length)
	})
})
