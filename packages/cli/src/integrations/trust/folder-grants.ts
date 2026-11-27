/**
 * What a folder's own config pre-approves, read for the trust prompt.
 *
 * The gate asks before the folder's config is applied, so this reads the
 * folder's settings files (`project-files.ts`) straight from disk and never validates or merges them: a file
 * that cannot be read or is not an object grants nothing here, and the real
 * load reports it once the folder is trusted. Only what the person needs to
 * weigh the choice is returned: the allow rules, the extra directories and
 * the names of the tool servers the shared file declares and the hooks the
 * files declare.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { parseAgentMarkdown } from '@namzu/sdk'

import { hooksOfElement } from '../../config/hook-common-shape.js'
import { folderConfigFiles } from '../../config/project-files.js'
import { readSkillHooks, withoutSessionStart } from '../../config/skill-hooks-reader.js'
import { discoverSkills } from '../../skills/store.js'
import { fingerprintMcpServer } from '../mcp/project-approval.js'
import { PROJECT_MCP_FILE, parseMcpServerFile } from '../mcp/shared-file.js'
import { readInstallManifest } from '../plugins/install-manifest.js'
import { isPluginId, readInstalledPlugins, samePath, splitPluginId } from '../plugins/records.js'
import { resolveNamzuHome } from '../state/home.js'
import { readAgentHooks } from '../subagents/agent-hooks.js'

/** Rules shown before the rest are counted. */
export const MAX_SHOWN_GRANT_RULES = 8

/** One tool server the shared file declares, as the trust screen shows it. */
export interface ToolServerGrant {
	readonly name: string
	/** What starting it runs or reaches: the command and arguments, or the address. Never env or headers. */
	readonly runs: string
	/** Taken when the screen is built; accepting the folder approves exactly this entry. */
	readonly fingerprint: string
}

/** One hook the folder's files declare, as the trust screen shows it. */
export interface HookGrant {
	/** The event it runs at, as written. */
	readonly event: string
	/** What it runs or reaches: the command (and arguments), `POST <address>`, or the start of its prompt. */
	readonly runs: string
}

/** The longest text one shown hook carries. */
const MAX_HOOK_RUNS_CHARS = 200

/** One plugin the folder's own settings files ask for, and whether this computer has it. */
export interface PluginRecordGrant {
	readonly id: string
	/** The file that says it: the shared `.namzu/settings.json` or this computer's `.namzu/settings.local.json`. */
	readonly layer: 'project' | 'local'
	/** `true` asks for it to be on here; `false` turns it off here. */
	readonly on: boolean
	/** A record on this computer exists for this folder, or the plugin is installed for the user. */
	readonly installed: boolean
}

/** A marketplace the folder's settings declare; a suggestion, never an add. */
export interface MarketplaceGrant {
	readonly name: string
	/** Where it would come from, in a few words. */
	readonly from: string
}

export interface FolderGrants {
	/** Allow rules in the order written, `tool` or `tool(pattern)`, each once. */
	readonly allowRules: readonly string[]
	/** Extra directories the folder adds to the workspace, as written, each once. */
	readonly directories: readonly string[]
	/** Tool servers the folder's shared file declares; approving the folder approves these. */
	readonly toolServers: readonly ToolServerGrant[]
	/** Hooks the folder's own files declare, in file order; they run on events once the folder is trusted. */
	readonly hooks: readonly HookGrant[]
	/** Plugins the folder's settings files turn on or off here. */
	readonly pluginRecords?: readonly PluginRecordGrant[]
	/** Marketplaces the folder's settings files declare. */
	readonly marketplaces?: readonly MarketplaceGrant[]
}

/** The address without credentials or a query, which can carry a token. */
function plainAddress(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url.split(/[?#]/)[0] ?? url
	}
}

/** Say what an entry would start or reach, in the words of the file. */
function describeRuns(entry: unknown): string {
	if (entry === null || typeof entry !== 'object') return 'unknown'
	const spec = entry as { command?: unknown; args?: unknown; url?: unknown }
	if (typeof spec.command === 'string' && spec.command.length > 0) {
		const args = Array.isArray(spec.args)
			? spec.args.filter((arg): arg is string => typeof arg === 'string')
			: []
		return [spec.command, ...args].join(' ').replace(/\s+/g, ' ')
	}
	if (typeof spec.url === 'string' && spec.url.length > 0) return plainAddress(spec.url)
	return 'unknown'
}

/** The hooks a config object declares, each as what it would run; unreadable shapes are skipped. */
function describeHooks(config: Record<string, unknown>): HookGrant[] {
	const hooks = config.hooks
	if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return []
	const out: HookGrant[] = []
	for (const [event, entries] of Object.entries(hooks)) {
		if (!Array.isArray(entries)) continue
		// A list of groups (the common shape) is read through to the hooks inside.
		for (const entry of entries.flatMap(hooksOfElement)) {
			if (entry === null || typeof entry !== 'object') continue
			const spec = entry as Record<string, unknown>
			let runs: string | undefined
			if (spec.type === 'http') {
				if (typeof spec.url === 'string') runs = `POST ${plainAddress(spec.url)}`
			} else if (spec.type === 'prompt') {
				if (typeof spec.prompt === 'string') runs = `asks the model: ${spec.prompt}`
			} else if (typeof spec.command === 'string') {
				const args = Array.isArray(spec.args)
					? spec.args.filter((arg): arg is string => typeof arg === 'string')
					: []
				runs = [spec.command, ...args].join(' ')
				// What a command runs depends on the variables it is started with, so the
				// names an entry sets are shown beside it (never the values).
				if (spec.env !== null && typeof spec.env === 'object' && !Array.isArray(spec.env)) {
					const names = Object.keys(spec.env)
					if (names.length > 0) runs = `${runs} (sets ${names.join(', ')})`
				}
			}
			if (runs === undefined) continue
			const flat = runs.replace(/\s+/g, ' ').trim()
			out.push({
				event,
				runs: flat.length > MAX_HOOK_RUNS_CHARS ? `${flat.slice(0, MAX_HOOK_RUNS_CHARS)}…` : flat,
			})
		}
	}
	return out
}

function readObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/**
 * The hook entries the folder's own plugins ship, as the trust screen shows
 * them, each naming its plugin. Read as raw JSON like the config files: the
 * folder is not trusted yet, so nothing here is validated or merged, and an
 * unreadable file grants nothing (the real load reports it once trusted). A
 * plugin's entries run once the plugin is enabled, which `plugins.enabled`
 * (possibly set by the folder's own config) and the person's saved state decide.
 */
function describePluginHooks(cwd: string): HookGrant[] {
	const root = resolve(cwd, '.namzu', 'plugins')
	let names: string[]
	try {
		names = readdirSync(root).sort()
	} catch {
		return []
	}
	const out: HookGrant[] = []
	for (const name of names) {
		const folder = join(root, name)
		const manifest = readObject(join(folder, 'plugin.json'))
		if (!manifest) continue
		const label = typeof manifest.name === 'string' ? manifest.name : name
		const files = ['hooks/hooks.json']
		if (Array.isArray(manifest.hooks)) {
			for (const path of manifest.hooks) {
				if (typeof path === 'string' && path.toLowerCase().endsWith('.json')) files.push(path)
			}
		}
		const blocks: Record<string, unknown>[] = []
		for (const file of new Set(files)) {
			const path = resolve(folder, file)
			const inside = relative(folder, path)
			if (inside.startsWith('..') || isAbsolute(inside)) continue
			const value = readObject(path)
			if (value) blocks.push(value)
		}
		if (manifest.hookEntries !== null && typeof manifest.hookEntries === 'object') {
			blocks.push(manifest.hookEntries as Record<string, unknown>)
		}
		for (const block of blocks) {
			const events =
				block.hooks !== null && typeof block.hooks === 'object' && !Array.isArray(block.hooks)
					? (block.hooks as Record<string, unknown>)
					: block
			for (const grant of describeHooks({ hooks: events })) {
				out.push({ event: grant.event, runs: `${grant.runs} (plugin ${label})` })
			}
		}
	}
	return out
}

/**
 * The hooks the folder's own skills carry, each as what it would run. They
 * attach when a skill is used and not before, and the folder's skills are read
 * here as text only, never run; they are listed with the config's hooks because
 * they run commands by themselves once the folder is trusted.
 */
function describeSkillHooks(cwd: string): HookGrant[] {
	const out: HookGrant[] = []
	for (const skill of discoverSkills({ cwd })) {
		if (skill.source !== 'project' || skill.hooksSource === undefined) continue
		const read = withoutSessionStart(readSkillHooks(skill.hooksSource, `skill ${skill.name}`))
		const config: Record<string, unknown> = { hooks: read.hooks }
		for (const grant of describeHooks(config)) {
			out.push({ ...grant, event: `${grant.event} (skill ${skill.name})` })
		}
		if (read.guardLost) {
			out.push({
				event: `skill ${skill.name}`,
				runs: 'hooks that cannot be loaded; its tools are not pre-approved',
			})
		}
	}
	return out
}

/**
 * The hooks the folder's own agent files carry, each as what it would run.
 * They attach to each run of the agent once the folder is trusted, never
 * before. Read as text only, never run.
 */
function describeAgentHooks(cwd: string): HookGrant[] {
	const out: HookGrant[] = []
	const dir = join(cwd, '.namzu', 'agents')
	let files: string[]
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name)
			.sort()
	} catch {
		return out
	}
	for (const file of files) {
		const path = join(dir, file)
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch {
			continue
		}
		const found = parseAgentMarkdown(text, path, 'project')
		if ('reason' in found || found.hooksSource === undefined) continue
		const read = readAgentHooks(found.hooksSource, found.name)
		for (const grant of describeHooks({ hooks: read.hooks })) {
			out.push({ ...grant, event: `${grant.event} (agent ${found.name})` })
		}
		if (read.guardLost) {
			out.push({
				event: `agent ${found.name}`,
				runs: 'hooks that cannot be loaded; the agent is not offered',
			})
		}
	}
	return out
}

/** A marketplace source in a few words: the repository, address or path. */
function describeMarketplaceSource(source: unknown): string {
	if (source === null || typeof source !== 'object') return 'unknown'
	const s = source as Record<string, unknown>
	const where = s.repo ?? s.url ?? s.path
	return typeof where === 'string' ? `${String(s.source)} ${plainAddress(where)}` : String(s.source)
}

/**
 * What the folder's two settings files say about installed plugins: the ones
 * they turn on or off, each marked installed here or not, the marketplaces
 * they declare, and the hook commands an installed plugin they turn on would
 * run. A name in a repository's file turns nothing on by itself: a plugin that
 * is not installed on this computer shows as not installed.
 */
function describePluginRecords(
	cwd: string,
	home: string,
): { records: PluginRecordGrant[]; marketplaces: MarketplaceGrant[]; hooks: HookGrant[] } {
	const records: PluginRecordGrant[] = []
	const marketplaces: MarketplaceGrant[] = []
	const hooks: HookGrant[] = []
	const installed = readInstalledPlugins(home)
	const here = (id: string): boolean => {
		if (installed.state === 'unreadable') return false
		return (installed.plugins.get(id) ?? []).some(
			(record) =>
				record.scope === 'user' ||
				(record.projectPath !== undefined && samePath(record.projectPath, cwd)),
		)
	}
	const layers = [
		['project', resolve(cwd, '.namzu', 'settings.json')],
		['local', resolve(cwd, '.namzu', 'settings.local.json')],
	] as const
	for (const [layer, path] of layers) {
		const file = readObject(path)
		if (!file) continue
		const enabled = file.enabledPlugins
		if (enabled !== null && typeof enabled === 'object' && !Array.isArray(enabled)) {
			for (const [id, value] of Object.entries(enabled as Record<string, unknown>)) {
				if (!isPluginId(id) || typeof value !== 'boolean') continue
				const have = here(id)
				records.push({ id, layer, on: value, installed: have })
				if (!value || !have) continue
				const manifest = readInstallManifest(home, id)
				const surface = manifest.state === 'ok' ? manifest.manifest.surface.hooks : undefined
				if (!Array.isArray(surface)) continue
				for (const hook of surface) {
					if (hook === null || typeof hook !== 'object') continue
					const h = hook as Record<string, unknown>
					if (typeof h.command !== 'string') continue
					hooks.push({
						event: typeof h.event === 'string' ? h.event : 'hook',
						runs: `${h.command.replace(/\s+/g, ' ').slice(0, MAX_HOOK_RUNS_CHARS)} (plugin ${splitPluginId(id).name})`,
					})
				}
			}
		}
		const declared = file.extraKnownMarketplaces
		if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
			for (const [name, entry] of Object.entries(declared as Record<string, unknown>)) {
				const source =
					entry !== null && typeof entry === 'object'
						? (entry as { source?: unknown }).source
						: undefined
				marketplaces.push({ name, from: describeMarketplaceSource(source) })
			}
		}
	}
	return { records, marketplaces, hooks }
}

/** The allow rules and added directories the folder's own config carries. */
export function readFolderGrants(cwd: string, home: string = resolveNamzuHome()): FolderGrants {
	const allowRules: string[] = []
	const directories: string[] = []
	const hooks: HookGrant[] = []
	for (const file of folderConfigFiles(cwd)) {
		const config = readObject(file.path)
		if (!config) continue
		hooks.push(...describeHooks(config))
		const permissions = config.permissions
		if (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)) {
			for (const [tool, value] of Object.entries(permissions)) {
				if (value === 'allow') allowRules.push(tool)
				else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
					for (const [pattern, effect] of Object.entries(value)) {
						if (effect === 'allow') allowRules.push(`${tool}(${pattern})`)
					}
				}
			}
		}
		if (Array.isArray(config.additionalDirectories)) {
			for (const dir of config.additionalDirectories) {
				if (typeof dir === 'string' && dir.length > 0) directories.push(dir)
			}
		}
	}
	// Order: the config files, then plugins, then skills, then agent files.
	hooks.push(...describePluginHooks(cwd))
	let pluginRecords: PluginRecordGrant[] = []
	let marketplaces: MarketplaceGrant[] = []
	try {
		const described = describePluginRecords(cwd, home)
		pluginRecords = described.records
		marketplaces = described.marketplaces
		hooks.push(...described.hooks)
	} catch {
		// Plugin records that cannot be read are reported when the plugins load.
	}
	try {
		hooks.push(...describeSkillHooks(cwd))
	} catch {
		// Skills that cannot be read are reported when they are used.
	}
	try {
		hooks.push(...describeAgentHooks(cwd))
	} catch {
		// Agent files that cannot be read are reported when the agents are listed.
	}
	let toolServers: ToolServerGrant[] = []
	try {
		const declared = parseMcpServerFile(
			readFileSync(resolve(cwd, PROJECT_MCP_FILE), 'utf8'),
			PROJECT_MCP_FILE,
		)
		toolServers = Object.entries(declared).map(([name, entry]) => ({
			name,
			runs: describeRuns(entry),
			fingerprint: fingerprintMcpServer(entry),
		}))
	} catch {
		// Absent or unreadable: the real load reports it once the folder is trusted.
	}
	return {
		allowRules: [...new Set(allowRules)],
		directories: [...new Set(directories)],
		toolServers,
		hooks,
		...(pluginRecords.length > 0 ? { pluginRecords } : {}),
		...(marketplaces.length > 0 ? { marketplaces } : {}),
	}
}
