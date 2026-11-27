/**
 * The Customize page's skill actions over the desktop host: stage what the person chose, show what
 * it does, install it, make one from a form, take one out. Every rule about a skill lives in
 * `skills/` (`readSkillInput`, `installPrepared`, `createSkill`, `removeSkill`); this file only
 * validates the request, keeps what was read in memory between "show" and "yes", and maps the
 * outcomes to the shapes `shared/customize-protocol.ts` reads.
 *
 * A stage never touches the disk. It lives in this process for ten minutes (at most four), and
 * `install` recomputes its digest before writing, so the renderer can only install what the person
 * was shown.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { readSkillHooks } from '../config/skill-hooks-reader.js'
import { namzuHomePath } from '../integrations/state/home.js'
import {
	type PreparedSkill,
	SKILL_ADD_MAX_INPUTS,
	SKILL_FILE_MAX_BYTES,
	SkillInputError,
	installPrepared,
	readSkillInput,
	skillsFolderFor,
} from '../skills/add.js'
import { createSkill } from '../skills/create.js'
import { digestFiles } from '../skills/install.js'
import { removeSkill } from '../skills/remove.js'
import { type SkillSaveScope, planSkillTargets } from '../skills/save.js'
import { parseSkillMarkdown } from '../skills/store.js'
import {
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_NAME_MAX_CHARS,
} from '../skills/validate.js'

export const SKILL_STAGE_TTL_MS = 10 * 60 * 1000
export const SKILL_STAGE_MAX = 4
export const SKILL_PATH_MAX_CHARS = 4096
const FINDINGS_MAX = 20
const LINE_MAX = 300

export const STAGE_CHANGED_MESSAGE = 'What it does changed. Read it again.'
export const STAGE_GONE_MESSAGE = 'This was shown a while ago. Choose the file again.'
export const SKILL_PAL_MESSAGE = 'Pals do not change the host skills.'
export const SKILL_TRUST_MESSAGE = 'Trust this folder first.'
export const LOADS_NEXT_NOTE = 'It loads in new conversations.'

export interface SkillStageItem {
	fileName: string
	kind: 'file' | 'folder'
	name?: string
	description?: string
	files?: number
	bytes?: number
	findings: string[]
	grants: string[]
	scripts: string[]
	collides?: SkillSaveScope[]
	error?: string
}

interface StagedItem {
	readonly prepared?: PreparedSkill
	readonly digest: string
}

interface Stage {
	readonly items: readonly StagedItem[]
	readonly expiresAt: number
	readonly digest: string
}

export interface SkillActionDeps {
	/** The project folder this host serves. */
	readonly cwd: string
	/** True when the host serves a Pal workspace. */
	readonly pal: () => boolean
	readonly isTrusted: (cwd: string) => boolean
	/** The OS home folder (tests); absent means `NAMZU_HOME` and the real home. */
	readonly home?: string
	readonly now?: () => number
}

const line = (text: string): string =>
	text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text

function exactKeys(
	params: unknown,
	allowed: readonly string[],
	required: readonly string[],
	what: string,
) {
	if (!params || typeof params !== 'object' || Array.isArray(params))
		throw new Error(`Invalid ${what} request.`)
	const record = params as Record<string, unknown>
	if (Object.keys(record).some((key) => !allowed.includes(key)))
		throw new Error(`Invalid ${what} request.`)
	for (const key of required)
		if (record[key] === undefined) throw new Error(`Invalid ${what} request.`)
	return record
}

function field(record: Record<string, unknown>, key: string, max: number): string {
	const value = record[key]
	if (
		typeof value !== 'string' ||
		value.trim() === '' ||
		value.length > max ||
		value.includes('\0')
	)
		throw new Error(`Invalid ${key}.`)
	return value
}

function scopeOf(record: Record<string, unknown>, key = 'scope'): SkillSaveScope {
	const value = record[key]
	if (value !== 'user' && value !== 'project') throw new Error(`Invalid ${key}.`)
	return value
}

function nameList(value: unknown, key: string): string[] {
	if (value === undefined) return []
	if (
		!Array.isArray(value) ||
		value.length > SKILL_ADD_MAX_INPUTS ||
		value.some((v) => typeof v !== 'string' || v === '' || v.length > SKILL_NAME_MAX_CHARS)
	)
		throw new Error(`Invalid ${key}.`)
	return [...new Set(value as string[])]
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

function stageDigest(items: readonly StagedItem[]): string {
	const hash = createHash('sha256')
	for (const item of items) hash.update(`${item.digest}\n`)
	return hash.digest('hex')
}

function itemDigest(prepared: PreparedSkill): string {
	return createHash('sha256')
		.update(`${prepared.name}\0${digestFiles(prepared.files)}\0${prepared.consent.join('\n')}`)
		.digest('hex')
}

/** What the loader would say about the hooks of a skill, read from its text: nothing is written. */
function hookNotes(prepared: PreparedSkill): string[] {
	try {
		const parsed = parseSkillMarkdown(prepared.markdown, 'SKILL.md')
		if (parsed.hooksSource === undefined) return []
		return readSkillHooks(parsed.hooksSource, `skill ${prepared.name}`).problems.map(
			(p) => `Hooks ${p.severity === 'problem' ? 'not loaded' : 'note'}: ${p.event} ${p.message}`,
		)
	} catch {
		return []
	}
}

export function createDesktopSkillActions(deps: SkillActionDeps) {
	const now = deps.now ?? (() => Date.now())
	const stages = new Map<string, Stage>()

	const guard = (scope?: SkillSaveScope): void => {
		if (deps.pal()) throw new Error(SKILL_PAL_MESSAGE)
		if (scope === 'project' && !deps.isTrusted(deps.cwd)) throw new Error(SKILL_TRUST_MESSAGE)
	}
	/** The folder collisions and the roster are read from: an untrusted folder's own skills are not. */
	const effectiveCwd = (): string =>
		deps.isTrusted(deps.cwd) ? deps.cwd : namzuHomePath(deps.home)
	const home = deps.home !== undefined ? { home: deps.home } : {}
	const prune = (): void => {
		const at = now()
		for (const [id, stage] of stages) if (stage.expiresAt <= at) stages.delete(id)
	}
	const exists = (scope: SkillSaveScope, name: string): boolean => {
		try {
			lstatSync(`${skillsFolderFor(scope, { cwd: effectiveCwd(), ...home }).dir}/${name}`)
			return true
		} catch {
			return false
		}
	}
	const projectOpen = (): boolean => deps.isTrusted(deps.cwd)

	const stageOne = (path: string): { item: SkillStageItem; staged: StagedItem } => {
		const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path
		const base = {
			fileName: line(fileName),
			findings: [],
			grants: [],
			scripts: [],
		}
		const fail = (kind: 'file' | 'folder', error: string) => ({
			item: { ...base, kind, error: line(error) } as SkillStageItem,
			staged: {
				digest: createHash('sha256').update(`error\0${path}\0${error}`).digest('hex'),
			},
		})
		if (!isAbsolute(path) || path.includes('\0') || path.length > SKILL_PATH_MAX_CHARS)
			return fail('file', 'That path cannot be used.')
		let kind: 'file' | 'folder'
		try {
			const stat = lstatSync(path)
			if (stat.isSymbolicLink())
				return fail(
					'file',
					`${fileName} is a link. Skills are added as plain files and folders only.`,
				)
			if (stat.isDirectory()) kind = 'folder'
			else if (stat.isFile()) {
				kind = 'file'
				if (stat.size > SKILL_FILE_MAX_BYTES)
					return fail(kind, 'Skill file is too large. Maximum size is 30 MB.')
			} else return fail('file', `${fileName} is not a file or a folder.`)
		} catch {
			return fail('file', `${fileName} could not be read.`)
		}
		let prepared: PreparedSkill
		try {
			prepared = readSkillInput(path)
		} catch (error) {
			return fail(kind, error instanceof SkillInputError ? error.message : errorText(error))
		}
		const scripts = [...prepared.files.entries()]
			.filter(([rel, file]) => rel.startsWith('scripts/') || file.executable)
			.map(([rel]) => rel)
			.sort()
		const collides: SkillSaveScope[] = []
		const targets = planSkillTargets(prepared.name, {
			cwd: effectiveCwd(),
			...home,
		})
		if (targets.user.collisions.some((c) => c.overwrite)) collides.push('user')
		if (projectOpen() && targets.project.collisions.some((c) => c.overwrite))
			collides.push('project')
		let bytes = 0
		for (const file of prepared.files.values()) bytes += file.bytes.length
		return {
			item: {
				fileName: line(fileName),
				kind,
				name: prepared.name,
				description: prepared.description.slice(0, SKILL_DESCRIPTION_MAX_CHARS),
				files: prepared.files.size,
				bytes,
				findings: [...prepared.findings, ...hookNotes(prepared)].slice(0, FINDINGS_MAX).map(line),
				grants: prepared.consent
					.filter((c) => !c.startsWith('Ships scripts:'))
					.slice(0, FINDINGS_MAX)
					.map(line),
				scripts: scripts.slice(0, 50),
				...(collides.length > 0 ? { collides } : {}),
			},
			staged: { prepared, digest: itemDigest(prepared) },
		}
	}

	const methods = {
		/** Reads the chosen files and folders, checks them, says what each would do. Writes nothing. */
		'namzu/skills/stage': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['paths'], ['paths'], 'skill stage')
			const paths = record.paths
			if (
				!Array.isArray(paths) ||
				paths.length < 1 ||
				paths.length > SKILL_ADD_MAX_INPUTS ||
				paths.some((p) => typeof p !== 'string')
			)
				throw new Error('Choose between 1 and 20 skills.')
			prune()
			const unique = [...new Set(paths as string[])]
			const results = unique.map(stageOne)
			while (stages.size >= SKILL_STAGE_MAX) {
				const oldest = stages.keys().next().value
				if (oldest === undefined) break
				stages.delete(oldest)
			}
			const stageId = randomUUID()
			const items = results.map((r) => r.staged)
			const expiresAt = now() + SKILL_STAGE_TTL_MS
			stages.set(stageId, { items, expiresAt, digest: stageDigest(items) })
			return {
				stageId,
				items: results.map((r) => r.item),
				expiresAt: new Date(expiresAt).toISOString(),
			}
		},
		/** Writes the staged items the person said yes to. Items are independent. */
		'namzu/skills/install': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['stageId', 'scope', 'replace', 'accept'],
				['stageId', 'scope'],
				'skill install',
			)
			const stageId = field(record, 'stageId', 100)
			const scope = scopeOf(record)
			const replace = nameList(record.replace, 'replace')
			const accept = nameList(record.accept, 'accept')
			guard(scope)
			prune()
			const stage = stages.get(stageId)
			if (!stage) throw new Error(STAGE_GONE_MESSAGE)
			const names = new Set(stage.items.flatMap((i) => (i.prepared ? [i.prepared.name] : [])))
			if ([...replace, ...accept].some((name) => !names.has(name)))
				throw new Error(STAGE_CHANGED_MESSAGE)
			if (stageDigest(stage.items) !== stage.digest) throw new Error(STAGE_CHANGED_MESSAGE)
			for (const item of stage.items)
				if (item.prepared && itemDigest(item.prepared) !== item.digest)
					throw new Error(STAGE_CHANGED_MESSAGE)
			stages.delete(stageId)
			const results: {
				name: string
				outcome: 'added' | 'replaced' | 'failed'
				path?: string
				error?: string
			}[] = []
			for (const item of stage.items) {
				const prepared = item.prepared
				if (!prepared) continue
				const name = prepared.name
				if (exists(scope, name) && !replace.includes(name)) {
					results.push({
						name,
						outcome: 'failed',
						error: `A skill named "${name}" is already there. Choose to replace it.`,
					})
					continue
				}
				const outcome = await installPrepared(prepared, prepared.fileName, {
					scope,
					cwd: effectiveCwd(),
					displayCwd: deps.cwd,
					...home,
					yes: accept.includes(name),
					replace: replace.includes(name),
					...(deps.now ? { now: () => new Date(deps.now?.() ?? Date.now()) } : {}),
				})
				if (outcome.status === 'added' || outcome.status === 'replaced') {
					results.push({
						name,
						outcome: outcome.status,
						...(outcome.path ? { path: outcome.path } : {}),
					})
				} else {
					results.push({
						name,
						outcome: 'failed',
						error: line(
							outcome.status === 'needs-consent'
								? 'Accept what it can run first.'
								: outcome.message,
						),
					})
				}
			}
			return { results, note: LOADS_NEXT_NOTE }
		},
		/** Makes a skill from the form: the same checks and writer as a file. */
		'namzu/skills/create': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(
				params,
				['name', 'description', 'instructions', 'scope', 'replace'],
				['name', 'description', 'instructions', 'scope'],
				'skill create',
			)
			const name = field(record, 'name', SKILL_NAME_MAX_CHARS)
			const description = field(record, 'description', SKILL_DESCRIPTION_MAX_CHARS)
			const instructions = field(record, 'instructions', SKILL_BODY_MAX_BYTES + 1024)
			const scope = scopeOf(record)
			if (record.replace !== undefined && typeof record.replace !== 'boolean')
				throw new Error('Invalid replace.')
			guard(scope)
			if (exists(scope, name) && record.replace !== true)
				return {
					outcome: 'exists' as const,
					error: `A skill named "${name}" is already there. Choose to replace it.`,
				}
			// The person wrote it themselves, so what it says it can run is not a question to them.
			const outcome = await createSkill(
				{ name, description, instructions },
				{
					scope,
					cwd: effectiveCwd(),
					displayCwd: deps.cwd,
					...home,
					yes: true,
					replace: true,
					...(deps.now ? { now: () => new Date(deps.now?.() ?? Date.now()) } : {}),
				},
			)
			if (outcome.status === 'added' || outcome.status === 'replaced')
				return {
					outcome: 'created' as const,
					...(outcome.path ? { path: outcome.path } : {}),
					note: LOADS_NEXT_NOTE,
				}
			return { outcome: 'failed' as const, error: line(outcome.message) }
		},
		/** Moves a skill the person added into the backups folder; never deletes it. */
		'namzu/skills/remove': async (params: Record<string, unknown>) => {
			guard()
			const record = exactKeys(params, ['name', 'tier'], ['name', 'tier'], 'skill remove')
			const name = field(record, 'name', 200)
			const tier = scopeOf(record, 'tier')
			guard(tier)
			const outcome = await removeSkill(name, {
				scope: tier,
				cwd: effectiveCwd(),
				displayCwd: deps.cwd,
				...home,
				yes: true,
				...(deps.now ? { now: () => new Date(deps.now?.() ?? Date.now()) } : {}),
			})
			return {
				outcome: outcome.status,
				...(outcome.backup ? { backup: outcome.backup } : {}),
				...(outcome.status === 'removed' ? {} : { error: line(outcome.message) }),
			}
		},
	}
	return { methods, stages }
}
