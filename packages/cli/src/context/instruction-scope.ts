/**
 * One directory's worth of instructions, and the person's own.
 *
 * `project.ts` knows how to read ONE file safely. This module decides which
 * files make up a scope and in what order, because the order is the override
 * semantics: later text wins, so what is nearer the work comes last.
 *
 * ## A project directory contributes, in this order
 *
 * 1. its `AGENTS.md`,
 * 2. every `*.md` under its `.namzu/rules/`, sorted by path,
 * 3. its `AGENTS.local.md` — the person's private notes for this checkout,
 *    meant to stay out of version control, so it comes last and has the final
 *    word inside the directory.
 *
 * ## The person's own file
 *
 * `AGENTS.md` and `rules/*.md` under the Namzu home apply to every project
 * and come before everything else, so a project can always say something more
 * specific.
 *
 * ## `@path` inside a file
 *
 * A line may pull in another file by naming it as `@path`: relative to the
 * file that names it, or `~/` or absolute. The pulled-in file becomes its own
 * entry right after the one that named it, up to five levels deep, and each
 * file is taken once however many ways it is reached — which is also what
 * keeps a file that includes itself from looping. Mentions inside code are
 * text, not includes. A path that leaves the allowed folders is refused and
 * reported, never read: an instruction file must not be able to send the
 * contents of any file on the machine to the model.
 *
 * ## A conditional rule
 *
 * A rules file whose front matter lists `paths` applies only once the session
 * has touched a file matching one of them. `**` alone means "always".
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { resolveNamzuHome } from '@namzu/sdk'
import { parse as parseYaml } from 'yaml'

import { matchesAnyGlob } from './instruction-glob.js'
import {
	INSTRUCTIONS_FILENAME,
	type ProjectInstructionFile,
	type ProjectInstructionKind,
	type ProjectInstructions,
	type SkippedInstructionFile,
	composeProjectInstructionsPrompt,
	instructionSearchPath,
	isContainedBy,
	readInstructionAt,
} from './project.js'

/** The private, uncommitted companion of `AGENTS.md`. */
export const LOCAL_INSTRUCTIONS_FILENAME = 'AGENTS.local.md'

/** Where a directory keeps rule files, relative to the directory. */
export const RULES_DIRECTORY = join('.namzu', 'rules')

/** How many `@path` levels are followed below the file that started them. */
export const MAX_IMPORT_DEPTH = 5

/** A rules folder past this many files is cut, and says so. */
export const MAX_RULE_FILES = 200

/** Extensions an `@path` may name; anything else is not an instruction file. */
const IMPORTABLE_EXTENSIONS = new Set([
	'.md',
	'.markdown',
	'.mdx',
	'.txt',
	'.text',
	'.json',
	'.yaml',
	'.yml',
	'.toml',
])

export interface ScopeInstructions {
	readonly files: readonly ProjectInstructionFile[]
	readonly skipped: readonly SkippedInstructionFile[]
}

export interface ScopeLoadOptions {
	/** Folders a file (or a link's target, or an import) may live in. */
	readonly roots: readonly string[]
	/** Files the session has read or changed; they switch conditional rules on. */
	readonly touched?: readonly string[]
	/** The folder conditional `paths` are relative to. Defaults to the scope. */
	readonly matchBase?: string
}

interface Collector {
	readonly roots: readonly string[]
	readonly touched: readonly string[]
	readonly matchBase: string
	readonly processed: Set<string>
	readonly files: ProjectInstructionFile[]
	readonly skipped: SkippedInstructionFile[]
}

function realKey(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

interface RuleHeader {
	readonly body: string
	readonly globs: readonly string[] | null
}

/** Split a rule's front matter from its text. Unreadable front matter is left in place. */
function ruleHeader(text: string): RuleHeader {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
	if (!match) return { body: text, globs: null }
	let data: unknown
	try {
		data = parseYaml(match[1] ?? '')
	} catch {
		return { body: text, globs: null }
	}
	const body = text.slice(match[0].length).trim()
	const raw = typeof data === 'object' && data !== null ? (data as { paths?: unknown }).paths : null
	const list = (typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [])
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	if (list.length === 0 || list.some((entry) => entry === '**' || entry === '**/*')) {
		return { body, globs: null }
	}
	return { body, globs: list }
}

/** `@path` mentions outside code, in the order they appear. */
export function extractImportTokens(text: string): string[] {
	const tokens: string[] = []
	let fence: string | null = null
	for (const line of text.split('\n')) {
		const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
		if (marker) {
			if (fence === null) fence = marker.charAt(0)
			else if (marker.startsWith(fence)) fence = null
			continue
		}
		if (fence !== null) continue
		const plain = line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))
		for (const found of plain.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
			if (found[1]) tokens.push(found[1])
		}
	}
	return tokens
}

function resolveImport(token: string, importer: string): string | null {
	const cleaned = token.replace(/\\ /g, ' ').replace(/#.*$/, '')
	if (cleaned.length === 0) return null
	let path: string
	if (cleaned.startsWith('~/')) path = join(homedir(), cleaned.slice(2))
	else if (cleaned.startsWith('/')) path = cleaned
	else path = resolve(dirname(importer), cleaned)
	return IMPORTABLE_EXTENSIONS.has(extname(path).toLowerCase()) ? path : null
}

function followImports(collector: Collector, parent: ProjectInstructionFile, depth: number): void {
	if (depth > MAX_IMPORT_DEPTH) return
	for (const token of extractImportTokens(parent.text)) {
		const candidate = resolveImport(token, parent.path)
		if (candidate === null) continue
		let target: string
		try {
			target = realpathSync(candidate)
		} catch {
			// Not there: an `@name` that is not a file is just a mention.
			continue
		}
		let isFile = false
		try {
			isFile = lstatSync(target).isFile()
		} catch {
			continue
		}
		if (!isFile) continue
		if (!isContainedBy(target, collector.roots)) {
			collector.skipped.push({
				path: candidate,
				reason: `it is included by ${parent.path} but lies outside the folders an instruction file may include from`,
			})
			continue
		}
		if (collector.processed.has(target)) continue
		collector.processed.add(target)
		const outcome = readInstructionAt(candidate, collector.roots)
		if (outcome.kind === 'skipped') {
			collector.skipped.push(outcome.file)
			continue
		}
		if (outcome.kind === 'absent') continue
		const imported: ProjectInstructionFile = {
			...outcome.file,
			kind: 'import',
			importedBy: parent.path,
			...(parent.scopeDir ? { scopeDir: parent.scopeDir } : {}),
		}
		collector.files.push(imported)
		followImports(collector, imported, depth + 1)
	}
}

function addTopLevel(
	collector: Collector,
	path: string,
	kind: ProjectInstructionKind,
	scopeDir: string | undefined,
	rule: boolean,
): void {
	const outcome = readInstructionAt(path, collector.roots)
	if (outcome.kind === 'skipped') {
		collector.skipped.push(outcome.file)
		return
	}
	if (outcome.kind === 'absent') return
	const key = realKey(path)
	if (collector.processed.has(key)) return
	let file: ProjectInstructionFile = {
		...outcome.file,
		kind,
		...(scopeDir ? { scopeDir } : {}),
	}
	if (rule) {
		const header = ruleHeader(file.text)
		if (header.globs !== null) {
			const active = collector.touched.some((touched) => {
				const rel = relative(collector.matchBase, touched)
				return (
					rel !== '' &&
					rel !== '..' &&
					!rel.startsWith(`..${sep}`) &&
					matchesAnyGlob(rel.split(sep).join('/'), header.globs ?? [])
				)
			})
			if (!active) return
		}
		if (header.body.length === 0) return
		file = { ...file, text: header.body }
	}
	collector.processed.add(key)
	collector.files.push(file)
	followImports(collector, file, 1)
}

function listRuleFiles(directory: string, collector: Collector): string[] {
	const found: string[] = []
	const walk = (dir: string, depth: number): void => {
		if (depth > 8) return
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const name of [...entries].sort()) {
			const path = join(dir, name)
			let stat: ReturnType<typeof lstatSync>
			try {
				stat = lstatSync(path)
			} catch {
				continue
			}
			// A linked folder is not followed: it can loop, and it can lead out.
			if (stat.isDirectory()) walk(path, depth + 1)
			else if ((stat.isFile() || stat.isSymbolicLink()) && name.toLowerCase().endsWith('.md'))
				found.push(path)
		}
	}
	walk(directory, 0)
	if (found.length > MAX_RULE_FILES) {
		collector.skipped.push({
			path: directory,
			reason: `it holds more than ${MAX_RULE_FILES} rule files, and only the first ${MAX_RULE_FILES} were read`,
		})
		return found.slice(0, MAX_RULE_FILES)
	}
	return found
}

function newCollector(options: ScopeLoadOptions, matchBase: string): Collector {
	return {
		roots: options.roots,
		touched: options.touched ?? [],
		matchBase,
		processed: new Set(),
		files: [],
		skipped: [],
	}
}

/** The files one project directory contributes, in order. */
export function loadScopeInstructions(
	directory: string,
	options: ScopeLoadOptions,
): ScopeInstructions {
	const collector = newCollector(options, options.matchBase ?? directory)
	addTopLevel(collector, join(directory, INSTRUCTIONS_FILENAME), 'project', directory, false)
	for (const rule of listRuleFiles(join(directory, RULES_DIRECTORY), collector)) {
		addTopLevel(collector, rule, 'rule', directory, true)
	}
	addTopLevel(collector, join(directory, LOCAL_INSTRUCTIONS_FILENAME), 'local', directory, false)
	return { files: collector.files, skipped: collector.skipped }
}

/** The person's own instructions, from the Namzu home. */
export function loadUserInstructions(
	namzuHome: string,
	options: Omit<ScopeLoadOptions, 'roots'> = {},
): ScopeInstructions {
	// A person's own file may name notes anywhere in their home folder: they
	// wrote it, and they could as easily have pasted the notes in.
	const roots = [namzuHome, homedir()]
	const collector = newCollector({ ...options, roots }, options.matchBase ?? namzuHome)
	addTopLevel(collector, join(namzuHome, INSTRUCTIONS_FILENAME), 'user', undefined, false)
	for (const rule of listRuleFiles(join(namzuHome, 'rules'), collector)) {
		addTopLevel(collector, rule, 'user', undefined, true)
	}
	return { files: collector.files, skipped: collector.skipped }
}

export interface LoadProjectInstructionsOptions {
	/** The Namzu home holding the person's own file. `null` loads none. */
	readonly userHome?: string | null
	/** Files the session has touched, for conditional rules. */
	readonly touched?: readonly string[]
}

/** The Namzu home, or `null` when none can be resolved. */
export function userInstructionHome(): string | null {
	try {
		return resolveNamzuHome()
	} catch {
		return null
	}
}

/**
 * Walk, read, compose: the person's own file first, then each directory from
 * the repository root down to `cwd`.
 */
export function loadProjectInstructions(
	cwd: string,
	options: LoadProjectInstructionsOptions = {},
): ProjectInstructions {
	const searchPath = instructionSearchPath(cwd)
	const searchRoot = searchPath[0] ?? resolve(cwd)
	const files: ProjectInstructionFile[] = []
	const skipped: SkippedInstructionFile[] = []
	const userHome = options.userHome === undefined ? userInstructionHome() : options.userHome
	const touched = options.touched ?? []
	if (userHome !== null) {
		const user = loadUserInstructions(userHome, { touched, matchBase: searchRoot })
		files.push(...user.files)
		skipped.push(...user.skipped)
	}
	for (const dir of searchPath) {
		const scope = loadScopeInstructions(dir, { roots: [searchRoot], touched })
		files.push(...scope.files)
		skipped.push(...scope.skipped)
	}
	return { files, skipped, prompt: composeProjectInstructionsPrompt(files) }
}
