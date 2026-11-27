/**
 * `namzu skills add`: read a skill someone made (a `.zip`, a `.skill`, a lone
 * `.md`, or a folder), check it with the same rules `save_skill` uses, show what
 * it can run, and put it in the user's or the project's skills folder.
 *
 * Reading is separate from writing on purpose. {@link readSkillInput} turns an
 * input into a {@link PreparedSkill} in memory and refuses anything unsafe before
 * a byte is written. {@link installPrepared} then stages it, asks the loader what
 * it thinks of the staged copy, asks the person when the skill can run something
 * or would replace another, and only then moves it into place.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
	SKILL_FRONTMATTER_HOOK_EVENT_KEYS,
	SKILL_FRONTMATTER_KEYS,
	findInlineShell,
} from '@namzu/sdk'

import type { SkillsConfig } from '../config/schema.js'
import { readSkillHooks } from '../config/skill-hooks-reader.js'
import { ArchiveError, type ArchiveLimits, openArchive } from '../integrations/archive/zip.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { auditSkillInfo } from './audit.js'
import {
	InstallError,
	type InstallFsOps,
	REAL_FS_OPS,
	SKILL_INSTALL_RECORD,
	type SkillFile,
	digestFiles,
	stageSkill,
} from './install.js'
import { type SkillSaveScope, describeCollision, displayPath, planSkillTargets } from './save.js'
import {
	discoverSkillRoster,
	parseSkillMarkdown,
	projectSkillsDir,
	userSkillsDir,
} from './store.js'
import {
	SKILL_BODY_MAX_BYTES,
	SkillDraftError,
	suggestSkillName,
	validateSkillDescription,
	validateSkillName,
} from './validate.js'

export const SKILL_FILE_MAX_BYTES = 30 * 1024 * 1024
export const SKILL_ADD_MAX_INPUTS = 20

/** The shared zip reader's limits for a skill: smaller than a plugin's, and execute bits are handled here. */
export const SKILL_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 500,
	maxUnpackedBytes: 64 * 1024 * 1024,
	maxRatio: 100,
	allowExecutable: true,
	subject: 'skill',
}

export const TOO_LARGE_MESSAGE = 'Skill file is too large. Maximum size is 30 MB.'
export const WRONG_EXTENSION_MESSAGE =
	'Skill files must have a .skill, .zip, or .md file extension.'
export const MD_YAML_MESSAGE =
	'A .md file must contain the skill name and description formatted in YAML.'

/** `refused`: the input was unsafe (a link, a path that climbs out, a zip bomb). `failed`: anything else. */
export class SkillInputError extends Error {
	override readonly name = 'SkillInputError'
	constructor(
		readonly kind: 'refused' | 'failed',
		message: string,
	) {
		super(message)
	}
}

const failed = (message: string): SkillInputError => new SkillInputError('failed', message)
const refused = (message: string): SkillInputError => new SkillInputError('refused', message)

/** A skill read from an input, checked, and not yet written anywhere. */
export interface PreparedSkill {
	readonly name: string
	readonly description: string
	/** The final `SKILL.md` text (its name rewritten when `--name` asked for another). */
	readonly markdown: string
	/** Paths relative to the skill folder; includes `SKILL.md`. */
	readonly files: ReadonlyMap<string, SkillFile>
	readonly source: 'file' | 'folder' | 'create'
	/** The input's file or folder name. */
	readonly fileName: string
	readonly sha256: string
	/** Plain notes about what was kept, changed or left out. Also in the provenance record. */
	readonly findings: readonly string[]
	/** What the person is shown before a yes, when it is not empty. */
	readonly consent: readonly string[]
}

const READ_KEYS = new Set<string>([
	...SKILL_FRONTMATTER_KEYS,
	...SKILL_FRONTMATTER_HOOK_EVENT_KEYS,
	'argument-hint',
	'user-invocable',
])

const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'powershell', 'pwsh', 'cmd', 'exec'])

const oneLine = (text: string, max = 120): string => {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Set the `name:` line of a `SKILL.md` frontmatter (added when it has none). */
export function setFrontmatterName(markdown: string, name: string): string {
	const open = /^(﻿?\s*---[ \t]*\r?\n)/.exec(markdown)
	if (!open) return markdown
	const start = open[0].length
	const rest = markdown.slice(start)
	const close = /^---[ \t]*\r?$/m.exec(rest)
	const block = close ? rest.slice(0, close.index) : rest
	const eol = open[0].endsWith('\r\n') ? '\r\n' : '\n'
	const line = /^name[ \t]*:.*$/m
	const patched = line.test(block)
		? block.replace(line, () => `name: ${name}`)
		: `name: ${name}${eol}${block}`
	return markdown.slice(0, start) + patched + rest.slice(block.length)
}

function frontmatterKeys(markdown: string): string[] {
	const open = /^(﻿?\s*---[ \t]*\r?\n)/.exec(markdown)
	if (!open) return []
	const rest = markdown.slice(open[0].length)
	const close = /^---[ \t]*\r?$/m.exec(rest)
	const block = close ? rest.slice(0, close.index) : rest
	return [...block.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:/gm)].map((m) => m[1] as string)
}

function hookCommands(hooks: unknown): string[] {
	const out: string[] = []
	const walk = (value: unknown, depth: number): void => {
		if (depth > 8 || value === null || typeof value !== 'object') return
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1)
			return
		}
		for (const [key, item] of Object.entries(value)) {
			if (key === 'command' && typeof item === 'string') out.push(item)
			else walk(item, depth + 1)
		}
	}
	walk(hooks, 0)
	return out
}

function decodeUtf8(bytes: Buffer, what: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
	} catch {
		throw failed(`${what} is not valid UTF-8 text.`)
	}
}

interface BuildContext {
	readonly kind: 'markdown' | 'archive' | 'folder'
	readonly fileName: string
	/** The name to fall back to when SKILL.md carries none. */
	readonly fallbackName: string
	readonly sha256: string
	readonly nameOverride?: string
}

const isSkillFile = (path: string): boolean => basename(path).toLowerCase() === 'skill.md'

/** The shared pipeline: pick the one SKILL.md, check its fields, work out the consent facts. */
function buildPrepared(raw: ReadonlyMap<string, SkillFile>, ctx: BuildContext): PreparedSkill {
	const findings: string[] = []
	const candidates = [...raw.keys()].filter(isSkillFile)
	const what = ctx.kind === 'folder' ? 'The folder' : 'The file'
	if (candidates.length === 0) {
		throw failed(
			ctx.kind === 'folder'
				? 'The folder must include a SKILL.md file.'
				: 'A .zip or .skill file must include a SKILL.md file.',
		)
	}
	if (candidates.length > 1) {
		throw failed(
			`This file holds ${candidates.length} skills. Add them one at a time, or install it as a plugin.`,
		)
	}
	const skillPath = candidates[0] as string
	const segments = skillPath.split('/')
	if (segments.length > 2 || (ctx.kind === 'folder' && segments.length > 1)) {
		throw failed(
			`${what} must hold SKILL.md at its top, or inside one folder. Found it at ${skillPath}.`,
		)
	}
	const wrapper = segments.length === 2 ? (segments[0] as string) : undefined
	const prefix = wrapper === undefined ? '' : `${wrapper}/`
	const files = new Map<string, SkillFile>()
	let leftOut = 0
	for (const [path, file] of raw) {
		if (!path.startsWith(prefix)) {
			leftOut++
			continue
		}
		const rel = path.slice(prefix.length)
		if (rel === SKILL_INSTALL_RECORD) {
			findings.push(`${rel} in the file was ignored; Namzu writes its own.`)
			continue
		}
		if (path === skillPath) {
			files.set('SKILL.md', { bytes: file.bytes, executable: false })
			continue
		}
		const keep = file.executable && rel.startsWith('scripts/')
		if (file.executable && !keep) {
			findings.push(
				`${rel} had an execute bit; it was removed because only files under scripts/ keep it.`,
			)
		}
		files.set(rel, { bytes: file.bytes, executable: keep })
	}
	if (leftOut > 0) {
		findings.push(
			`${leftOut} ${leftOut === 1 ? 'file' : 'files'} outside the folder that holds SKILL.md ${leftOut === 1 ? 'was' : 'were'} left out.`,
		)
	}

	const original = decodeUtf8((files.get('SKILL.md') as SkillFile).bytes, 'SKILL.md')
	let parsed: ReturnType<typeof parseSkillMarkdown>
	try {
		parsed = parseSkillMarkdown(original, 'SKILL.md')
	} catch (error) {
		throw failed(
			`SKILL.md could not be read: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (ctx.kind === 'markdown' && (!/^\s*---/.test(original) || !parsed.description?.trim())) {
		throw failed(MD_YAML_MESSAGE)
	}
	if (parsed.description === undefined || parsed.description.trim() === '') {
		throw failed('SKILL.md needs a description in its frontmatter.')
	}

	const candidate = ctx.nameOverride ?? parsed.name ?? wrapper ?? ctx.fallbackName
	let name: string
	try {
		name = validateSkillName(candidate)
	} catch (error) {
		const suggestion = suggestSkillName(candidate)
		const base = `The skill name "${candidate.trim()}" cannot be used: ${
			error instanceof SkillDraftError ? error.message.replace(/^name "[^"]*" /, '') : String(error)
		}`
		throw failed(
			suggestion.length > 0 && suggestion !== candidate
				? `${base} Try "${suggestion}" (add --name ${suggestion}).`
				: base,
		)
	}
	let description: string
	try {
		description = validateSkillDescription(parsed.description, { rejectMarkup: true })
	} catch (error) {
		throw failed(capitalise(error instanceof Error ? error.message : String(error)))
	}
	const bodyBytes = Buffer.byteLength(parsed.body, 'utf8')
	if (parsed.body.trim().length === 0)
		throw failed('SKILL.md has no instructions after its frontmatter.')
	if (bodyBytes > SKILL_BODY_MAX_BYTES) {
		throw failed(`The instructions are ${bodyBytes} bytes; at most ${SKILL_BODY_MAX_BYTES}.`)
	}

	const markdown = parsed.name === name ? original : setFrontmatterName(original, name)
	if (parsed.name !== name) {
		findings.push(
			parsed.name === undefined
				? `The skill is named "${name}" from ${ctx.nameOverride !== undefined ? '--name' : 'the file name'}.`
				: `The skill is named "${name}" (--name); the file said "${parsed.name}".`,
		)
	}
	files.set('SKILL.md', { bytes: Buffer.from(markdown, 'utf8'), executable: false })

	const unknown = frontmatterKeys(original).filter((key) => !READ_KEYS.has(key))
	if (unknown.length > 0) {
		findings.push(
			`Frontmatter keys Namzu does not read were kept: ${[...new Set(unknown)].join(', ')}.`,
		)
	}

	// What the person is told before the skill can be used.
	const consent: string[] = []
	const inline = findInlineShell(parsed.body).map((m) => oneLine(m.command, 80))
	if (inline.length > 0) {
		consent.push(
			`Runs commands: ${inline.slice(0, 5).join('; ')}${inline.length > 5 ? `; and ${inline.length - 5} more` : ''}`,
		)
	}
	if (parsed.hooksSource !== undefined) {
		const commands = hookCommands(readSkillHooks(parsed.hooksSource, 'SKILL.md').hooks).map((c) =>
			oneLine(c, 80),
		)
		consent.push(
			commands.length > 0
				? `Runs commands from its hooks while it is in use: ${commands.slice(0, 5).join('; ')}${commands.length > 5 ? `; and ${commands.length - 5} more` : ''}`
				: 'Carries hooks that attach while it is in use.',
		)
	}
	const shell = [...(parsed.allowedTools ?? '').matchAll(/([A-Za-z_][\w-]*)(\([^)]*\))?/g)]
		.filter((m) => SHELL_TOOLS.has((m[1] as string).toLowerCase()))
		.map((m) => m[0])
	if (shell.length > 0) consent.push(`Pre-approves while this skill runs: ${shell.join(', ')}`)
	const scripts = [...files.entries()]
		.filter(([rel, file]) => rel.startsWith('scripts/') || file.executable)
		.map(([rel]) => rel)
		.sort()
	if (scripts.length > 0) {
		consent.push(
			`Ships scripts: ${scripts.slice(0, 5).join(', ')}${scripts.length > 5 ? `, and ${scripts.length - 5} more` : ''}`,
		)
	}

	return {
		name,
		description,
		markdown,
		files,
		source: ctx.kind === 'folder' ? 'folder' : 'file',
		fileName: ctx.fileName,
		sha256: ctx.sha256,
		findings,
		consent,
	}
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

function readFolder(dir: string): Map<string, SkillFile> {
	const files = new Map<string, SkillFile>()
	let total = 0
	const walk = (abs: string, rel: string): void => {
		for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name === '__MACOSX') continue
			if (entry.name === 'node_modules') continue
			const path = join(abs, entry.name)
			const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
			const stat = lstatSync(path)
			if (stat.isSymbolicLink()) {
				throw refused(`${relPath} is a link. Skills are added as plain files and folders only.`)
			}
			if (stat.isDirectory()) {
				walk(path, relPath)
				continue
			}
			if (!stat.isFile()) throw refused(`${relPath} is not a regular file.`)
			if (stat.size > SKILL_FILE_MAX_BYTES) throw failed(TOO_LARGE_MESSAGE)
			total += stat.size
			if (files.size >= SKILL_ARCHIVE_LIMITS.maxEntries) {
				throw refused(`The folder has more than ${SKILL_ARCHIVE_LIMITS.maxEntries} files.`)
			}
			if (total > SKILL_ARCHIVE_LIMITS.maxUnpackedBytes) {
				throw refused('The folder holds more than 64 MiB.')
			}
			files.set(relPath, { bytes: readFileSync(path), executable: (stat.mode & 0o111) !== 0 })
		}
	}
	walk(dir, '')
	return files
}

/** Read one input into a checked {@link PreparedSkill}. Writes nothing. */
export function readSkillInput(
	input: string,
	options: { readonly name?: string } = {},
): PreparedSkill {
	let stat: ReturnType<typeof statSync>
	try {
		stat = statSync(input)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		throw failed(
			code === 'ENOENT'
				? `${input} does not exist.`
				: `${input} could not be read (${code ?? 'error'}).`,
		)
	}
	const nameOverride = options.name === undefined ? {} : { nameOverride: options.name }
	if (stat.isDirectory()) {
		let files: Map<string, SkillFile>
		try {
			files = readFolder(input)
		} catch (error) {
			if (error instanceof SkillInputError) throw error
			throw failed(
				`${input} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return buildPrepared(files, {
			kind: 'folder',
			fileName: basename(input),
			fallbackName: basename(input),
			sha256: digestFiles(files),
			...nameOverride,
		})
	}
	if (!stat.isFile()) throw failed(`${input} is not a file or a folder.`)
	const extension = extname(input).toLowerCase()
	if (extension !== '.zip' && extension !== '.skill' && extension !== '.md') {
		throw failed(WRONG_EXTENSION_MESSAGE)
	}
	if (stat.size > SKILL_FILE_MAX_BYTES) throw failed(TOO_LARGE_MESSAGE)
	let bytes: Buffer
	try {
		bytes = readFileSync(input)
	} catch (error) {
		throw failed(
			`${input} could not be read: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const sha256 = createHash('sha256').update(bytes).digest('hex')
	const fileName = basename(input)
	const stem = basename(input, extname(input))
	if (extension === '.md') {
		return buildPrepared(new Map([['SKILL.md', { bytes, executable: false }]]), {
			kind: 'markdown',
			fileName,
			fallbackName: stem,
			sha256,
			...nameOverride,
		})
	}
	let opened: Map<string, SkillFile>
	try {
		opened = openArchive(bytes, SKILL_ARCHIVE_LIMITS)
	} catch (error) {
		if (error instanceof ArchiveError) {
			// A file that is not a zip at all is a bad input; every other check is about safety.
			throw error.check === 'zip' ? failed(error.message) : refused(error.message)
		}
		throw failed(error instanceof Error ? error.message : String(error))
	}
	const files = new Map<string, SkillFile>()
	for (const [path, file] of opened) {
		if (path.startsWith('__MACOSX/') || basename(path) === '.DS_Store') continue
		files.set(path, { bytes: file.bytes, executable: file.executable })
	}
	return buildPrepared(files, {
		kind: 'archive',
		fileName,
		fallbackName: stem,
		sha256,
		...nameOverride,
	})
}

export type SkillOutcomeStatus =
	| 'added'
	| 'replaced'
	| 'failed'
	| 'refused'
	| 'needs-consent'
	| 'declined'

/** What happened to one input. The JSON output is a list of these. */
export interface SkillOutcome {
	readonly input: string
	readonly status: SkillOutcomeStatus
	readonly message: string
	readonly name?: string
	readonly scope?: SkillSaveScope
	/** The skill's `SKILL.md` once installed. */
	readonly path?: string
	readonly files?: number
	/** Where the replaced folder went. */
	readonly backup?: string
	/** What was kept, changed or left out. */
	readonly findings: readonly string[]
	/** Other skills of the same name in other tiers. */
	readonly notes: readonly string[]
	/** What the person is asked to accept (`needs-consent`, `declined`). */
	readonly preview?: readonly string[]
}

export interface InstallContext {
	readonly scope: SkillSaveScope
	readonly cwd: string
	/** The folder paths are shown relative to, when it is not `cwd`. */
	readonly displayCwd?: string
	readonly home?: string
	readonly config?: SkillsConfig
	/** `--yes`: accept the consent shown and a replacement. */
	readonly yes: boolean
	/** `--replace`: a skill of the same name in the target tier may be replaced. */
	readonly replace: boolean
	/** Ask the person; absent when there is no terminal to ask at. */
	readonly ask?: (question: string, preview: readonly string[]) => Promise<boolean>
	readonly now?: () => Date
	readonly ops?: InstallFsOps
}

/** `$NAMZU_HOME/backups/skills`. */
export function skillBackupsDir(home?: string): string {
	return join(namzuHomePath(home), 'backups', 'skills')
}

/** Where a skill goes: the user's folder, or the project's. */
export function skillsFolderFor(
	scope: SkillSaveScope,
	ctx: Pick<InstallContext, 'cwd' | 'home'>,
): {
	readonly dir: string
	readonly anchor: string
} {
	return scope === 'user'
		? { dir: userSkillsDir(ctx.home), anchor: userSkillsDir(ctx.home) }
		: { dir: projectSkillsDir(ctx.cwd), anchor: ctx.cwd }
}

const place = (scope: SkillSaveScope): string =>
	scope === 'user' ? 'your skills' : "this project's skills"

const filesWord = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/** Stage, check, ask when needed, and move into place. Never throws for a problem with the skill. */
export async function installPrepared(
	prepared: PreparedSkill,
	input: string,
	ctx: InstallContext,
): Promise<SkillOutcome> {
	const { name } = prepared
	const { scope } = ctx
	const base = { input, name, scope, findings: [...prepared.findings], notes: [] as string[] }
	const roster = discoverSkillRoster({
		cwd: ctx.cwd,
		...(ctx.home !== undefined ? { home: ctx.home } : {}),
		config: { ...(ctx.config ?? {}), builtin: true, disabled: [] },
	})
	if ([...roster.skills, ...roster.shadowed].some((s) => s.name === name && s.tier === 'system')) {
		return {
			...base,
			status: 'failed',
			message: `"${name}" is the name of a built-in skill, so it cannot be used.`,
		}
	}
	const targets = planSkillTargets(name, {
		cwd: ctx.cwd,
		...(ctx.home !== undefined ? { home: ctx.home } : {}),
		...(ctx.config ? { config: ctx.config } : {}),
	})
	const target = targets[scope]
	const notes = target.collisions
		.filter((c) => !c.overwrite)
		.map((c) => describeCollision(c, ctx.displayCwd ?? ctx.cwd))
	const folder = skillsFolderFor(scope, ctx)
	const now = ctx.now ?? (() => new Date())
	const record = {
		version: 1,
		source: prepared.source,
		fileName: prepared.fileName,
		sha256: prepared.sha256,
		installedAt: now().toISOString(),
		findings: prepared.findings,
		files: [...prepared.files.keys()].sort(),
	}
	let staged: ReturnType<typeof stageSkill>
	try {
		staged = stageSkill(
			{
				skillsDir: folder.dir,
				anchor: folder.anchor,
				name,
				files: prepared.files,
				record,
				backupsDir: skillBackupsDir(ctx.home),
				now: () => now().getTime(),
			},
			ctx.ops ?? REAL_FS_OPS,
		)
	} catch (error) {
		return { ...base, notes, status: 'refused', message: capitalise(errorText(error)) }
	}
	try {
		// The loader the model uses reads the staged copy before anything is installed.
		const parsed = parseSkillMarkdown(prepared.markdown, 'SKILL.md')
		const finding = await auditSkillInfo({
			name,
			description: prepared.description,
			path: join(staged.dir, 'SKILL.md'),
			source: scope,
			tier: scope,
			...(parsed.hooksSource !== undefined ? { hooksSource: parsed.hooksSource } : {}),
		})
		if (finding.status === 'invalid') {
			return {
				...base,
				notes,
				status: 'failed',
				message: `The skill would not load: ${finding.reason ?? 'unknown reason'}`,
			}
		}
		const hookNotes = (finding.hookProblems ?? []).map(
			(p) => `Hooks ${p.severity === 'problem' ? 'not loaded' : 'note'}: ${p.text}`,
		)
		const findings = [...base.findings, ...hookNotes]
		const preview = [...prepared.consent, ...hookNotes]

		const needsReplace = staged.exists && !ctx.replace && !ctx.yes
		const needsRun = prepared.consent.length > 0 && !ctx.yes
		if (needsReplace || needsRun) {
			const question = [
				needsRun ? `Add skill "${name}" to ${place(scope)}?` : '',
				needsReplace
					? `This replaces the skill "${name}" already in ${place(scope)}; a copy is kept.`
					: '',
			]
				.filter(Boolean)
				.join(' ')
			const shown = needsReplace
				? [
						...preview,
						`Replaces ${displayPath(staged.target, ctx.displayCwd ?? ctx.cwd, ctx.home)}`,
					]
				: preview
			if (ctx.ask === undefined) {
				return {
					...base,
					notes,
					findings,
					status: 'needs-consent',
					preview: shown,
					message: `${question} Nobody can be asked here: run it again with ${needsRun ? '--yes' : '--replace'} to go ahead.`,
				}
			}
			if (!(await ctx.ask(question, shown))) {
				return {
					...base,
					notes,
					findings,
					status: 'declined',
					preview: shown,
					message: 'Nothing was added.',
				}
			}
		}

		let result: { readonly backup?: string }
		try {
			result = staged.commit(staged.exists)
		} catch (error) {
			return {
				...base,
				notes,
				findings,
				status: 'failed',
				message: capitalise(errorText(error)),
				...(error instanceof InstallError && error.orphanBackup
					? { backup: error.orphanBackup }
					: {}),
			}
		}
		const count = prepared.files.size
		const path = join(staged.target, 'SKILL.md')
		const backup = result.backup
		return {
			...base,
			notes,
			findings,
			status: backup === undefined ? 'added' : 'replaced',
			path,
			files: count,
			...(backup !== undefined ? { backup } : {}),
			message:
				backup === undefined
					? `Added skill "${name}" to ${place(scope)} (${filesWord(count)}). It is available from your next message.`
					: `Replaced skill "${name}" in ${place(scope)} (${filesWord(count)}). The old copy is in ${displayPath(backup, ctx.displayCwd ?? ctx.cwd, ctx.home)}. It is available from your next message.`,
		}
	} finally {
		staged.discard()
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Read one input and install it. */
export async function addSkillInput(
	input: string,
	options: { readonly name?: string },
	ctx: InstallContext,
): Promise<SkillOutcome> {
	let prepared: PreparedSkill
	try {
		prepared = readSkillInput(input, options)
	} catch (error) {
		if (error instanceof SkillInputError) {
			return { input, status: error.kind, message: error.message, findings: [], notes: [] }
		}
		return { input, status: 'failed', message: errorText(error), findings: [], notes: [] }
	}
	return installPrepared(prepared, input, ctx)
}
