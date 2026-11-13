/**
 * Check a plugin folder without running anything from it.
 *
 * The rules are the loader's own: the manifest goes through the kernel's
 * `parsePluginManifestText` and `assertEnableable`, a skill through
 * `parseSkillMarkdown`, an agent file through `parseAgentMarkdown`, a command
 * file through `parseCommandText`, a declared folder through
 * `resolvePluginFileDir`, and a path through `resolveWithinReal`. This file
 * only reads the text those functions are given and says where in the file the
 * reason sits. A rule added to the loader later reaches this check by being
 * added to the shared function, not by being copied here.
 *
 * What it never does: import a module, start a server, run a hook or a
 * command, or open a network connection. It reads files inside the plugin
 * folder; a reference that leaves the folder is reported and not followed.
 * What that costs: a tool or hook module's exports are not checked (that takes
 * running it), so a module is checked for being a readable file inside the
 * folder and, as a warning, by what its text says.
 */

import { constants, existsSync } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import {
	AGENT_FILE_KEYS,
	PluginManifestSchema,
	RENAMED_PLUGIN_HOOK_EVENTS,
	SKILL_FRONTMATTER_KEYS,
	assertEnableable,
	assertPluginHookEvent,
	isHookEntriesPath,
	parseAgentMarkdown,
	parsePluginManifestText,
	parseSkillMarkdown,
	resolveWithinReal,
	skillModelDescription,
} from '@namzu/sdk'
import { readSkillHooks } from '../../config/skill-hooks-reader.js'
import { readAgentHooks } from '../subagents/agent-hooks.js'

import { PERMISSION_MODE_NAMES } from '../../permissions/mode-names.js'
import { SKILL_MANIFEST_MAX_CHARS } from '../../skills/catalog.js'
import { COMMAND_FILE_KEYS, parseCommandText } from '../../user-commands/store.js'
import { resolvePluginFileDir } from './files.js'
import { CONVENTIONAL_HOOKS_FILE, readPluginHookEntriesOf } from './hook-entries.js'

/** The version of the JSON shape `namzu plugin validate --json` prints. */
export const PLUGIN_VALIDATION_REPORT_VERSION = 1

/** Most bytes one file is read for; a larger one is reported, not read. */
export const MAX_CHECKED_FILE_BYTES = 4 * 1024 * 1024

/** Most files one declared folder is checked for. */
export const MAX_CHECKED_FILES_PER_FOLDER = 500

const MANIFEST_FILE = 'plugin.json'

export type PluginProblemLevel = 'error' | 'warning'

export type PluginPartKind =
	| 'manifest'
	| 'tool'
	| 'hook'
	| 'skill'
	| 'mcp-server'
	| 'command'
	| 'agent'

export interface PluginProblem {
	readonly level: PluginProblemLevel
	/** The part it belongs to, as `<kind>:<name>`; `manifest` for the manifest. */
	readonly part: string
	/** Path inside the plugin folder, with `/`; empty for the folder itself. */
	readonly file: string
	/** 1-based line, when the file says where. */
	readonly line?: number
	/** A stable short name for the kind of problem. */
	readonly code: string
	readonly message: string
	/** What the loader does about it. */
	readonly consequence: string
}

export interface PluginPart {
	readonly kind: PluginPartKind
	readonly name: string
	readonly file?: string
	/** `error` when any of its problems is an error, `warning` when it has only warnings. */
	readonly status: 'ok' | 'warning' | 'error'
}

export type PluginValidationStatus = 'clean' | 'warnings' | 'errors' | 'unreadable'

export interface PluginValidationReport {
	readonly version: typeof PLUGIN_VALIDATION_REPORT_VERSION
	/** The folder checked, as an absolute path. */
	readonly folder: string
	readonly status: PluginValidationStatus
	/** Why the folder could not be read; only with status `unreadable`. */
	readonly readError?: string
	readonly plugin: { readonly name?: string; readonly version?: string }
	readonly parts: readonly PluginPart[]
	readonly problems: readonly PluginProblem[]
	readonly summary: { readonly errors: number; readonly warnings: number }
}

// --- reading --------------------------------------------------------------

type Read =
	| { readonly ok: true; readonly text: string; readonly abs: string }
	| {
			readonly ok: false
			readonly kind: 'outside' | 'missing' | 'not-file' | 'too-large' | 'binary' | 'unreadable'
			readonly detail?: string
	  }

/**
 * One file inside `root`, read as text. The path is resolved by the kernel's
 * own containment rule (links included) before anything is opened, the file
 * must be a regular file, and no more than {@link MAX_CHECKED_FILE_BYTES} are
 * read.
 */
async function readInside(root: string, rel: string): Promise<Read> {
	let abs: string
	try {
		abs = await resolveWithinReal(root, rel)
	} catch (error) {
		return { ok: false, kind: 'outside', detail: message(error) }
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		const before = await stat(abs)
		if (!before.isFile()) return { ok: false, kind: 'not-file' }
		// Not blocking, so a pipe someone left in the folder cannot hold this up.
		handle = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK)
		const info = await handle.stat()
		if (!info.isFile()) return { ok: false, kind: 'not-file' }
		if (info.size > MAX_CHECKED_FILE_BYTES) {
			return { ok: false, kind: 'too-large', detail: `${info.size} bytes` }
		}
		const buffer = Buffer.alloc(info.size)
		let filled = 0
		while (filled < info.size) {
			const { bytesRead } = await handle.read(buffer, filled, info.size - filled, filled)
			if (bytesRead === 0) break
			filled += bytesRead
		}
		const bytes = buffer.subarray(0, filled)
		if (bytes.includes(0)) return { ok: false, kind: 'binary' }
		return { ok: true, text: bytes.toString('utf8'), abs }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, kind: 'missing' }
		return { ok: false, kind: 'unreadable', detail: message(error) }
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function posix(path: string): string {
	return path.split(sep).join('/')
}

// --- where in a file ------------------------------------------------------

/** Where each key and array element of a JSON text starts, as 1-based lines. */
function jsonLines(text: string): Map<string, number> {
	const lines = new Map<string, number>()
	let i = 0
	let line = 1
	const skip = (): void => {
		while (i < text.length) {
			const c = text[i]
			if (c === '\n') line++
			else if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '﻿') return
			i++
		}
	}
	const string = (): string => {
		const start = i
		i++
		while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
		i++
		return JSON.parse(text.slice(start, i)) as string
	}
	const value = (path: string): void => {
		skip()
		const c = text[i]
		if (c === '{') {
			i++
			skip()
			while (text[i] !== '}') {
				skip()
				const keyLine = line
				const key = string()
				const child = path === '' ? key : `${path}/${key}`
				lines.set(child, keyLine)
				skip()
				i++ // the colon
				value(child)
				skip()
				if (text[i] === ',') i++
				skip()
			}
			i++
		} else if (c === '[') {
			i++
			skip()
			let index = 0
			while (text[i] !== ']') {
				skip()
				const child = path === '' ? String(index) : `${path}/${index}`
				lines.set(child, line)
				value(child)
				index++
				skip()
				if (text[i] === ',') i++
				skip()
			}
			i++
		} else if (c === '"') {
			string()
		} else {
			while (i < text.length && !/[,\]}\s]/.test(text[i] as string)) i++
		}
	}
	try {
		value('')
	} catch {
		// Text that does not scan has no lines to give; callers fall back to none.
	}
	return lines
}

/** The 1-based line of the first non-indented `key:` in a file's frontmatter. */
function frontmatterKeys(text: string): { key: string; line: number }[] {
	const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
	let start = lines.findIndex((l) => l.trim() !== '')
	if (start === -1 || lines[start]?.trim() !== '---') return []
	start++
	const keys: { key: string; line: number }[] = []
	for (let n = start; n < lines.length; n++) {
		const l = lines[n] as string
		if (/^---[ \t]*$/.test(l)) break
		const match = /^([A-Za-z0-9_-]+)\s*:/.exec(l)
		if (match) keys.push({ key: match[1] as string, line: n + 1 })
	}
	return keys
}

/** The line of the key a frontmatter reason talks about; the opening fence when none is named. */
function lineForReason(text: string, reason: string): number {
	const keys = frontmatterKeys(text)
	const named = keys
		.filter(({ key }) =>
			new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(key)}([^A-Za-z0-9_-]|$)`).test(reason),
		)
		.sort((a, b) => b.key.length - a.key.length)[0]
	if (named) return named.line
	const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
	const fence = lines.findIndex((l) => l.trim() === '---')
	return fence === -1 ? 1 : fence + 1
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A reason with the path the kernel put in it taken out, for a plain sentence. */
function plainReason(reason: string, ...paths: string[]): string {
	let out = reason
	for (const p of paths) out = out.split(p).join('')
	return out.replace(/\s+/g, ' ').trim()
}

// --- the report -----------------------------------------------------------

class Collector {
	readonly problems: PluginProblem[] = []
	/** Name and version read from a manifest that is otherwise refused, when they are plain text. */
	identity: { name?: string; version?: string } = {}
	readonly parts: { kind: PluginPartKind; name: string; file?: string; id: string }[] = []

	part(kind: PluginPartKind, name: string, file?: string): string {
		const id = kind === 'manifest' ? 'manifest' : `${kind}:${name}`
		if (!this.parts.some((p) => p.id === id)) {
			this.parts.push({ kind, name, ...(file !== undefined ? { file } : {}), id })
		}
		return id
	}

	add(problem: Omit<PluginProblem, 'line'> & { line?: number | undefined }): void {
		const { line, ...rest } = problem
		this.problems.push({ ...rest, ...(line !== undefined ? { line } : {}) })
	}

	finish(folder: string, plugin: { name?: string; version?: string }): PluginValidationReport {
		const parts: PluginPart[] = this.parts.map(({ id, kind, name, file }) => {
			const own = this.problems.filter((p) => p.part === id)
			return {
				kind,
				name,
				...(file !== undefined ? { file } : {}),
				status: own.some((p) => p.level === 'error') ? 'error' : own.length > 0 ? 'warning' : 'ok',
			}
		})
		const errors = this.problems.filter((p) => p.level === 'error').length
		const warnings = this.problems.length - errors
		return {
			version: PLUGIN_VALIDATION_REPORT_VERSION,
			folder,
			status: errors > 0 ? 'errors' : warnings > 0 ? 'warnings' : 'clean',
			plugin,
			parts,
			problems: this.problems,
			summary: { errors, warnings },
		}
	}
}

/** The folder could not be opened as a folder at all. */
export function unreadableReport(folder: string, readError: string): PluginValidationReport {
	return {
		version: PLUGIN_VALIDATION_REPORT_VERSION,
		folder,
		status: 'unreadable',
		readError,
		plugin: {},
		parts: [],
		problems: [],
		summary: { errors: 0, warnings: 0 },
	}
}

const REFUSED = 'The loader refuses the whole plugin; nothing in it is loaded.'
const FILE_NOTE = 'This file is read, never run.'

/**
 * Check the plugin in `folder`. Never throws for a problem with the plugin: a
 * folder that cannot be opened comes back as an `unreadable` report.
 */
export async function validatePluginFolder(folder: string): Promise<PluginValidationReport> {
	let root: string
	try {
		root = await realpath(folder)
		if (!(await stat(root)).isDirectory()) {
			return unreadableReport(folder, 'it is not a folder.')
		}
		await readdir(root)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		return unreadableReport(
			folder,
			code === 'ENOENT' ? 'it does not exist.' : `it could not be opened: ${message(error)}`,
		)
	}

	const c = new Collector()
	const manifest = await checkManifest(root, c)
	if (manifest) await checkParts(root, manifest, c)
	return c.finish(root, manifest ? { name: manifest.name, version: manifest.version } : c.identity)
}

type Manifest = ReturnType<typeof parsePluginManifestText>

async function checkManifest(root: string, c: Collector): Promise<Manifest | undefined> {
	const part = c.part('manifest', MANIFEST_FILE, MANIFEST_FILE)
	const problem = (
		code: string,
		text: string,
		consequence = REFUSED,
		line?: number,
		level: PluginProblemLevel = 'error',
	): void => c.add({ level, part, file: MANIFEST_FILE, line, code, message: text, consequence })

	// The loader's own file rule: a regular file, not a link.
	let entry: Awaited<ReturnType<typeof lstat>>
	try {
		entry = await lstat(join(root, MANIFEST_FILE))
	} catch {
		problem(
			'manifest-missing',
			`There is no ${MANIFEST_FILE} in this folder.`,
			'The folder is not a plugin; discovery skips it and --plugin-dir refuses it.',
		)
		return undefined
	}
	if (entry.isSymbolicLink() || !entry.isFile()) {
		problem(
			'manifest-not-regular',
			`${MANIFEST_FILE} must be a regular file, not a link or a folder.`,
		)
		return undefined
	}
	const read = await readInside(root, MANIFEST_FILE)
	if (!read.ok) {
		const reason =
			read.kind === 'too-large'
				? `${MANIFEST_FILE} is ${read.detail ?? 'very large'}, over the ${MAX_CHECKED_FILE_BYTES} bytes this check reads.`
				: read.kind === 'binary'
					? `${MANIFEST_FILE} is not a text file.`
					: `${MANIFEST_FILE} could not be read${read.detail ? `: ${read.detail}` : '.'}`
		if (read.kind === 'too-large') {
			// Too large to read here, but the loader reads any size: not read is not refused.
			problem(
				'manifest-too-large',
				`${reason} It was not read, so nothing else in this plugin was checked.`,
				'The loader reads a manifest of any size; whether it accepts this one is not known here.',
				undefined,
				'warning',
			)
			return undefined
		}
		problem(`manifest-${read.kind === 'binary' ? 'binary' : 'unreadable'}`, reason)
		return undefined
	}

	let parsed: Manifest
	try {
		parsed = parsePluginManifestText(read.text)
	} catch (error) {
		const lines = jsonLines(read.text)
		try {
			const loose = JSON.parse(read.text) as Record<string, unknown>
			c.identity = {
				...(typeof loose.name === 'string' ? { name: loose.name } : {}),
				...(typeof loose.version === 'string' ? { version: loose.version } : {}),
			}
		} catch {
			// Not JSON: there is no name to read.
		}
		const issues = (error as { issues?: unknown }).issues
		if (Array.isArray(issues)) {
			for (const issue of issues as {
				path: (string | number)[]
				message: string
				code?: string
				keys?: string[]
			}[]) {
				const where = issue.path
					.map((step, at) =>
						typeof step === 'number' ? `[${step}]` : at === 0 ? step : `.${step}`,
					)
					.join('')
				const keys = issue.code === 'unrecognized_keys' && issue.keys ? issue.keys : undefined
				const text = keys
					? `${where ? `"${where}" has` : 'The manifest has'} ${keys.length === 1 ? 'a field' : 'fields'} the loader does not accept: ${keys.map((k) => `"${k}"`).join(', ')}.`
					: `${where ? `"${where}": ` : ''}${issue.message}.`
				const path = [...issue.path, ...(keys?.[0] ? [keys[0]] : [])].join('/')
				problem(
					'manifest-schema',
					text,
					REFUSED,
					lines.get(path) ?? lines.get(issue.path.join('/')),
				)
			}
		} else {
			// The text is not JSON. Node says where, in one of two spellings.
			const text = message(error)
			const at = /line (\d+)/.exec(text)
			const position = /position (\d+)/.exec(text)
			const line = at
				? Number(at[1])
				: position
					? read.text.slice(0, Number(position[1])).split('\n').length
					: undefined
			problem('manifest-json', `${MANIFEST_FILE} is not valid JSON: ${text}.`, REFUSED, line)
		}
		return undefined
	}

	// The third step the loader takes on a manifest: can it be enabled here.
	try {
		assertEnableable(parsed, { skillsSupported: true })
	} catch (error) {
		problem('manifest-incompatible', plainReason(message(error)))
	}

	const lines = jsonLines(read.text)
	let raw: unknown
	try {
		raw = JSON.parse(read.text)
	} catch {
		raw = undefined
	}
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const known = new Set(Object.keys(PluginManifestSchema.shape))
		for (const key of Object.keys(raw)) {
			if (known.has(key)) continue
			problem(
				'manifest-unknown-key',
				`"${key}" is not a field Namzu reads in a manifest, so it is ignored. If it is a misspelling, the part it was meant to declare is missing.`,
				'The loader drops the field without a word.',
				lines.get(key),
				'warning',
			)
		}
	}
	if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(parsed.version)) {
		problem(
			'manifest-version-format',
			`"version" is "${parsed.version}", which is not a semantic version such as 1.0.0.`,
			'The loader accepts any text; tools that compare versions will not.',
			lines.get('version'),
			'warning',
		)
	}
	const contributes =
		(parsed.tools?.length ?? 0) +
		(parsed.skills?.length ?? 0) +
		(parsed.hooks?.length ?? 0) +
		Object.keys(parsed.hookEntries ?? {}).length +
		(existsSync(join(root, CONVENTIONAL_HOOKS_FILE)) ? 1 : 0) +
		(parsed.mcpServers?.length ?? 0) +
		(parsed.commands?.length ?? 0) +
		(parsed.agents?.length ?? 0) +
		(parsed.instructions ? 1 : 0)
	if (contributes === 0) {
		problem(
			'manifest-empty',
			'The plugin declares no tools, skills, hooks, MCP servers, commands, agents or instructions, so it adds nothing.',
			'It loads and does nothing.',
			undefined,
			'warning',
		)
	}
	return parsed
}

async function checkParts(root: string, manifest: Manifest, c: Collector): Promise<void> {
	const pluginName = manifest.name

	// Tools and hooks: JavaScript modules, checked by their path and text.
	for (const [kind, list] of [
		['tool', manifest.tools],
		['hook', manifest.hooks],
	] as const) {
		const seen = new Set<string>()
		for (const [index, rel] of (list ?? []).entries()) {
			const part = c.part(kind, rel, rel)
			const key = `${kind === 'tool' ? 'tools' : 'hooks'}/${index}`
			if (seen.has(rel)) {
				c.add({
					level: 'warning',
					part,
					file: MANIFEST_FILE,
					code: 'part-duplicate',
					message: `"${rel}" is listed twice in "${kind === 'tool' ? 'tools' : 'hooks'}".`,
					consequence: 'The module is imported once, but its tools or hooks are registered twice.',
				})
			}
			seen.add(rel)
			// A `.json` path is a file of hook entries, checked below, not a module.
			if (kind === 'hook' && isHookEntriesPath(rel)) continue
			await checkModule(root, kind, rel, part, key, c)
		}
	}
	checkHookEntries(root, manifest, c)

	// Skills.
	const skillNames = new Set<string>()
	for (const rel of manifest.skills ?? []) {
		const part = c.part('skill', rel, rel)
		await checkSkill(root, rel, part, skillNames, c)
	}

	// MCP servers: the schema has already been applied; this reads what it cannot.
	checkMcpServers(root, manifest, c)

	// Command and agent folders.
	const commandNames = new Map<string, string>()
	for (const rel of manifest.commands ?? []) {
		await checkFolder(root, rel, 'commands', pluginName, c, async (file, text, abs) => {
			const base = file.slice(0, -'.md'.length)
			const name = `${pluginName}__${base}`
			const rel2 = posix(relative(root, abs))
			const part = c.part('command', name, rel2)
			const prior = commandNames.get(name)
			if (prior !== undefined) {
				c.add({
					level: 'warning',
					part,
					file: rel2,
					code: 'command-duplicate',
					message: `/${name} is also written by ${prior}.`,
					consequence: 'The file read last replaces the other.',
				})
			}
			commandNames.set(name, rel2)
			if (/\s/.test(base)) {
				c.add({
					level: 'warning',
					part,
					file: rel2,
					code: 'command-name',
					message: `The file name "${file}" has a space, so "/${name}" cannot be typed as one word.`,
					consequence: 'The command is listed but cannot be run by name.',
				})
			}
			const command = parseCommandText(text, abs, name, 'plugin')
			if (command.problem) {
				c.add({
					level: 'error',
					part,
					file: rel2,
					line: lineForReason(text, command.problem),
					code: 'command-invalid',
					message: `The command file ${plainReason(command.problem, abs)}.`,
					consequence: 'The command is listed with this reason and cannot be used.',
				})
				return
			}
			if (command.template.trim() === '') {
				c.add({
					level: 'warning',
					part,
					file: rel2,
					code: 'command-empty',
					message: 'The file has no prompt text after its frontmatter.',
					consequence: 'The command sends an empty prompt.',
				})
			}
			unknownKeys(text, COMMAND_FILE_KEYS, part, rel2, 'command-unknown-key', c, 'a command file')
		})
	}
	const agentNames = new Map<string, string>()
	for (const rel of manifest.agents ?? []) {
		await checkFolder(root, rel, 'agents', pluginName, c, async (file, text, abs) => {
			const rel2 = posix(relative(root, abs))
			const fallback = `${pluginName}__${file.slice(0, -'.md'.length)}`
			const found = parseAgentMarkdown(
				text,
				abs,
				'plugin',
				undefined,
				new Set([...PERMISSION_MODE_NAMES, 'inherit']),
			)
			// Named as the model sees it when the file parses, by its file otherwise.
			const part = c.part(
				'agent',
				'reason' in found ? fallback : `${pluginName}__${found.name}`,
				rel2,
			)
			if ('reason' in found) {
				c.add({
					level: 'error',
					part,
					file: rel2,
					line: lineForReason(text, found.reason),
					code: 'agent-invalid',
					message: `The agent file ${plainReason(found.reason, abs)}.`,
					consequence: 'The file is skipped and named in the log; the other agents load.',
				})
				return
			}
			const full = `${pluginName}__${found.name}`
			const prior = agentNames.get(full)
			if (prior !== undefined) {
				c.add({
					level: 'warning',
					part,
					file: rel2,
					code: 'agent-duplicate',
					message: `The agent "${full}" is also defined by ${prior}.`,
					consequence: 'The file read last replaces the other.',
				})
			}
			agentNames.set(full, rel2)
			unknownKeys(text, AGENT_FILE_KEYS, part, rel2, 'agent-unknown-key', c, 'an agent file')
			if (found.hooksSource !== undefined) {
				const hooks = readAgentHooks(found.hooksSource, full)
				for (const problem of hooks.problems) {
					c.add({
						// An entry that would have guarded something and cannot be loaded keeps the agent from being offered.
						level: problem.severity === 'problem' ? 'error' : 'warning',
						part,
						file: rel2,
						line: lineOfKey(text, 'hooks'),
						code: 'agent-hooks-problem',
						message: `"${full}" hooks, ${problem.event}: ${problem.message}`,
						consequence:
							problem.severity === 'problem'
								? 'The agent is not offered, and starting it is refused with this line.'
								: 'The agent runs with this part of its hooks left out.',
					})
				}
			}
		})
	}
}

function unknownKeys(
	text: string,
	known: readonly string[],
	part: string,
	file: string,
	code: string,
	c: Collector,
	what: string,
): void {
	for (const { key, line } of frontmatterKeys(text)) {
		if (known.includes(key)) continue
		c.add({
			level: 'warning',
			part,
			file,
			line,
			code,
			message: `"${key}" is not a key ${what} reads, so it is ignored. If it is a misspelling, what it was meant to set is not set.`,
			consequence: 'The loader drops the key without a word.',
		})
	}
}

/** What a path problem from {@link readInside} says, in one place for every part. */
function readProblem(
	read: Extract<Read, { ok: false }>,
	what: string,
	rel: string,
): { code: string; text: string } {
	switch (read.kind) {
		case 'outside':
			return {
				code: 'path-outside',
				text: `${what} "${rel}" leaves the plugin folder, so it is not followed.`,
			}
		case 'missing':
			return { code: 'path-missing', text: `${what} "${rel}" does not exist.` }
		case 'not-file':
			return { code: 'path-not-file', text: `${what} "${rel}" is not a regular file.` }
		case 'too-large':
			return {
				code: 'file-too-large',
				text: `${what} "${rel}" is ${read.detail ?? 'very large'}, over the ${MAX_CHECKED_FILE_BYTES} bytes this check reads, so it was not read.`,
			}
		case 'binary':
			return { code: 'file-binary', text: `${what} "${rel}" is not a text file.` }
		default:
			return {
				code: 'file-unreadable',
				text: `${what} "${rel}" could not be read${read.detail ? `: ${read.detail}` : '.'}`,
			}
	}
}

/** Names that read as markdown to a person, whatever the loader makes of them. */
const MARKDOWN_LOOKALIKE = /\.(md|markdown|mdown|mkd|mdx)$/i

const MODULE_EXTENSIONS = ['.js', '.mjs', '.cjs']

/**
 * The hook entries a plugin ships (commands, addresses, prompts): the
 * conventional `hooks/hooks.json`, each `.json` path of the manifest's `hooks`
 * and the inline `hookEntries`, read by the reader a config file's `hooks` key
 * goes through. Nothing is run. A problem is named with the file and what the
 * loader does about it: an entry that cannot be loaded is not attached, the
 * plugin itself still loads.
 */
function checkHookEntries(root: string, manifest: Manifest, c: Collector): void {
	const read = readPluginHookEntriesOf({ rootDir: root, manifest })
	for (const file of read.files) {
		c.part(
			'hook',
			file === 'plugin.json hookEntries' ? 'hookEntries' : file,
			file === 'plugin.json hookEntries' ? MANIFEST_FILE : file,
		)
	}
	for (const problem of read.problems) {
		const inline = problem.file === 'plugin.json hookEntries'
		const file = inline ? MANIFEST_FILE : problem.file
		c.add({
			level: problem.severity === 'problem' ? 'error' : 'warning',
			part: c.part('hook', inline ? 'hookEntries' : problem.file, file),
			file,
			code: problem.code,
			message: problem.message,
			consequence:
				problem.severity === 'problem'
					? 'These hook entries are not attached (the plugin itself still loads), so what they were meant to guard is not checked.'
					: 'The hook entries load without it.',
		})
	}
}

async function checkModule(
	root: string,
	kind: 'tool' | 'hook',
	rel: string,
	part: string,
	_key: string,
	c: Collector,
): Promise<void> {
	const what = kind === 'tool' ? 'The tool module' : 'The hook module'
	const read = await readInside(root, rel)
	if (!read.ok) {
		// A module too large to scan still exists and still loads; only the scan is skipped.
		const { code, text } = readProblem(read, what, rel)
		const scanOnly = read.kind === 'too-large'
		c.add({
			level: scanOnly ? 'warning' : 'error',
			part,
			file: MANIFEST_FILE,
			code,
			message: text,
			consequence: scanOnly
				? 'The module is not scanned; whether it loads is decided when it is imported.'
				: REFUSED,
		})
		return
	}
	const file = posix(relative(root, read.abs))
	if (!MODULE_EXTENSIONS.some((ext) => read.abs.endsWith(ext))) {
		c.add({
			level: 'warning',
			part,
			file,
			code: 'module-extension',
			message: `${what} "${rel}" does not end in .js, .mjs or .cjs. Namzu imports it with Node, which loads only those with certainty.`,
			consequence: 'The import may fail, and then the loader refuses the whole plugin.',
		})
	}
	const exportName = kind === 'tool' ? 'tools' : 'hooks'
	if (!new RegExp(`\\b${exportName}\\b`).test(read.text)) {
		c.add({
			level: 'warning',
			part,
			file,
			code: 'module-export',
			message: `The text of ${what.toLowerCase()} "${rel}" never mentions "${exportName}". The loader needs the module to export a "${exportName}" array. ${FILE_NOTE}`,
			consequence: REFUSED,
		})
	}
	if (kind === 'hook') {
		const seen = new Set<string>()
		for (const match of withoutComments(read.text).matchAll(
			/\bevent\s*:\s*(['"`])([A-Za-z0-9_]+)\1/g,
		)) {
			const event = match[2] as string
			if (seen.has(event)) continue
			seen.add(event)
			try {
				assertPluginHookEvent(event as Parameters<typeof assertPluginHookEvent>[0])
			} catch (error) {
				const renamed = RENAMED_PLUGIN_HOOK_EVENTS[event]
				c.add({
					level: 'warning',
					part,
					file,
					line: read.text.slice(0, match.index).split('\n').length,
					code: 'hook-event-unknown',
					message: renamed
						? `The hook event "${event}" was renamed to "${renamed}", so a hook written under the old name cannot be registered.`
						: `"${event}" is not a hook event Namzu has, so a hook written for it cannot be registered.`,
					consequence: `Found by reading the text, not by running it. If the module really registers it, the loader refuses the whole plugin (${plainReason(message(error))}).`,
				})
			}
		}
	}
}

/** The text with its comments blanked, keeping every line where it was. */
function withoutComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (_m, lead: string) => lead)
}

async function checkSkill(
	root: string,
	rel: string,
	part: string,
	names: Set<string>,
	c: Collector,
): Promise<void> {
	let dir: string
	try {
		dir = await resolveWithinReal(root, rel)
	} catch {
		c.add({
			level: 'error',
			part,
			file: MANIFEST_FILE,
			code: 'path-outside',
			message: `The skill folder "${rel}" leaves the plugin folder, so it is not followed.`,
			consequence: REFUSED,
		})
		return
	}
	let isDir = false
	try {
		isDir = (await stat(dir)).isDirectory()
	} catch {
		isDir = false
	}
	if (!isDir) {
		c.add({
			level: 'error',
			part,
			file: MANIFEST_FILE,
			code: 'path-missing',
			message: `The skill folder "${rel}" does not exist or is not a folder.`,
			consequence: REFUSED,
		})
		return
	}
	const skillFile = posix(join(relative(root, dir), 'SKILL.md'))
	const read = await readInside(root, skillFile)
	if (!read.ok) {
		if (read.kind === 'outside') {
			c.add({
				level: 'warning',
				part,
				file: skillFile,
				code: 'path-outside',
				message: `SKILL.md in "${rel}" is a link to a file outside the plugin folder, so it is not followed and was not checked.`,
				consequence:
					'The loader reads it through the link, so what it holds is up to whatever is there.',
			})
			return
		}
		const { code, text } = readProblem(read, 'The skill file', skillFile)
		c.add({
			// Too large to read here, but the loader reads any size: not read is not refused.
			level: read.kind === 'too-large' ? 'warning' : 'error',
			part,
			file: skillFile,
			code: read.kind === 'missing' ? 'path-missing' : code,
			message: read.kind === 'missing' ? `"${rel}" has no SKILL.md.` : text,
			consequence: read.kind === 'too-large' ? 'The loader reads it whatever its size.' : REFUSED,
		})
		return
	}
	let skill: ReturnType<typeof parseSkillMarkdown>
	try {
		skill = parseSkillMarkdown(read.text, dir)
	} catch (error) {
		const reason = message(error)
		c.add({
			level: 'error',
			part,
			file: skillFile,
			line: lineForReason(read.text, reason),
			code: 'skill-invalid',
			message: `The skill file ${plainReason(reason, `SKILL.md at "${dir}": `, `SKILL.md at "${dir}"`)}.`,
			consequence: REFUSED,
		})
		return
	}
	const full = skill.metadata.name
	if (names.has(full)) {
		c.add({
			level: 'error',
			part,
			file: skillFile,
			code: 'skill-duplicate',
			message: `Two declared skills are named "${full}".`,
			consequence: REFUSED,
		})
	}
	names.add(full)
	const model = skillModelDescription(skill.metadata).length
	const entry = model + full.length + dir.length + 90
	if (entry > SKILL_MANIFEST_MAX_CHARS / 4) {
		c.add({
			level: 'warning',
			part,
			file: skillFile,
			code: 'skill-description-large',
			message: `The description and when_to_use of "${full}" take ${model} characters; with its name and place they use about ${entry} of the ${SKILL_MANIFEST_MAX_CHARS} the list of skills may use.`,
			consequence:
				'Skills after it can be left out of the list the model sees (they stay loadable by name).',
		})
	}
	if (skill.body.trim() === '') {
		c.add({
			level: 'warning',
			part,
			file: skillFile,
			code: 'skill-body-empty',
			message: `"${full}" has no instructions after its frontmatter.`,
			consequence: 'It loads and gives the model nothing to follow.',
		})
	}
	unknownKeys(read.text, SKILL_FRONTMATTER_KEYS, part, skillFile, 'skill-unknown-key', c, 'a skill')
	if (skill.metadata.hooksSource !== undefined) {
		const hooks = readSkillHooks(skill.metadata.hooksSource, `skill ${full}`)
		for (const problem of hooks.problems) {
			c.add({
				level: 'warning',
				part,
				file: skillFile,
				line: lineOfKey(read.text, 'hooks'),
				code: 'skill-hooks-problem',
				message: `"${full}" hooks, ${problem.event}: ${problem.message}`,
				consequence:
					problem.severity === 'problem'
						? 'The skill loads without any of its hooks and without its allowed-tools pre-approval, and says so.'
						: 'The skill is used with this part of its hooks left out.',
			})
		}
	}
}

/** The line of a top-level front matter key, for a message that names it. */
function lineOfKey(text: string, key: string): number | undefined {
	return frontmatterKeys(text).find((found) => found.key === key)?.line
}

function leavesFolder(root: string, value: string): boolean {
	if (value.startsWith('~')) return true
	if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
		const rel = relative(root, value)
		return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
	}
	return value.split(/[\\/]/).includes('..')
}

function checkMcpServers(root: string, manifest: Manifest, c: Collector): void {
	const names = new Set<string>()
	for (const server of manifest.mcpServers ?? []) {
		const part = c.part('mcp-server', server.name, MANIFEST_FILE)
		if (names.has(server.name)) {
			c.add({
				level: 'warning',
				part,
				file: MANIFEST_FILE,
				code: 'mcp-duplicate-server',
				message: `Two MCP servers are named "${server.name}".`,
				consequence: 'Both start, and their tool names collide.',
			})
		}
		names.add(server.name)
		if (server.command.includes('/') || server.command.includes('\\')) {
			if (leavesFolder(root, server.command)) {
				c.add({
					level: 'warning',
					part,
					file: MANIFEST_FILE,
					code: 'mcp-command-outside',
					message: `The command "${server.command}" of "${server.name}" points outside the plugin folder. It was not run and not looked at.`,
					consequence: 'It starts whatever is there on the machine that loads the plugin.',
				})
			}
		}
		for (const arg of server.args ?? []) {
			if (/^(\/|[a-zA-Z]:[\\/]|\.\.?[\\/]|~)/.test(arg) && leavesFolder(root, arg)) {
				c.add({
					level: 'warning',
					part,
					file: MANIFEST_FILE,
					code: 'mcp-arg-outside',
					message: `The argument "${arg}" of "${server.name}" points outside the plugin folder.`,
					consequence: 'The server is started with it as written.',
				})
			}
		}
	}
}

/**
 * One declared command or agent folder: resolve it the way the session does,
 * then hand each `.md` file in it to `each`.
 */
async function checkFolder(
	root: string,
	rel: string,
	field: 'commands' | 'agents',
	pluginName: string,
	c: Collector,
	each: (file: string, text: string, abs: string) => Promise<void>,
): Promise<void> {
	const resolved = resolvePluginFileDir(root, rel)
	const part = c.part(field === 'commands' ? 'command' : 'agent', `${field}:${rel}`, rel)
	// A folder is not itself a part: its files are. This one stands in for the
	// folder's own problems and is dropped if it has none.
	const dropPlaceholder = (): void => {
		const at = c.parts.findIndex((p) => p.id === part)
		if (at !== -1 && !c.problems.some((p) => p.part === part)) c.parts.splice(at, 1)
	}
	if (resolved.kind !== 'inside') {
		c.add({
			level: 'error',
			part,
			file: MANIFEST_FILE,
			code: resolved.kind === 'outside' ? 'path-outside' : 'path-missing',
			message:
				resolved.kind === 'outside'
					? `The ${field} folder "${rel}" leads outside the plugin folder, so it is not followed.`
					: `The ${field} folder "${rel}" was not found.`,
			consequence: `The folder is skipped and named in the log; the plugin's other parts load.`,
		})
		return
	}
	let entries: import('node:fs').Dirent[]
	let passedOver: import('node:fs').Dirent[] = []
	try {
		const all = await readdir(resolved.dir, { withFileTypes: true })
		entries = all.filter((e) => e.name.endsWith('.md'))
		// The loader lists names that end in lowercase ".md" and nothing else.
		passedOver = all.filter(
			(e) => !e.isDirectory() && !e.name.endsWith('.md') && MARKDOWN_LOOKALIKE.test(e.name),
		)
	} catch (error) {
		c.add({
			level: 'error',
			part,
			file: MANIFEST_FILE,
			code: 'file-unreadable',
			message: `The ${field} folder "${rel}" could not be read: ${message(error)}`,
			consequence: 'The folder is skipped.',
		})
		return
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	passedOver.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	for (const entry of passedOver.slice(0, MAX_CHECKED_FILES_PER_FOLDER)) {
		const rel2 = posix(relative(root, join(resolved.dir, entry.name)))
		c.add({
			level: 'warning',
			part,
			file: rel2,
			code: 'file-ignored',
			message: `"${entry.name}" looks like a markdown file, but only names ending in lowercase ".md" are read, so it is not.`,
			consequence: `The loader passes it over without a word; rename it to end in ".md" to use it as ${field === 'commands' ? 'a command' : 'an agent'}.`,
		})
	}
	if (entries.length > MAX_CHECKED_FILES_PER_FOLDER) {
		c.add({
			level: 'warning',
			part,
			file: rel,
			code: 'entries-truncated',
			message: `The folder "${rel}" holds ${entries.length} markdown files; only the first ${MAX_CHECKED_FILES_PER_FOLDER} were checked.`,
			consequence: 'The loader reads them all.',
		})
		entries = entries.slice(0, MAX_CHECKED_FILES_PER_FOLDER)
	}
	for (const entry of entries) {
		const file = entry.name
		const abs = join(resolved.dir, file)
		const rel2 = posix(relative(root, abs))
		if (!entry.isFile()) {
			// The loader lists regular files only, so a link or folder named .md is passed over.
			c.add({
				level: 'warning',
				part,
				file: rel2,
				code: 'file-ignored',
				message: `"${file}" is a link or a folder, not a regular file, so it is not read.`,
				consequence: 'The loader passes it over without a word.',
			})
			continue
		}
		const read = await readInside(root, rel2)
		if (!read.ok) {
			const { code, text } = readProblem(
				read,
				field === 'commands' ? 'The command file' : 'The agent file',
				rel2,
			)
			c.add({
				level: read.kind === 'too-large' && field === 'commands' ? 'warning' : 'error',
				part: c.part(
					field === 'commands' ? 'command' : 'agent',
					`${pluginName}__${file.slice(0, -'.md'.length)}`,
					rel2,
				),
				file: rel2,
				code,
				message: text,
				consequence:
					field === 'commands'
						? 'The command cannot be used.'
						: 'The file is skipped and named in the log.',
			})
			continue
		}
		await each(file, read.text, read.abs)
	}
	dropPlaceholder()
}
