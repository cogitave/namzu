/**
 * Putting a prepared skill folder on disk without ever leaving half of one.
 *
 * Everything is written first into `<skills folder>/.staging/<id>/<name>/` (a
 * dot folder, which the skill reader never lists), on the same file system as the
 * target so the last step is a rename. A skill that is replaced is first moved to
 * `$NAMZU_HOME/backups/skills/<name>.<ms>/`, then the staged folder is renamed
 * into place. A failure after the backup move puts the old folder back; if that
 * fails too, the backup stays where it is and the message names it. There is no
 * moment at which the target holds some of the old skill and some of the new.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
	chmodSync,
	cpSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** The provenance file of a skill added with `namzu skills add` or `create`. The skill reader ignores it. */
export const SKILL_INSTALL_RECORD = '.namzu-install.json'

export interface SkillFile {
	readonly bytes: Buffer
	/** Written with the owner execute bit (0755). Only files under `scripts/` ever are. */
	readonly executable: boolean
}

/** The one file system call a test replaces to make a step fail. */
export interface InstallFsOps {
	rename(from: string, to: string): void
}

export const REAL_FS_OPS: InstallFsOps = { rename: renameSync }

export class InstallError extends Error {
	override readonly name = 'InstallError'
	constructor(
		message: string,
		/** The old copy of a replaced skill, when it could not be put back. */
		readonly orphanBackup?: string,
	) {
		super(message)
	}
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

/**
 * No link anywhere on the way from `anchor` (trusted, may itself be a link) down to
 * `path`. A folder that is a link could send the write outside the skills folder.
 */
export function assertNoLinkBelow(anchor: string, path: string): void {
	const rel = relative(anchor, path)
	if (rel === '' || rel.startsWith('..')) return
	let current = anchor
	for (const part of rel.split(sep)) {
		current = join(current, part)
		const stat = lstatOrUndefined(current)
		if (stat === undefined) return
		if (stat.isSymbolicLink()) {
			throw new InstallError(
				`${current} is a link; nothing was written. Replace it with a real folder first.`,
			)
		}
	}
}

/** The backups folder sits under the Namzu home; no link may redirect it elsewhere. */
export function assertBackupsSafe(backupsDir: string): void {
	assertNoLinkBelow(dirname(dirname(backupsDir)), backupsDir)
}

/** Move a folder: a rename, or (across file systems) a copy beside the target, then a rename, then the removal. */
export function moveDir(from: string, to: string, ops: InstallFsOps): void {
	try {
		ops.rename(from, to)
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
	}
	const partial = `${to}.partial-${randomUUID().slice(0, 8)}`
	try {
		cpSync(from, partial, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
		ops.rename(partial, to)
	} catch (error) {
		rmSync(partial, { recursive: true, force: true })
		throw error
	}
	rmSync(from, { recursive: true, force: true })
}

export interface StagePlan {
	/** `<skills folder>`: where the skill's own folder will sit. */
	readonly skillsDir: string
	/** The folder trusted not to be a link on purpose; no link is accepted below it. */
	readonly anchor: string
	readonly name: string
	/** Paths relative to the skill folder, `/`-separated. */
	readonly files: ReadonlyMap<string, SkillFile>
	/** Written as `.namzu-install.json`. */
	readonly record: Readonly<Record<string, unknown>>
	/** `$NAMZU_HOME/backups/skills`. */
	readonly backupsDir: string
	readonly now: () => number
}

export interface Staged {
	/** The staged skill folder (`.../<id>/<name>`), complete and not yet visible. */
	readonly dir: string
	/** Where it will go. */
	readonly target: string
	/** The target already holds a folder (so committing replaces it). */
	readonly exists: boolean
	/** Move it into place; replaces (after a backup) only when `replace` is true. */
	commit(replace: boolean): { readonly backup?: string }
	/** Remove the staging folder. Safe to call after `commit`. */
	discard(): void
}

/** Write the skill into staging. Nothing is visible to the skill reader yet. */
export function stageSkill(plan: StagePlan, ops: InstallFsOps = REAL_FS_OPS): Staged {
	const target = join(plan.skillsDir, plan.name)
	assertNoLinkBelow(plan.anchor, target)
	const stagingRoot = join(plan.skillsDir, '.staging')
	assertNoLinkBelow(plan.anchor, stagingRoot)
	const existing = lstatOrUndefined(target)
	if (existing?.isSymbolicLink()) {
		throw new InstallError(
			`${target} is a link; nothing was written. Replace it with a real folder first.`,
		)
	}
	if (existing !== undefined && !existing.isDirectory()) {
		throw new InstallError(`${target} exists and is not a folder; nothing was written.`)
	}
	const id = randomUUID()
	const slot = join(stagingRoot, id)
	const dir = join(slot, plan.name)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const discard = (): void => {
		rmSync(slot, { recursive: true, force: true })
		try {
			if (readdirSync(stagingRoot).length === 0)
				rmSync(stagingRoot, { recursive: true, force: true })
		} catch {
			// Another command is staging at the same time, or it is already gone.
		}
	}
	try {
		for (const [rel, file] of plan.files) {
			if (rel === SKILL_INSTALL_RECORD) continue
			const path = join(dir, ...rel.split('/'))
			mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
			writeFileSync(path, file.bytes, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 })
			chmodSync(path, file.executable ? 0o755 : 0o644)
		}
		writeFileSync(join(dir, SKILL_INSTALL_RECORD), `${JSON.stringify(plan.record, null, 2)}\n`, {
			flag: 'wx',
			mode: 0o644,
		})
	} catch (error) {
		discard()
		throw new InstallError(
			`could not write the skill: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	return {
		dir,
		target,
		exists: existing !== undefined,
		discard,
		commit(replace) {
			const now = lstatOrUndefined(target)
			if (now !== undefined && !replace) {
				throw new InstallError(`${target} already exists; nothing was changed.`)
			}
			let backup: string | undefined
			if (now !== undefined) {
				if (now.isSymbolicLink())
					throw new InstallError(`${target} is a link; nothing was changed.`)
				assertBackupsSafe(plan.backupsDir)
				mkdirSync(plan.backupsDir, { recursive: true, mode: 0o700 })
				let ms = plan.now()
				let candidate = join(plan.backupsDir, `${plan.name}.${ms}`)
				while (lstatOrUndefined(candidate) !== undefined) {
					ms += 1
					candidate = join(plan.backupsDir, `${plan.name}.${ms}`)
				}
				try {
					moveDir(target, candidate, ops)
				} catch (error) {
					throw new InstallError(
						`could not move the old copy aside: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
					)
				}
				backup = candidate
			}
			try {
				mkdirSync(plan.skillsDir, { recursive: true })
				ops.rename(dir, target)
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error)
				if (backup === undefined) throw new InstallError(`could not put the skill in place: ${why}`)
				try {
					moveDir(backup, target, ops)
				} catch {
					throw new InstallError(
						`could not put the skill in place: ${why}. The old copy is kept in ${backup}.`,
						backup,
					)
				}
				throw new InstallError(
					`could not put the skill in place: ${why}. The old copy was put back.`,
				)
			}
			return backup === undefined ? {} : { backup }
		},
	}
}

/** A stable digest of a set of files, for the provenance record of a folder. */
export function digestFiles(files: ReadonlyMap<string, SkillFile>): string {
	const hash = createHash('sha256')
	for (const rel of [...files.keys()].sort()) {
		const file = files.get(rel) as SkillFile
		hash.update(`${rel}\0${createHash('sha256').update(file.bytes).digest('hex')}\n`)
	}
	return hash.digest('hex')
}
