/**
 * Plugin sources as a person would hold them: a plugin folder in the common
 * plugin layout, a marketplace folder with a catalog and relative entries, and
 * an archive of either. Tests build them here, then install through the real
 * commands.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { makeZip } from '../integrations/extensions/__fixtures__/package-builder.js'

// The layout's own manifest and catalog folder, spelled once for the fixtures.
export const MANIFEST = '.claude-plugin/plugin.json'
export const CATALOG = '.claude-plugin/marketplace.json'

export const skill = (name: string, extra = '') =>
	`---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\nBody.\n`

export function write(dir: string, files: Record<string, string | object>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
}

export interface PluginOptions {
	readonly version?: string
	/** Replace the default files entirely. */
	readonly files?: Record<string, string | object>
	/** Add to the default files. */
	readonly extra?: Record<string, string | object>
}

/** A plugin that has one of every runnable kind. */
export function makePlugin(dir: string, name: string, options: PluginOptions = {}): string {
	write(
		dir,
		options.files ?? {
			[MANIFEST]: {
				name,
				version: options.version ?? '1.0.0',
				description: `The ${name} plugin.`,
				mcpServers: {
					[`${name}-db`]: {
						command: 'node',
						args: ['${NAMZU_PLUGIN_ROOT}/server.js'],
						env: { MODE: 'test' },
					},
					[`${name}-api`]: {
						url: 'https://mcp.example.com/v1',
						headers: { Authorization: 'Bearer ${LEDGER_TOKEN}' },
					},
				},
			},
			'skills/reconcile/SKILL.md': skill('reconcile', 'allowed-tools: Bash(git log:*) Read\n'),
			'commands/close.md': 'Close the books.',
			'agents/auditor.md': '---\nname: auditor\ndescription: Audits.\n---\nAudit.\n',
			'hooks/hooks.json': {
				hooks: {
					PreToolUse: [
						{
							matcher: 'Bash',
							hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
						},
					],
				},
			},
			'server.js': '// a server\n',
			'scripts/guard.sh': '#!/bin/sh\nexit 0\n',
			...options.extra,
		},
	)
	try {
		chmodSync(join(dir, 'scripts/guard.sh'), 0o755)
	} catch {
		// A plugin with its own files has no guard script.
	}
	return dir
}

export interface CatalogItem {
	readonly name: string
	readonly source: unknown
	readonly extra?: Record<string, unknown>
}

/** A marketplace folder: the catalog, and a plugin folder under `plugins/` for each local entry. */
export function makeMarketplace(
	dir: string,
	name: string,
	entries: readonly CatalogItem[],
	extra: Record<string, unknown> = {},
): string {
	write(dir, {
		[CATALOG]: {
			name,
			owner: { name: 'Acme Tools' },
			plugins: entries.map((e) => ({ name: e.name, source: e.source, ...e.extra })),
			...extra,
		},
	})
	return dir
}

export { makeZip }

/** A zip of a plugin folder's files, with the execute bit on the ones named. */
export function zipOf(
	files: Record<string, string | object>,
	executable: readonly string[] = [],
): Buffer {
	return makeZip(
		Object.entries(files).map(([name, content]) => ({
			name,
			data: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
			...(executable.includes(name) ? { mode: 0o100755 } : {}),
		})),
	)
}
