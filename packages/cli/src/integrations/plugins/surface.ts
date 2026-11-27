/**
 * The consent surface of a plugin: everything in it that can run, configure
 * running or pre-approve a tool, listed so a person reads it before saying yes.
 *
 * Completeness is the point. A kind of runnable thing that is missing here is
 * a thing a person never saw: hooks (with their event and what they run),
 * hooks that skills, commands and agent files carry in their front matter,
 * local servers (command, arguments, environment), remote servers (the origin
 * they reach and the environment variables they would send), JavaScript
 * modules, tools a skill or command pre-approves, and every script (a file with
 * an execute bit, a program-like extension, or anything under `bin/`).
 *
 * Reading is static: no hook, server, module or script is started or imported.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
	type PluginManifest,
	type PluginRemoteMCPServerConfig,
	isHookEntriesPath,
} from '@namzu/sdk'

import { readSkillHooks } from '../../config/skill-hooks-reader.js'
import { parseSkillMarkdown } from '../../skills/store.js'
import { listMarkdownNames, resolvePluginFileDirs } from './files.js'
import { readPluginHookEntriesOf } from './hook-entries.js'
import { isConfigFile, sha256Hex } from './install-manifest.js'

export interface SurfaceHook {
	readonly event: string
	readonly matcher?: string
	readonly type: 'command' | 'http' | 'prompt'
	/** The command line, the address a request goes to, or the start of the prompt. */
	readonly run: string
	/** The file inside the plugin the entry came from. */
	readonly from?: string
}

export interface SurfaceFileHook {
	readonly kind: 'skill' | 'command' | 'agent'
	readonly name: string
	readonly event: string
	readonly type: 'command' | 'http' | 'prompt'
	readonly run: string
}

export interface SurfaceLocalServer {
	readonly name: string
	readonly command: string
	readonly args: readonly string[]
	readonly env: Readonly<Record<string, string>>
}

export interface SurfaceRemoteServer {
	readonly name: string
	readonly origin: string
	readonly url: string
	readonly transport: 'http' | 'sse'
	/** Environment variables a `${NAME}` in the address or a header value would send, sorted. */
	readonly sendsEnv: readonly string[]
	/** Header names it would send. */
	readonly headers: readonly string[]
}

export interface SurfaceAllowedTools {
	readonly kind: 'skill' | 'command'
	readonly name: string
	readonly tools: readonly string[]
}

export interface SurfaceScript {
	readonly path: string
	readonly bytes: number
	readonly exec: boolean
}

export interface PluginSurface {
	readonly hooks: readonly SurfaceHook[]
	readonly fileHooks: readonly SurfaceFileHook[]
	readonly mcpLocal: readonly SurfaceLocalServer[]
	readonly mcpRemote: readonly SurfaceRemoteServer[]
	/**
	 * JavaScript modules the manifest lists as hooks, which run inside the
	 * session when the plugin is on. SEAM: a later change fills each row with
	 * what the module declares (`surfaceEntry`); until then a row names the file
	 * and that it runs in-process.
	 */
	readonly modules: readonly { readonly path: string; readonly declares?: readonly string[] }[]
	readonly allowedTools: readonly SurfaceAllowedTools[]
	readonly scripts: readonly SurfaceScript[]
	readonly unpinnedDownload: boolean
}

const PROGRAM_EXTENSIONS = new Set([
	'.js',
	'.mjs',
	'.cjs',
	'.sh',
	'.ps1',
	'.bat',
	'.cmd',
	'.py',
	'.rb',
	'.pl',
])

/** Whether a file can run or configure running, by its path and mode. */
export function isExecutablePath(path: string, mode: number): boolean {
	if (isConfigFile(path)) return true
	if (path.startsWith('hooks/') || path.startsWith('bin/')) return true
	if ((mode & 0o111) !== 0) return true
	const dot = path.lastIndexOf('.')
	return dot >= 0 && PROGRAM_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

export interface PluginFiles {
	/** Paths with `/`, sorted. */
	readonly executable: readonly string[]
	/** sha256 (hex) of each executable file. */
	readonly files: Readonly<Record<string, string>>
	readonly scripts: readonly SurfaceScript[]
}

/** Every executable file under `root` with its hash. A link or a device is not followed and not listed. */
export function hashExecutableFiles(root: string): PluginFiles {
	const executable: string[] = []
	const files: Record<string, string> = {}
	const scripts: SurfaceScript[] = []
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full, rel)
			else if (entry.isFile()) {
				const stat = lstatSync(full)
				if (!isExecutablePath(rel, stat.mode)) continue
				executable.push(rel)
				files[rel] = sha256Hex(readFileSync(full))
				if (!isConfigFile(rel))
					scripts.push({ path: rel, bytes: stat.size, exec: (stat.mode & 0o111) !== 0 })
			}
		}
	}
	walk(root, '')
	executable.sort()
	scripts.sort((a, b) => a.path.localeCompare(b.path))
	return { executable, files, scripts }
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function envNamesIn(values: readonly string[]): string[] {
	const names = new Set<string>()
	for (const value of values)
		for (const match of value.matchAll(ENV_REF)) names.add(match[1] as string)
	return [...names].sort()
}

/** The path names a reader expands; a server read in the common layout carries the folders, so the surface turns them back. */
export interface Unexpander {
	readonly root: string
	readonly dataSentinel: string
	readonly projectSentinel: string
}

function unexpandWith(un: Unexpander | undefined): (text: string) => string {
	if (un === undefined) return (text) => text
	const pairs: [string, string][] = [
		[un.root, '${NAMZU_PLUGIN_ROOT}'],
		[un.dataSentinel, '${NAMZU_PLUGIN_DATA}'],
		[un.projectSentinel, '${NAMZU_PROJECT_DIR}'],
	]
	return (text) => {
		let out = text
		for (const [folder, name] of pairs) if (folder.length > 1) out = out.split(folder).join(name)
		return out
	}
}

function remoteRow(
	server: PluginRemoteMCPServerConfig,
	unexpand: (text: string) => string,
): SurfaceRemoteServer {
	const url = unexpand(server.url)
	let origin = url
	try {
		origin = new URL(server.url).origin
	} catch {
		// An address that is not a URL is shown as written.
	}
	const headers = server.headers ?? {}
	return {
		name: server.name,
		origin,
		url,
		transport: server.transport ?? 'http',
		sendsEnv: envNamesIn([server.url, ...Object.values(headers)]),
		headers: Object.keys(headers).sort(),
	}
}

const TOOL_TOKEN = /[^\s(]+(?:\([^)]*\))?/g

/** `allowed-tools` as written, split into one entry per tool. */
export function splitAllowedTools(written: string): string[] {
	return written.match(TOOL_TOKEN) ?? []
}

function inside(root: string, rel: string): string | undefined {
	if (rel.split(/[\\/]/).includes('..') || /^([A-Za-z]:|[\\/])/.test(rel)) return undefined
	return join(root, rel)
}

function readText(path: string): string | undefined {
	try {
		const stat = lstatSync(path)
		if (!stat.isFile() || stat.size > 1024 * 1024) return undefined
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

function hookRows(
	hooks: ReturnType<typeof readSkillHooks>['hooks'],
): { event: string; matcher?: string; type: 'command' | 'http' | 'prompt'; run: string }[] {
	const rows: {
		event: string
		matcher?: string
		type: 'command' | 'http' | 'prompt'
		run: string
	}[] = []
	for (const [event, entries] of Object.entries(hooks)) {
		for (const entry of (entries ?? []) as unknown as readonly Record<string, unknown>[]) {
			rows.push(entryRow(event, entry))
		}
	}
	return rows
}

function entryRow(
	event: string,
	entry: Record<string, unknown>,
): { event: string; matcher?: string; type: 'command' | 'http' | 'prompt'; run: string } {
	const matcher =
		typeof entry.matcher === 'string' && entry.matcher !== '' ? entry.matcher : undefined
	const base = matcher !== undefined ? { event, matcher } : { event }
	if (entry.type === 'http') return { ...base, type: 'http', run: String(entry.url ?? '') }
	if (entry.type === 'prompt')
		return {
			...base,
			type: 'prompt',
			run: String(entry.prompt ?? '')
				.replace(/\s+/g, ' ')
				.slice(0, 200),
		}
	const args = Array.isArray(entry.args) ? entry.args.map(String) : []
	return { ...base, type: 'command', run: [String(entry.command ?? ''), ...args].join(' ') }
}

export interface SurfaceInput {
	readonly root: string
	readonly manifest: PluginManifest
	readonly remoteServers: readonly PluginRemoteMCPServerConfig[]
	readonly scripts: readonly SurfaceScript[]
	readonly unexpander?: Unexpander
}

export interface SurfaceRead {
	readonly surface: PluginSurface
	/** Things in the files that were refused or not read, in words, for the report. */
	readonly problems: readonly {
		readonly code: string
		readonly file: string
		readonly message: string
	}[]
}

/** The surface of the plugin folder at `input.root`, read without running anything. */
export function readSurface(input: SurfaceInput): SurfaceRead {
	const { root, manifest } = input
	const unexpand = unexpandWith(input.unexpander)
	const problems: { code: string; file: string; message: string }[] = []

	const read = readPluginHookEntriesOf({ rootDir: root, manifest })
	for (const problem of read.problems)
		problems.push({ code: problem.code, file: problem.file, message: problem.message })
	const hooks: SurfaceHook[] = hookRows(read.hooks).map((row) => ({ ...row }))

	const modules = (manifest.hooks ?? [])
		.filter((path) => !isHookEntriesPath(path))
		.map((path) => ({ path }))

	const mcpLocal: SurfaceLocalServer[] = (manifest.mcpServers ?? []).map((server) => ({
		name: server.name,
		command: unexpand(server.command),
		args: (server.args ?? []).map(unexpand),
		env: Object.fromEntries(
			Object.entries(server.env ?? {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => [key, unexpand(value)]),
		),
	}))
	const mcpRemote = input.remoteServers.map((server) => remoteRow(server, unexpand))

	const fileHooks: SurfaceFileHook[] = []
	const allowedTools: SurfaceAllowedTools[] = []
	const considerFile = (
		kind: 'skill' | 'command' | 'agent',
		fallbackName: string,
		path: string,
	): void => {
		const raw = readText(path)
		if (raw === undefined) return
		let parsed: ReturnType<typeof parseSkillMarkdown>
		try {
			parsed = parseSkillMarkdown(raw, path)
		} catch (error) {
			problems.push({
				code: `${kind}-front-matter`,
				file: path.slice(root.length + 1).replace(/\\/g, '/'),
				message: `The front matter could not be read (${error instanceof Error ? error.message : String(error)}), so what it declares is not listed.`,
			})
			return
		}
		const name = parsed.name ?? fallbackName
		if (kind !== 'agent' && parsed.allowedTools !== undefined) {
			const tools = splitAllowedTools(parsed.allowedTools)
			if (tools.length > 0) allowedTools.push({ kind, name, tools })
		}
		if (parsed.hooksSource !== undefined) {
			const hookRead = readSkillHooks(parsed.hooksSource, `${kind} ${name}`)
			for (const row of hookRows(hookRead.hooks))
				fileHooks.push({ kind, name, event: row.event, type: row.type, run: row.run })
			for (const problem of hookRead.problems)
				problems.push({
					code: `${kind}-hooks-${problem.severity}`,
					file: path.slice(root.length + 1).replace(/\\/g, '/'),
					message: `${problem.event} ${problem.message}`,
				})
		}
	}
	for (const dir of manifest.skills ?? []) {
		const folder = inside(root, dir)
		if (folder !== undefined)
			considerFile('skill', dir.split(/[\\/]/).pop() ?? dir, join(folder, 'SKILL.md'))
	}
	for (const [kind, declared] of [
		['command', manifest.commands],
		['agent', manifest.agents],
	] as const) {
		for (const source of resolvePluginFileDirs(manifest.name, root, declared, manifest.layout).dirs)
			for (const file of listMarkdownNames(source.dir, source.only))
				considerFile(kind, file, join(source.dir, `${file}.md`))
	}

	const byName = <T extends { kind?: string; name?: string; event?: string }>(a: T, b: T): number =>
		`${a.kind ?? ''}\t${a.name ?? ''}\t${a.event ?? ''}`.localeCompare(
			`${b.kind ?? ''}\t${b.name ?? ''}\t${b.event ?? ''}`,
		)
	return {
		surface: {
			hooks,
			fileHooks: fileHooks.sort(byName),
			mcpLocal: mcpLocal.sort((a, b) => a.name.localeCompare(b.name)),
			mcpRemote: mcpRemote.sort((a, b) => a.name.localeCompare(b.name)),
			modules: modules.sort((a, b) => a.path.localeCompare(b.path)),
			allowedTools: allowedTools.sort(byName),
			scripts: input.scripts,
			unpinnedDownload: false,
		},
		problems,
	}
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

/** What changed between two surfaces, in words, for an update's preview. */
export function surfaceChanges(before: PluginSurface, after: PluginSurface): string[] {
	const out: string[] = []
	const label: Record<string, string> = {
		hooks: 'hook',
		fileHooks: 'hook in a skill, command or agent file',
		mcpLocal: 'local server',
		mcpRemote: 'remote server',
		modules: 'module',
		allowedTools: 'pre-approved tools',
		scripts: 'script',
	}
	for (const key of Object.keys(label) as (keyof PluginSurface & string)[]) {
		const a = (before[key] as readonly unknown[]).map((item) => JSON.stringify(item))
		const b = (after[key] as readonly unknown[]).map((item) => JSON.stringify(item))
		const added = b.filter((item) => !a.includes(item)).length
		const removed = a.filter((item) => !b.includes(item)).length
		if (added > 0) out.push(`${added} new ${label[key]}${added === 1 ? '' : 's'}`)
		if (removed > 0)
			out.push(`${removed} ${label[key]}${removed === 1 ? '' : 's'} removed or changed`)
	}
	if (!same(before.unpinnedDownload, after.unpinnedDownload)) out.push('download pinning changed')
	return out
}
