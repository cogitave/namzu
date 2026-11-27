/**
 * `namzu skills remove`: take a skill the person added out of their user or
 * project skills folder. It is moved to `$NAMZU_HOME/backups/skills/<name>.<ms>/`,
 * never deleted. A plugin's skill, a built-in one and a folder that is a link are
 * refused with the reason and what to do instead.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SkillsConfig } from '../config/schema.js'
import { skillBackupsDir, skillsFolderFor } from './add.js'
import {
	type InstallFsOps,
	REAL_FS_OPS,
	SKILL_INSTALL_RECORD,
	assertBackupsSafe,
	moveDir,
} from './install.js'
import { type SkillSaveScope, displayPath } from './save.js'
import { type SkillInfo, discoverSkillRoster, skillTierLabel } from './store.js'

export type RemoveStatus =
	| 'removed'
	| 'failed'
	| 'refused'
	| 'unsafe'
	| 'not-found'
	| 'usage'
	| 'needs-consent'
	| 'declined'

export interface RemoveOutcome {
	readonly status: RemoveStatus
	readonly message: string
	readonly name: string
	readonly scope?: SkillSaveScope
	/** The skill's folder. */
	readonly path?: string
	readonly backup?: string
	/** What the provenance record and the folder say about it, in words. */
	readonly details: readonly string[]
}

export interface RemoveContext {
	readonly scope?: SkillSaveScope
	readonly cwd: string
	/** The folder paths are shown relative to, when it is not `cwd`. */
	readonly displayCwd?: string
	readonly home?: string
	readonly config?: SkillsConfig
	readonly yes: boolean
	/** Absent when there is no terminal to ask at. */
	readonly ask?: (question: string, details: readonly string[]) => Promise<boolean>
	readonly now?: () => Date
	readonly ops?: InstallFsOps
}

/** What the folder says about itself: where it came from and what was added to it later. */
export function describeSkillFolder(dir: string): string[] {
	const details: string[] = []
	let recorded: Set<string> | undefined
	try {
		const record = JSON.parse(readFileSync(join(dir, SKILL_INSTALL_RECORD), 'utf8')) as {
			source?: unknown
			fileName?: unknown
			files?: unknown
		}
		recorded = Array.isArray(record.files)
			? new Set(record.files.filter((f): f is string => typeof f === 'string'))
			: undefined
		details.push(
			record.source === 'create'
				? 'Made with namzu skills create.'
				: typeof record.fileName === 'string'
					? `Added from ${record.source === 'folder' ? 'a folder' : 'a file'} (${record.fileName}).`
					: 'Added with namzu skills add.',
		)
	} catch {
		// A skill made by hand has no record.
	}
	if (recorded !== undefined) {
		let later = 0
		const walk = (abs: string, rel: string): void => {
			for (const entry of readdirSync(abs, { withFileTypes: true })) {
				const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
				if (entry.isDirectory()) walk(join(abs, entry.name), relPath)
				else if (relPath !== SKILL_INSTALL_RECORD && !recorded?.has(relPath)) later++
			}
		}
		try {
			walk(dir, '')
		} catch {
			// Unreadable: say nothing rather than a wrong count.
		}
		if (later > 0) {
			details.push(
				`${later} ${later === 1 ? 'file was' : 'files were'} added to it after it was installed.`,
			)
		}
	}
	return details
}

export async function removeSkill(name: string, ctx: RemoveContext): Promise<RemoveOutcome> {
	const none = { name, details: [] as string[] }
	if (name.includes('__')) {
		const plugin = name.slice(0, name.indexOf('__'))
		return {
			...none,
			status: 'refused',
			message: `This skill comes with plugin "${plugin}". Turn the plugin off or uninstall it.`,
		}
	}
	// A linked skill folder is not listed by discovery at all, so look for it by name first.
	for (const tier of ['user', 'project'] as const) {
		if (ctx.scope !== undefined && ctx.scope !== tier) continue
		const linked = join(skillsFolderFor(tier, ctx).dir, name)
		try {
			if (lstatSync(linked).isSymbolicLink()) {
				return {
					...none,
					status: 'unsafe',
					scope: tier,
					path: linked,
					message: `"${name}" is a link to another folder (${displayPath(linked, ctx.displayCwd ?? ctx.cwd, ctx.home)}), so it was not removed. Remove the link yourself.`,
				}
			}
		} catch {
			// Not there: the roster below says whether it is anywhere else.
		}
	}
	const roster = discoverSkillRoster({
		cwd: ctx.cwd,
		...(ctx.home !== undefined ? { home: ctx.home } : {}),
		config: { ...(ctx.config ?? {}), builtin: true, disabled: [] },
	})
	const found: SkillInfo[] = [...roster.skills, ...roster.shadowed].filter((s) => s.name === name)
	if (found.length === 0) {
		return { ...none, status: 'not-found', message: `No skill named "${name}" was found.` }
	}
	const removable = found.filter((s) => s.tier === 'user' || s.tier === 'project')
	const wanted = ctx.scope === undefined ? removable : removable.filter((s) => s.tier === ctx.scope)
	if (wanted.length === 0) {
		const other = found[0] as SkillInfo
		if (found.every((s) => s.tier === 'system')) {
			return {
				...none,
				status: 'refused',
				message: `"${name}" is a built-in skill and cannot be removed.`,
			}
		}
		if (ctx.scope !== undefined && removable.length > 0) {
			return {
				...none,
				status: 'not-found',
				message: `No skill named "${name}" in ${ctx.scope === 'user' ? 'your skills' : "this project's skills"}. It is in ${removable.map((s) => s.tier).join(' and ')}: use --scope ${removable[0]?.tier}.`,
			}
		}
		return {
			...none,
			status: 'refused',
			message: `"${name}" is in a ${skillTierLabel(other.tier)} skills folder (${displayPath(dirname(other.path), ctx.displayCwd ?? ctx.cwd, ctx.home)}). Namzu removes only skills in your own or the project's .namzu folder; remove that folder yourself.`,
		}
	}
	if (wanted.length > 1) {
		return {
			...none,
			status: 'usage',
			message: `"${name}" is in both your skills and this project's skills. Say which one: --scope user or --scope project.`,
		}
	}
	const skill = wanted[0] as SkillInfo
	const scope = skill.tier as SkillSaveScope
	const dir = dirname(skill.path)
	let stat: ReturnType<typeof lstatSync>
	try {
		stat = lstatSync(dir)
	} catch {
		return { ...none, status: 'not-found', scope, message: `No skill named "${name}" was found.` }
	}
	if (stat.isSymbolicLink()) {
		return {
			...none,
			status: 'unsafe',
			scope,
			path: dir,
			message: `"${name}" is a link to another folder (${displayPath(dir, ctx.displayCwd ?? ctx.cwd, ctx.home)}), so it was not removed. Remove the link yourself.`,
		}
	}
	const details = describeSkillFolder(dir)
	const place = scope === 'user' ? 'your skills' : "this project's skills"
	if (!ctx.yes) {
		const question = `Remove skill "${name}" from ${place}? A copy is kept in ${displayPath(skillBackupsDir(ctx.home), ctx.displayCwd ?? ctx.cwd, ctx.home)}.`
		if (ctx.ask === undefined) {
			return {
				name,
				details,
				status: 'needs-consent',
				scope,
				path: dir,
				message: `${question} Nobody can be asked here: run it again with --yes to go ahead.`,
			}
		}
		if (!(await ctx.ask(question, details))) {
			return {
				name,
				details,
				status: 'declined',
				scope,
				path: dir,
				message: 'Nothing was removed.',
			}
		}
	}
	const backups = skillBackupsDir(ctx.home)
	let ms = (ctx.now ?? (() => new Date()))().getTime()
	let backup = join(backups, `${name}.${ms}`)
	try {
		assertBackupsSafe(backups)
		mkdirSync(backups, { recursive: true, mode: 0o700 })
		for (;;) {
			try {
				lstatSync(backup)
			} catch {
				break
			}
			ms += 1
			backup = join(backups, `${name}.${ms}`)
		}
		moveDir(dir, backup, ctx.ops ?? REAL_FS_OPS)
	} catch (error) {
		return {
			name,
			details,
			status: 'failed',
			scope,
			path: dir,
			message: `Could not remove "${name}": ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
		}
	}
	return {
		name,
		details,
		status: 'removed',
		scope,
		path: dir,
		backup,
		message: `Removed. A copy is in ${displayPath(backup, ctx.displayCwd ?? ctx.cwd, ctx.home)} if you want it back.`,
	}
}
