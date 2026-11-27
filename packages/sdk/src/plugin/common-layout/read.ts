import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AGENT_FILE_KEYS } from '../../agents/file-definitions.js'
import {
	COMMON_LAYOUT_MAX_AGENTS,
	COMMON_LAYOUT_MAX_BYTES,
	COMMON_LAYOUT_MAX_COMMANDS,
	COMMON_LAYOUT_MAX_FILES,
	COMMON_LAYOUT_MAX_MCP_SERVERS,
	COMMON_LAYOUT_MAX_SKILLS,
	PLUGIN_MANIFEST_FILENAME,
	PLUGIN_NAME_MAX_LENGTH,
	PLUGIN_NAME_PATTERN,
} from '../../constants/plugin/index.js'
import { parseSkillMarkdown } from '../../skills/loader.js'
import {
	CommonLayoutManifestSchema,
	type PluginManifest,
	RENAMED_PLUGIN_HOOK_EVENTS,
} from '../../types/plugin/index.js'
import {
	COMMON_AGENTS_DIR,
	COMMON_COMMANDS_DIR,
	COMMON_HOOKS_FILE,
	COMMON_MANIFEST_DIR,
	COMMON_MANIFEST_FILE,
	COMMON_MCP_FILE,
	COMMON_ROOT_SKILL_FILE,
	COMMON_SKILLS_DIR,
	COMMON_UNUSED_DIRS,
	ENTRY_SIDECAR_FILE,
} from '../common-layout-names.js'
import { summarizeHookModule } from '../hook-module/consent.js'
import { locateHookModule, scanHookModule } from '../hook-module/scan.js'
import { SHELL_HOOK_EVENTS, SHELL_HOOK_PASCAL_EVENT_NAMES } from '../shell-hook.js'
import { type McpSource, readMcpSources, serversOf } from './mcp.js'
import type {
	CommonLayoutOptions,
	CommonLayoutRead,
	CommonLayoutSource,
	LayoutFinding,
} from './types.js'

/** A manifest, sidecar or hooks file larger than this is refused unread. */
export const MAX_LAYOUT_MANIFEST_BYTES = 256 * 1024

/** Fields that name a component Namzu has no place for. */
const NOT_USED_FIELDS: readonly string[] = [
	'outputStyles',
	'themes',
	'workflows',
	'monitors',
	'channels',
	'lspServers',
	'binaries',
	'settings',
	'types',
	'network',
	'experimental',
]

/** Fields the sidecar may carry; anything else in it is dropped. */
const SIDECAR_FIELDS: readonly string[] = [
	'name',
	'description',
	'version',
	'author',
	'strict',
	'skills',
	'commands',
	'agents',
	'hooks',
	'mcpServers',
	'platforms',
	'engines',
]

const COMPONENT_FIELDS: readonly string[] = ['skills', 'commands', 'agents', 'hooks', 'mcpServers']

const KNOWN_MANIFEST_KEYS = new Set([
	'$schema',
	'name',
	'displayName',
	'version',
	'description',
	'author',
	'homepage',
	'repository',
	'license',
	'keywords',
	'metadata',
	'icon',
	'defaultEnabled',
	'engines',
	'platforms',
	'dependencies',
	'optionalDependencies',
	'skills',
	'commands',
	'agents',
	'hooks',
	'mcpServers',
	'userConfig',
	'connectors',
	'personas',
	...NOT_USED_FIELDS,
])

function isMapping(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function kebab(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, PLUGIN_NAME_MAX_LENGTH)
		.replace(/-+$/g, '')
}

/** The folder name of a path, written plugin-style. */
function nameFromFolder(root: string): string {
	return kebab(basename(root))
}

type Kind = 'file' | 'dir' | 'link' | 'other' | 'missing'

async function kindOf(path: string): Promise<Kind> {
	try {
		const info = await lstat(path)
		if (info.isSymbolicLink()) return 'link'
		if (info.isFile()) return 'file'
		if (info.isDirectory()) return 'dir'
		return 'other'
	} catch {
		return 'missing'
	}
}

/** Why a path a manifest names is not allowed, or undefined when it is. */
function relativeProblem(rel: string): string | undefined {
	if (rel.length === 0) return 'is empty'
	if (/^([A-Za-z]:|[\\/])/.test(rel)) return 'is an absolute path'
	if (rel.includes('\0')) return 'holds a NUL character'
	if (rel.split(/[\\/]/).some((part) => part === '..')) return 'leaves the plugin folder with ".."'
	return undefined
}

function trimDot(rel: string): string {
	let out = rel.replace(/\\/g, '/')
	while (out.startsWith('./')) out = out.slice(2)
	out = out.replace(/\/+$/, '')
	return out === '' ? '.' : out
}

/**
 * Walk the path one component at a time, never following a link. `link` means a
 * component on the way (or the end) is a symbolic link.
 */
async function walk(root: string, rel: string): Promise<Kind> {
	if (rel === '.') return kindOf(root)
	let current = root
	let last: Kind = 'dir'
	for (const part of rel.split('/')) {
		if (part === '' || part === '.') continue
		current = join(current, part)
		last = await kindOf(current)
		if (last === 'link' || last === 'missing') return last
	}
	return last
}

async function readCapped(path: string): Promise<{ text: string } | { problem: string }> {
	try {
		const info = await lstat(path)
		if (info.size > MAX_LAYOUT_MANIFEST_BYTES) {
			return {
				problem: `is larger than ${MAX_LAYOUT_MANIFEST_BYTES / 1024} KiB`,
			}
		}
		return { text: await readFile(path, 'utf-8') }
	} catch (error) {
		return {
			problem: `cannot be read (${error instanceof Error ? error.message : String(error)})`,
		}
	}
}

function toList(value: unknown): unknown[] {
	if (value === undefined || value === null) return []
	return Array.isArray(value) ? value : [value]
}

function countOf(value: unknown): number {
	if (Array.isArray(value)) return value.length
	if (isMapping(value)) return Object.keys(value).length
	return value === undefined || value === null ? 0 : 1
}

function topKeys(raw: string): string[] {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
	if (!match) return []
	const keys: string[] = []
	for (const line of (match[1] as string).split(/\r?\n/)) {
		const key = /^([A-Za-z][\w-]*)\s*:/.exec(line)
		if (key) keys.push(key[1] as string)
	}
	return keys
}

class Collector {
	readonly findings: LayoutFinding[] = []
	add(finding: LayoutFinding): void {
		this.findings.push(finding)
	}
	refusal: LayoutFinding | undefined
	refuseAll(code: string, field: string, message: string): void {
		const finding: LayoutFinding = { level: 'refused', code, field, message }
		this.refusal ??= finding
		this.findings.push(finding)
	}
}

/**
 * What the hooks module a plugin names in its hooks file comes to: a finding
 * for what runs, for what Namzu has no place for, and for what refuses the
 * module (its plain hook entries still load either way).
 */
function noteHookModule(root: string, out: Collector): void {
	const located = locateHookModule(root)
	if (located.kind === 'none') return
	if (located.kind === 'refused') {
		out.add({
			level: 'refused',
			code: 'hooks-modules-refused',
			field: 'hooks',
			path: located.hooksFile,
			message: `${located.message} Its plain hook entries still load.`,
		})
		return
	}
	const scan = scanHookModule(root, located.entry)
	for (const refusal of scan.refusals) {
		out.add({
			level: 'refused',
			code: 'hooks-module-scan-refused',
			field: 'hooks',
			path: refusal.file,
			message: `${refusal.file}:${refusal.line}: ${refusal.message}. The module does not run; its plain hook entries still load.`,
		})
	}
	if (scan.refusals.length > 0) return
	const summary = summarizeHookModule(scan)
	for (const line of summary.notUsed) {
		out.add({
			level: 'notUsed',
			code: 'hooks-module-not-used',
			field: 'hooks',
			path: located.entry,
			message: line,
		})
	}
	if (summary.events.length === 0) {
		out.add({
			level: 'notUsed',
			code: 'hooks-module-not-loaded',
			field: 'hooks',
			path: located.entry,
			message: `${located.entry} is not loaded: it registers nothing Namzu runs.`,
		})
		return
	}
	out.add({
		level: 'used',
		code: 'hooks-module-used',
		field: 'hooks',
		path: located.entry,
		message: `${located.entry} runs in an isolated worker (events: ${summary.events.join(', ') || 'none'}).`,
	})
}

/**
 * Read a plugin folder written in the common plugin layout.
 *
 * Pure: it reads inside the folder, never follows a symbolic link, runs and
 * imports nothing (a hooks module is parsed, not run), and opens no connection. It returns the manifest Namzu
 * would admit, the remote servers it found, and a finding for everything it
 * used, left out or refused (see {@link LayoutFinding}).
 *
 * Which file speaks, in order: a `plugin.json` at the root (Namzu's own; this
 * reader says only that it was there), the common layout's manifest, the
 * install sidecar (only when `options.entrySidecar` is set), a root `SKILL.md`
 * (a one-skill plugin), or the conventional folders alone.
 */
export async function readCommonLayout(
	root: string,
	options: CommonLayoutOptions = {},
): Promise<CommonLayoutRead> {
	const out = new Collector()
	const finish = (
		source: CommonLayoutSource,
		manifest?: PluginManifest,
		remote: CommonLayoutRead['remoteServers'] = [],
	): CommonLayoutRead => ({
		source,
		...(manifest !== undefined ? { manifest } : {}),
		remoteServers: remote,
		findings: out.findings,
		...(out.refusal !== undefined ? { refusal: out.refusal } : {}),
	})

	if ((await kindOf(root)) !== 'dir') {
		out.refuseAll('root-not-directory', 'root', `Plugin root must be a regular directory: ${root}`)
		return finish('none')
	}

	// The reader owns the plugin-level size caps: it stops counting at the cap.
	const size = await measureFolder(root)
	if (size !== undefined) {
		out.refuseAll('too-large', 'root', size)
		return finish('none')
	}

	const commonDir = await kindOf(join(root, COMMON_MANIFEST_DIR))
	const commonFile =
		commonDir === 'dir'
			? await kindOf(join(root, COMMON_MANIFEST_DIR, COMMON_MANIFEST_FILE))
			: commonDir
	if ((await kindOf(join(root, PLUGIN_MANIFEST_FILENAME))) === 'file') {
		if (commonFile === 'file') {
			out.add({
				level: 'ignored',
				code: 'manifest-both',
				field: 'manifest',
				message: `Both ${PLUGIN_MANIFEST_FILENAME} and ${COMMON_MANIFEST_DIR}/${COMMON_MANIFEST_FILE} are here; ${PLUGIN_MANIFEST_FILENAME} is used and the other is ignored.`,
			})
		}
		return finish('namzu')
	}
	if (commonDir === 'link' || commonFile === 'link') {
		out.refuseAll(
			'path-escapes',
			'manifest',
			`${COMMON_MANIFEST_DIR} is a link, so it is not read.`,
		)
		return finish('none')
	}

	// The manifest, then the sidecar, each read whole and refused over the size cap.
	let base: Record<string, unknown> | undefined
	if (commonFile === 'file') {
		const read = await readCapped(join(root, COMMON_MANIFEST_DIR, COMMON_MANIFEST_FILE))
		if ('problem' in read) {
			out.refuseAll('manifest-invalid', 'manifest', `The manifest ${read.problem}.`)
			return finish('none')
		}
		try {
			const parsed: unknown = JSON.parse(read.text)
			if (!isMapping(parsed)) throw new Error('it is not an object')
			base = parsed
		} catch (error) {
			out.refuseAll(
				'manifest-invalid',
				'manifest',
				`The manifest is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
			)
			return finish('none')
		}
	}

	let sidecar: Record<string, unknown> | undefined
	if (options.entrySidecar === true) {
		const kind = await kindOf(join(root, ENTRY_SIDECAR_FILE))
		if (kind === 'link') {
			out.add({
				level: 'ignored',
				code: 'symlink',
				field: ENTRY_SIDECAR_FILE,
				message: `${ENTRY_SIDECAR_FILE} is a link and is not read.`,
				path: ENTRY_SIDECAR_FILE,
			})
		} else if (kind === 'file') {
			const read = await readCapped(join(root, ENTRY_SIDECAR_FILE))
			if ('problem' in read) {
				out.refuseAll(
					'manifest-invalid',
					ENTRY_SIDECAR_FILE,
					`${ENTRY_SIDECAR_FILE} ${read.problem}.`,
				)
				return finish('none')
			}
			try {
				const parsed: unknown = JSON.parse(read.text)
				if (!isMapping(parsed)) throw new Error('it is not an object')
				sidecar = parsed
			} catch (error) {
				out.refuseAll(
					'manifest-invalid',
					ENTRY_SIDECAR_FILE,
					`${ENTRY_SIDECAR_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
				)
				return finish('none')
			}
		}
	}

	const rootSkill = await kindOf(join(root, COMMON_ROOT_SKILL_FILE))
	const conventional = await Promise.all(
		[COMMON_SKILLS_DIR, COMMON_COMMANDS_DIR, COMMON_AGENTS_DIR, 'hooks'].map((dir) =>
			kindOf(join(root, dir)),
		),
	)
	const hasConventional =
		conventional.includes('dir') ||
		rootSkill === 'file' ||
		(await kindOf(join(root, COMMON_MCP_FILE))) === 'file'

	let source: CommonLayoutSource
	if (base !== undefined) source = 'manifest'
	else if (sidecar !== undefined) source = 'sidecar'
	else if (rootSkill === 'file' && !conventional.includes('dir')) source = 'single-skill'
	else if (hasConventional) {
		if (
			(await kindOf(join(root, COMMON_HOOKS_FILE))) !== 'missing' ||
			(await kindOf(join(root, COMMON_MCP_FILE))) !== 'missing'
		) {
			out.refuseAll(
				'manifest-required',
				'manifest',
				`Hooks and servers run code, so a plugin that ships them needs a ${COMMON_MANIFEST_DIR}/${COMMON_MANIFEST_FILE}. Add one, or remove ${COMMON_HOOKS_FILE} and ${COMMON_MCP_FILE}.`,
			)
			return finish('conventional')
		}
		source = 'conventional'
	} else {
		out.refuseAll(
			'not-a-plugin',
			'root',
			`There is nothing here Namzu reads: no ${COMMON_MANIFEST_DIR}/${COMMON_MANIFEST_FILE}, no ${COMMON_SKILLS_DIR}/, ${COMMON_COMMANDS_DIR}/ or ${COMMON_AGENTS_DIR}/.`,
		)
		return finish('none')
	}

	// The merged view: the manifest, with the sidecar's allow-listed fields over it when the
	// entry says `strict: false`, and only its identity fields filling gaps otherwise.
	const merged: Record<string, unknown> = { ...(base ?? {}) }
	if (sidecar !== undefined) {
		const entry: Record<string, unknown> = {}
		for (const key of SIDECAR_FIELDS) if (sidecar[key] !== undefined) entry[key] = sidecar[key]
		const inlineAllowed = entry.strict === false
		for (const [key, value] of Object.entries(entry)) {
			if (key === 'strict') continue
			const component = COMPONENT_FIELDS.includes(key) || key === 'platforms' || key === 'engines'
			if (component && !inlineAllowed) {
				if (COMPONENT_FIELDS.includes(key)) {
					out.add({
						level: 'ignored',
						code: 'entry-inline-ignored',
						field: key,
						message: `The marketplace entry lists "${key}", and the plugin's own manifest decides that (the entry does not say strict: false), so it is ignored.`,
					})
				}
				continue
			}
			if (inlineAllowed || merged[key] === undefined) merged[key] = value
		}
	}

	return readMerged(root, merged, source, options, out, finish)
}

type Finish = (
	source: CommonLayoutSource,
	manifest?: PluginManifest,
	remote?: CommonLayoutRead['remoteServers'],
) => CommonLayoutRead

async function readMerged(
	root: string,
	m: Record<string, unknown>,
	source: CommonLayoutSource,
	options: CommonLayoutOptions,
	out: Collector,
	finish: Finish,
): Promise<CommonLayoutRead> {
	// --- identity ---------------------------------------------------------
	const name = typeof m.name === 'string' ? m.name : nameFromFolder(root)
	if (
		name.length === 0 ||
		name.length > PLUGIN_NAME_MAX_LENGTH ||
		!PLUGIN_NAME_PATTERN.test(name)
	) {
		out.refuseAll('name-invalid', 'name', 'name must be lowercase words joined by dashes.')
		return finish(source)
	}
	for (const key of Object.keys(m)) {
		if (!KNOWN_MANIFEST_KEYS.has(key) && !SIDECAR_FIELDS.includes(key)) {
			out.add({
				level: 'ignored',
				code: 'manifest-unknown-key',
				field: key,
				message: `"${key}" is not read.`,
			})
		}
	}
	for (const key of [
		'displayName',
		'homepage',
		'repository',
		'license',
		'keywords',
		'metadata',
		'$schema',
		'icon',
		'defaultEnabled',
		'connectors',
		'personas',
		'optionalDependencies',
	]) {
		if (m[key] !== undefined) {
			out.add({
				level: 'ignored',
				code: 'manifest-metadata',
				field: key,
				message:
					key === 'defaultEnabled'
						? 'defaultEnabled is ignored: Namzu turns a plugin on only after a recorded yes.'
						: `${key} is kept for display at most and never runs.`,
			})
		}
	}

	let author: string | undefined
	if (typeof m.author === 'string') author = m.author
	else if (isMapping(m.author) && typeof m.author.name === 'string') {
		author =
			typeof m.author.email === 'string' ? `${m.author.name} <${m.author.email}>` : m.author.name
	}

	// --- dependencies -----------------------------------------------------
	if (m.dependencies !== undefined) {
		const ids = toList(m.dependencies).flatMap((entry) =>
			typeof entry === 'string'
				? [entry]
				: isMapping(entry) && typeof entry.name === 'string'
					? [entry.name]
					: [],
		)
		const installed = options.installedIds ?? new Set<string>()
		const missing = ids.find(
			(id) => !installed.has(id) && ![...installed].some((have) => have.split('@')[0] === id),
		)
		if (missing !== undefined) {
			out.refuseAll(
				'dependency-unmet',
				'dependencies',
				`It needs ${missing}, which is not installed. Add it first (the /plugin screen, or --plugin-dir), then add this plugin.`,
			)
			return finish(source)
		}
	}

	// --- skills -----------------------------------------------------------
	const skillPaths: string[] = []
	const skillSeen = new Set<string>()
	const checkSkill = async (rel: string, field: string): Promise<boolean> => {
		const where = rel === '.' ? COMMON_ROOT_SKILL_FILE : `${rel}/${COMMON_ROOT_SKILL_FILE}`
		const file = await walk(root, where)
		if (file === 'link') {
			out.add({
				level: 'ignored',
				code: 'symlink',
				field,
				path: where,
				message: `${where} is a link and is not followed.`,
			})
			return false
		}
		if (file !== 'file') {
			out.add({
				level: 'ignored',
				code: 'skill-no-file',
				field,
				path: rel,
				message: `${rel} has no ${COMMON_ROOT_SKILL_FILE}, so it is not a skill.`,
			})
			return false
		}
		const read = await readCapped(join(root, where))
		try {
			if ('problem' in read) throw new Error(`${where} ${read.problem}`)
			parseSkillMarkdown(read.text, rel === '.' ? root : join(root, rel), {
				anyFolderName: rel === '.',
			})
		} catch (error) {
			out.add({
				level: 'refused',
				code: 'skill-invalid',
				field,
				path: where,
				message: `${where}: ${(error instanceof Error ? error.message : String(error)).split(root).join('.')}`,
			})
			return false
		}
		return true
	}
	const addSkill = async (rel: string, field: string): Promise<void> => {
		if (skillSeen.has(rel)) return
		skillSeen.add(rel)
		if (await checkSkill(rel, field)) skillPaths.push(rel)
	}
	if (m.skills !== undefined) {
		for (const entry of toList(m.skills)) {
			if (typeof entry !== 'string') {
				out.refuseAll('manifest-invalid', 'skills', 'skills must be a list of folder paths.')
				return finish(source)
			}
			const problem = relativeProblem(entry)
			const rel = trimDot(entry)
			if (problem !== undefined || (await walk(root, rel)) === 'link') {
				out.refuseAll(
					'path-escapes',
					'skills',
					`skills: "${entry}" ${problem ?? 'goes through a link'}, so the plugin is not loaded.`,
				)
				return finish(source)
			}
			await addSkill(rel, 'skills')
		}
	}
	if (
		source === 'single-skill' ||
		(source === 'conventional' && (await kindOf(join(root, COMMON_ROOT_SKILL_FILE))) === 'file')
	) {
		await addSkill('.', 'skills')
	}
	const skillsDir = await walk(root, COMMON_SKILLS_DIR)
	if (skillsDir === 'link') {
		out.add({
			level: 'ignored',
			code: 'symlink',
			field: 'skills',
			path: COMMON_SKILLS_DIR,
			message: `${COMMON_SKILLS_DIR} is a link and is not followed.`,
		})
	} else if (skillsDir === 'dir') {
		let entries: Dirent[] = []
		try {
			entries = (await readdir(join(root, COMMON_SKILLS_DIR), { withFileTypes: true })).sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			)
		} catch (error) {
			out.add({
				level: 'ignored',
				code: 'skills-unreadable',
				field: 'skills',
				path: COMMON_SKILLS_DIR,
				message: `${COMMON_SKILLS_DIR}/ could not be read (${error instanceof Error ? error.message : String(error)}), so its skills are not loaded.`,
			})
		}
		for (const entry of entries) {
			if (skillPaths.length > COMMON_LAYOUT_MAX_SKILLS) break
			if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__MACOSX')
				continue
			const rel = `${COMMON_SKILLS_DIR}/${entry.name}`
			if (entry.isSymbolicLink()) {
				out.add({
					level: 'ignored',
					code: 'symlink',
					field: 'skills',
					path: rel,
					message: `${rel} is a link and is not followed.`,
				})
				continue
			}
			if (!entry.isDirectory()) continue
			await addSkill(rel, 'skills')
		}
	}
	if (skillPaths.length > COMMON_LAYOUT_MAX_SKILLS) {
		out.refuseAll(
			'too-many-skills',
			'skills',
			`The plugin has ${skillPaths.length} skills; Namzu reads at most ${COMMON_LAYOUT_MAX_SKILLS} from one plugin.`,
		)
		return finish(source)
	}
	if (skillPaths.length > 0) {
		out.add({
			level: 'used',
			code: 'skills-used',
			field: 'skills',
			message: `${skillPaths.length} skill${skillPaths.length === 1 ? '' : 's'}.`,
		})
	}

	// --- commands and agents ---------------------------------------------
	const filePaths = async (
		field: 'commands' | 'agents',
		dir: string,
		cap: number,
	): Promise<string[] | undefined> => {
		const paths: string[] = []
		const declared = m[field]
		if (declared !== undefined) {
			const entries: unknown[] = isMapping(declared)
				? Object.entries(declared).map(([key, value]) => {
						if (isMapping(value) && typeof value.content === 'string') {
							out.add({
								level: 'refused',
								code: 'inline-text-unsupported',
								field: `${field}.${key}`,
								message: `${field}.${key}: inline text is not supported`,
							})
							return undefined
						}
						return isMapping(value) && typeof value.source === 'string' ? value.source : value
					})
				: toList(declared)
			for (const entry of entries) {
				if (entry === undefined) continue
				if (typeof entry !== 'string') {
					out.refuseAll('manifest-invalid', field, `${field} must be paths.`)
					return undefined
				}
				const problem = relativeProblem(entry)
				const rel = trimDot(entry)
				const kind = problem === undefined ? await walk(root, rel) : 'missing'
				if (problem !== undefined || kind === 'link') {
					out.refuseAll(
						'path-escapes',
						field,
						`${field}: "${entry}" ${problem ?? 'goes through a link'}, so the plugin is not loaded.`,
					)
					return undefined
				}
				if (kind === 'missing') {
					out.add({
						level: 'refused',
						code: 'path-missing',
						field,
						path: rel,
						message: `${field}: "${entry}" was not found.`,
					})
					continue
				}
				if (kind === 'file' && !rel.toLowerCase().endsWith('.md')) {
					out.add({
						level: 'ignored',
						code: 'file-not-markdown',
						field,
						path: rel,
						message: `${field}: "${entry}" is not a .md file.`,
					})
					continue
				}
				paths.push(rel)
			}
			if ((await walk(root, dir)) === 'dir') {
				out.add({
					level: 'notUsed',
					code: 'folder-shadowed-by-manifest',
					field,
					message: `${dir}/ is not read on its own because the manifest lists ${field}. Add its files to the ${field} list if you want both.`,
				})
			}
		} else {
			const kind = await walk(root, dir)
			if (kind === 'link') {
				out.add({
					level: 'ignored',
					code: 'symlink',
					field,
					path: dir,
					message: `${dir} is a link and is not followed.`,
				})
			} else if (kind === 'dir') paths.push(dir)
		}
		if (paths.length > cap) {
			out.refuseAll(
				`too-many-${field}`,
				field,
				`The plugin lists ${paths.length} ${field}; Namzu reads at most ${cap}.`,
			)
			return undefined
		}
		return paths
	}
	const commands = await filePaths('commands', COMMON_COMMANDS_DIR, COMMON_LAYOUT_MAX_COMMANDS)
	if (out.refusal) return finish(source)
	const agents = await filePaths('agents', COMMON_AGENTS_DIR, COMMON_LAYOUT_MAX_AGENTS)
	if (out.refusal) return finish(source)
	for (const rel of agents ?? []) await noteAgentKeys(root, rel, out)
	if ((commands?.length ?? 0) > 0) {
		out.add({
			level: 'used',
			code: 'commands-used',
			field: 'commands',
			message: `${commands?.length} command source(s).`,
		})
	}
	if ((agents?.length ?? 0) > 0) {
		out.add({
			level: 'used',
			code: 'agents-used',
			field: 'agents',
			message: `${agents?.length} agent source(s).`,
		})
	}

	// --- hooks ------------------------------------------------------------
	const hookFiles: string[] = []
	const hookEntries: Record<string, unknown[]> = {}
	let inlineHooks = false
	for (const entry of toList(m.hooks)) {
		if (typeof entry === 'string') {
			const problem = relativeProblem(entry)
			const rel = trimDot(entry)
			if (problem !== undefined || (await walk(root, rel)) === 'link') {
				out.refuseAll(
					'path-escapes',
					'hooks',
					`hooks: "${entry}" ${problem ?? 'goes through a link'}, so the plugin is not loaded.`,
				)
				return finish(source)
			}
			if (!rel.toLowerCase().endsWith('.json')) {
				out.add({
					level: 'refused',
					code: 'hooks-module-refused',
					field: 'hooks',
					path: rel,
					message: `hooks: "${entry}" is program code, not a file of hook entries. Namzu does not run plugin code at startup, so it is skipped.`,
				})
				continue
			}
			hookFiles.push(rel)
		} else if (isMapping(entry)) {
			const events = isMapping(entry.hooks) ? entry.hooks : entry
			for (const [event, list] of Object.entries(events)) {
				inlineHooks = true
				hookEntries[event] = [...(hookEntries[event] ?? []), ...toList(list)]
			}
		}
	}
	const conventionalHooks = await walk(root, COMMON_HOOKS_FILE)
	if (conventionalHooks === 'file' && !hookFiles.includes(COMMON_HOOKS_FILE)) {
		hookFiles.push(COMMON_HOOKS_FILE)
	} else if (conventionalHooks === 'link') {
		out.add({
			level: 'ignored',
			code: 'symlink',
			field: 'hooks',
			path: COMMON_HOOKS_FILE,
			message: `${COMMON_HOOKS_FILE} is a link and is not followed.`,
		})
	}
	let hookCount = 0
	const knownEvents = new Set<string>([
		...(SHELL_HOOK_EVENTS as readonly string[]),
		...(Object.values(SHELL_HOOK_PASCAL_EVENT_NAMES) as string[]),
		...Object.keys(RENAMED_PLUGIN_HOOK_EVENTS),
	])
	const noteEvents = (events: Record<string, unknown>, field: string, path?: string): void => {
		for (const [event, list] of Object.entries(events)) {
			if (!knownEvents.has(event)) {
				out.add({
					level: 'ignored',
					code: 'hook-event-unknown',
					field,
					...(path !== undefined ? { path } : {}),
					message: `The hook event "${event}" is not one Namzu has, so its hooks do not run.`,
				})
			} else hookCount += toList(list).length
		}
	}
	for (const rel of hookFiles) {
		const kind = await walk(root, rel)
		if (kind !== 'file') {
			out.add({
				level: 'refused',
				code: 'hooks-file-missing',
				field: 'hooks',
				path: rel,
				message: `${rel} is listed as a hooks file and is not there.`,
			})
			continue
		}
		const read = await readCapped(join(root, rel))
		if ('problem' in read) {
			out.add({
				level: 'refused',
				code: 'hooks-file-invalid',
				field: 'hooks',
				path: rel,
				message: `${rel} ${read.problem}.`,
			})
			continue
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(read.text)
		} catch {
			out.add({
				level: 'refused',
				code: 'hooks-file-invalid',
				field: 'hooks',
				path: rel,
				message: `${rel} is not valid JSON.`,
			})
			continue
		}
		if (isMapping(parsed) && parsed.modules !== undefined) {
			if (rel === COMMON_HOOKS_FILE) {
				noteHookModule(root, out)
			} else {
				out.add({
					level: 'refused',
					code: 'hooks-modules-refused',
					field: 'hooks',
					path: rel,
					message: `${rel}: "modules" is read only in ${COMMON_HOOKS_FILE}, so this module does not run; its plain hook entries still load.`,
				})
			}
		}
		const events = isMapping(parsed)
			? isMapping(parsed.hooks)
				? parsed.hooks
				: parsed.modules !== undefined
					? {}
					: parsed
			: {}
		noteEvents(events, 'hooks', rel)
	}
	if (inlineHooks) noteEvents(hookEntries, 'hooks')
	if (hookCount > 0) {
		out.add({
			level: 'used',
			code: 'hooks-used',
			field: 'hooks',
			message: `${hookCount} hook entr${hookCount === 1 ? 'y' : 'ies'}.`,
		})
	}

	// --- servers ----------------------------------------------------------
	const sources: McpSource[] = []
	const mcpFile = async (rel: string, listed: boolean): Promise<void> => {
		if (/\.(mcpb|dxt)$/i.test(rel)) {
			out.add({
				level: 'ignored',
				code: 'mcp-bundle',
				field: 'mcpServers',
				path: rel,
				message: `${rel} is a packaged server bundle, which Namzu does not read.`,
			})
			return
		}
		const kind = await walk(root, rel)
		if (kind === 'link') {
			out.add({
				level: 'ignored',
				code: 'symlink',
				field: 'mcpServers',
				path: rel,
				message: `${rel} is a link and is not followed.`,
			})
			return
		}
		if (kind !== 'file') {
			if (listed)
				out.add({
					level: 'refused',
					code: 'mcp-file-missing',
					field: 'mcpServers',
					path: rel,
					message: `${rel} is listed and is not there.`,
				})
			return
		}
		const read = await readCapped(join(root, rel))
		if ('problem' in read) {
			out.add({
				level: 'refused',
				code: 'mcp-file-invalid',
				field: 'mcpServers',
				path: rel,
				message: `${rel} ${read.problem}.`,
			})
			return
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(read.text)
		} catch {
			out.add({
				level: 'refused',
				code: 'mcp-file-invalid',
				field: 'mcpServers',
				path: rel,
				message: `${rel} is not valid JSON.`,
			})
			return
		}
		const map = serversOf(parsed)
		if (map === undefined) {
			out.add({
				level: 'refused',
				code: 'mcp-file-invalid',
				field: 'mcpServers',
				path: rel,
				message: `${rel} must be an object of servers.`,
			})
			return
		}
		sources.push({ origin: rel, map })
	}
	for (const entry of toList(m.mcpServers)) {
		if (typeof entry === 'string') {
			const problem = relativeProblem(entry)
			if (problem !== undefined) {
				out.refuseAll(
					'path-escapes',
					'mcpServers',
					`mcpServers: "${entry}" ${problem}, so the plugin is not loaded.`,
				)
				return finish(source)
			}
			await mcpFile(trimDot(entry), true)
		} else {
			const map = serversOf(entry)
			if (map !== undefined) sources.push({ origin: 'the manifest', map })
		}
	}
	await mcpFile(COMMON_MCP_FILE, false)
	const dataAndProject = options.paths?.(name) ?? {}
	const servers = readMcpSources(
		sources,
		{ root, ...dataAndProject },
		options.environment ?? (process.env as Record<string, string | undefined>),
	)
	for (const finding of servers.findings) out.add(finding)
	if (servers.local.length + servers.remote.length > COMMON_LAYOUT_MAX_MCP_SERVERS) {
		out.refuseAll(
			'too-many-servers',
			'mcpServers',
			`The plugin lists ${servers.local.length + servers.remote.length} servers; Namzu reads at most ${COMMON_LAYOUT_MAX_MCP_SERVERS} from one plugin.`,
		)
		return finish(source)
	}

	// --- what Namzu has no place for ---------------------------------------
	for (const field of NOT_USED_FIELDS) {
		if (m[field] === undefined) continue
		const count = countOf(m[field])
		if (count === 0) continue
		const loud =
			field === 'settings'
				? ' This plugin asks to change your settings. Namzu does not apply that.'
				: field === 'binaries'
					? ' This plugin asks for programs to be put on this computer. Namzu does not do that.'
					: field === 'network'
						? ` It says it reaches: ${JSON.stringify(m[field]).slice(0, 200)}.`
						: ''
		out.add({
			level: 'notUsed',
			code: 'component-unsupported',
			field,
			message: `${field} (${count}) is not used by Namzu.${loud}`,
		})
	}
	for (const dir of COMMON_UNUSED_DIRS) {
		if ((await kindOf(join(root, dir))) === 'dir') {
			const count = (await readdir(join(root, dir)).catch(() => [])).length
			if (count === 0) continue
			out.add({
				level: 'notUsed',
				code: 'component-unsupported',
				field: dir,
				path: dir,
				message: `${dir}/ (${count}) is not used by Namzu.${dir === 'bin' ? ' Programs in bin/ are not put on your path.' : ''}`,
			})
		}
	}
	if (m.userConfig !== undefined) {
		out.add({
			level: 'notUsed',
			code: 'user-config-unsupported',
			field: 'userConfig',
			message:
				'userConfig (saved options) is not supported yet; a server that needs one is not started.',
		})
	}

	// --- nothing usable ---------------------------------------------------
	const usable =
		skillPaths.length > 0 ||
		(commands?.length ?? 0) > 0 ||
		(agents?.length ?? 0) > 0 ||
		hookCount > 0 ||
		hookFiles.length > 0 ||
		inlineHooks ||
		servers.local.length > 0 ||
		servers.remote.length > 0
	if (!usable) {
		const only = [
			...NOT_USED_FIELDS.filter((field) => m[field] !== undefined),
			...COMMON_UNUSED_DIRS.filter((dir) => out.findings.some((f) => f.path === dir)),
		]
		out.refuseAll(
			'nothing-used',
			'manifest',
			`Nothing in ${name} is used by Namzu${only.length > 0 ? ` (it only has: ${only.join(', ')})` : ''}.`,
		)
		return finish(source)
	}

	// --- version and description -------------------------------------------
	const surfaceDigest = createHash('sha256')
		.update(
			JSON.stringify({
				skillPaths,
				commands,
				agents,
				hookFiles,
				servers: [...servers.local, ...servers.remote],
			}),
		)
		.digest('hex')
		.slice(0, 8)
	const version =
		typeof m.version === 'string' && m.version.length > 0
			? m.version
			: (options.version ?? `0.0.0+${surfaceDigest}`)
	let description =
		typeof m.description === 'string' && m.description.length > 0 ? m.description : undefined
	if (description === undefined) {
		const readme =
			(await kindOf(join(root, 'README.md'))) === 'file'
				? await readCapped(join(root, 'README.md'))
				: undefined
		const line =
			readme && 'text' in readme
				? readme.text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.trim().startsWith('#'))
				: undefined
		description = line?.trim().slice(0, 300) ?? options.description ?? '(no description)'
	}

	// --- the manifest Namzu admits ------------------------------------------
	const platforms = Array.isArray(m.platforms)
		? m.platforms.filter((p) => typeof p === 'string')
		: undefined
	const engineNamzu =
		isMapping(m.engines) && typeof m.engines.namzu === 'string' ? m.engines.namzu : undefined
	const candidate = {
		name,
		version,
		description,
		...(author !== undefined ? { author } : {}),
		...(skillPaths.length > 0 ? { skills: skillPaths } : {}),
		...(hookFiles.length > 0 ? { hooks: hookFiles } : {}),
		...(inlineHooks ? { hookEntries } : {}),
		...(servers.local.length > 0 ? { mcpServers: servers.local } : {}),
		...(servers.remote.length > 0 ? { remoteMcpServers: servers.remote } : {}),
		...((commands?.length ?? 0) > 0 ? { commands } : {}),
		...((agents?.length ?? 0) > 0 ? { agents } : {}),
		...(platforms && platforms.length > 0 ? { platforms } : {}),
		...(engineNamzu !== undefined ? { engines: { namzu: engineNamzu } } : {}),
	}
	const parsed = CommonLayoutManifestSchema.safeParse(candidate)
	if (!parsed.success) {
		out.refuseAll(
			'manifest-invalid',
			'manifest',
			parsed.error.issues
				.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
				.join('; '),
		)
		return finish(source)
	}
	const manifest: PluginManifest = Object.freeze({
		...parsed.data,
		layout: 'common' as const,
	})
	return finish(source, manifest, servers.remote)
}

async function noteAgentKeys(root: string, rel: string, out: Collector): Promise<void> {
	const files: string[] = []
	if ((await walk(root, rel)) === 'file') files.push(rel)
	else {
		const entries = await readdir(join(root, rel), {
			withFileTypes: true,
		}).catch(() => [])
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.md')) files.push(`${rel}/${entry.name}`)
		}
	}
	for (const file of files.sort()) {
		const read = await readCapped(join(root, file))
		if ('problem' in read) continue
		const extra = topKeys(read.text).filter((key) => !AGENT_FILE_KEYS.includes(key))
		if (extra.length > 0) {
			out.add({
				level: 'ignored',
				code: 'agent-key-ignored',
				field: 'agents',
				path: file,
				message: `${file}: ${extra.map((key) => `"${key}"`).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not read.`,
			})
		}
	}
}

/**
 * Count a folder's files and bytes without following links, stopping as soon as
 * either cap is passed. The reason it is too large, or undefined.
 */
async function measureFolder(root: string): Promise<string | undefined> {
	let files = 0
	let bytes = 0
	const pending = [root]
	while (pending.length > 0) {
		const dir = pending.pop() as string
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === '.git' || entry.name === 'node_modules') continue
				pending.push(full)
				continue
			}
			files += 1
			bytes += (await lstat(full).catch(() => undefined))?.size ?? 0
			if (files > COMMON_LAYOUT_MAX_FILES) {
				return `The plugin has more than ${COMMON_LAYOUT_MAX_FILES} files; Namzu reads at most that many from one plugin.`
			}
			if (bytes > COMMON_LAYOUT_MAX_BYTES) {
				return `The plugin is larger than ${COMMON_LAYOUT_MAX_BYTES / (1024 * 1024)} MiB; Namzu reads at most that much from one plugin.`
			}
		}
	}
	return undefined
}

/**
 * The folder to read when a download or archive was unpacked: a single
 * wrapping folder is descended into when it holds the manifest folder or a
 * recognised component, ignoring `__MACOSX` and `.DS_Store`. The folder itself
 * when it already holds one, or when there is no such wrapper.
 */
export async function findCommonLayoutRoot(dir: string): Promise<string> {
	const recognised = async (path: string): Promise<boolean> => {
		for (const name of [
			COMMON_MANIFEST_DIR,
			COMMON_SKILLS_DIR,
			COMMON_COMMANDS_DIR,
			COMMON_AGENTS_DIR,
			'hooks',
			COMMON_MCP_FILE,
			COMMON_ROOT_SKILL_FILE,
			PLUGIN_MANIFEST_FILENAME,
		]) {
			if ((await kindOf(join(path, name))) !== 'missing') return true
		}
		return false
	}
	if (await recognised(dir)) return dir
	const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(
		(entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store',
	)
	if (entries.length === 1 && entries[0]?.isDirectory()) {
		const inner = join(dir, entries[0].name)
		if (await recognised(inner)) return inner
	}
	return dir
}
