/**
 * An installed plugin as the install step leaves it: the copy under
 * `plugins/cache/`, its install manifest with the executable files hashed, and
 * its record in `installed_plugins.json`. Install itself is a later step;
 * tests build the result directly, through the same writers the commands use.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
	INSTALL_MANIFEST_VERSION,
	installManifestPath,
	sha256Hex,
	surfaceDigest,
} from '../integrations/plugins/install-manifest.js'
import {
	type RecordScope,
	pluginCacheFolder,
	putInstallRecord,
	putKnownMarketplace,
	splitPluginId,
} from '../integrations/plugins/records.js'

export interface InstalledFixture {
	readonly id: string
	readonly installPath: string
	readonly digest: string
}

export interface InstalledFixtureOptions {
	readonly id: string
	readonly version?: string
	readonly scope?: RecordScope
	readonly projectPath?: string
	/** Files by path inside the plugin, replacing the default skill and plugin manifest. */
	readonly files?: Record<string, string | object>
	/** Paths that count as executable; each is hashed. Default `scripts/run.sh`. */
	readonly executable?: readonly string[]
	readonly layout?: 'common' | 'namzu'
	readonly installedAt?: string
	readonly skipManifest?: boolean
	readonly skipRecord?: boolean
	readonly record?: Record<string, unknown>
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nBody.\n`

export function writeFiles(root: string, files: Record<string, string | object>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
}

export function installFixture(home: string, options: InstalledFixtureOptions): InstalledFixture {
	const { name, marketplace } = splitPluginId(options.id)
	const version = options.version ?? '1.0.0'
	const installPath = join(pluginCacheFolder(home), marketplace, name, version)
	const common = options.layout === 'common'
	const files: Record<string, string | object> = options.files ?? {
		[common ? '.claude-plugin/plugin.json' : 'plugin.json']: {
			name,
			version,
			description: `The ${name} fixture.`,
			...(common ? {} : { skills: [`skills/${name}-skill`] }),
		},
		[`skills/${name}-skill/SKILL.md`]: skill(`${name}-skill`),
		'scripts/run.sh': '#!/bin/sh\ntrue\n',
	}
	writeFiles(installPath, files)
	const executable = [...(options.executable ?? ['scripts/run.sh'])]
	const hashes: Record<string, string> = {}
	for (const path of executable) {
		const content = files[path]
		hashes[path] = sha256Hex(typeof content === 'string' ? content : JSON.stringify(content))
	}
	const surface = { hooks: [], mcpLocal: [], mcpRemote: [], modules: [], allowedTools: [] }
	const digest = surfaceDigest(surface, hashes, executable)
	if (!options.skipManifest) {
		const manifestPath = installManifestPath(home, options.id)
		mkdirSync(dirname(manifestPath), { recursive: true })
		writeFileSync(
			manifestPath,
			JSON.stringify({
				version: INSTALL_MANIFEST_VERSION,
				id: options.id,
				installedFrom: { marketplace },
				executable,
				files: hashes,
				surface,
				surfaceSha256: digest,
				consent: { at: '2026-11-27T10:00:00.000Z', scope: options.scope ?? 'user', by: 'cli' },
			}),
		)
	}
	if (!options.skipRecord) {
		const scope = options.scope ?? 'user'
		putInstallRecord(home, options.id, {
			scope,
			installPath,
			...(scope !== 'user' ? { projectPath: options.projectPath ?? '/nowhere' } : {}),
			version,
			installedAt: options.installedAt ?? '2026-11-27T10:00:00.000Z',
			layout: options.layout ?? 'namzu',
			surfaceSha256: digest,
			...options.record,
		})
	}
	return { id: options.id, installPath, digest }
}

export function addMarketplace(home: string, name: string): void {
	putKnownMarketplace(home, name, {
		source: { source: 'directory', path: join(home, 'catalogs', name) },
		installLocation: join(home, 'catalogs', name),
	})
}
