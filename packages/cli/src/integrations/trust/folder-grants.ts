/**
 * What a folder's own config pre-approves, read for the trust prompt.
 *
 * The gate asks before the folder's config is applied, so this reads the two
 * project files straight from disk and never validates or merges them: a file
 * that cannot be read or is not an object grants nothing here, and the real
 * load reports it once the folder is trusted. Only what the person needs to
 * weigh the choice is returned: the allow rules, the extra directories and
 * the names of the tool servers the shared file declares and the hooks the
 * two files declare.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parseAgentMarkdown } from '@namzu/sdk'

import { hooksOfElement } from '../../config/hook-common-shape.js'
import { readSkillHooks, withoutSessionStart } from '../../config/skill-hooks-reader.js'
import { discoverSkills } from '../../skills/store.js'
import { fingerprintMcpServer } from '../mcp/project-approval.js'
import { PROJECT_MCP_FILE, parseMcpServerFile } from '../mcp/shared-file.js'
import { readAgentHooks } from '../subagents/agent-hooks.js'

const FILES = ['namzu.config.json', 'namzu.config.local.json'] as const

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

export interface FolderGrants {
	/** Allow rules in the order written, `tool` or `tool(pattern)`, each once. */
	readonly allowRules: readonly string[]
	/** Extra directories the folder adds to the workspace, as written, each once. */
	readonly directories: readonly string[]
	/** Tool servers the folder's shared file declares; approving the folder approves these. */
	readonly toolServers: readonly ToolServerGrant[]
	/** Hooks the folder's own files declare, in file order; they run on events once the folder is trusted. */
	readonly hooks: readonly HookGrant[]
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

/** The allow rules and added directories the folder's own config carries. */
export function readFolderGrants(cwd: string): FolderGrants {
	const allowRules: string[] = []
	const directories: string[] = []
	const hooks: HookGrant[] = []
	for (const file of FILES) {
		const config = readObject(resolve(cwd, file))
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
	}
}
