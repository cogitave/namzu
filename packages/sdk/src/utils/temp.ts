import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Namzu's own scratch space: the one place that decides where temporary files
 * go, who may enter, and what a failure to create it says.
 *
 * The base is `NAMZU_TMPDIR` when it is set, otherwise the operating system's
 * temporary directory. Under it, `namzu-<user>` is private to the user (mode
 * 0700, refused when it is a symbolic link, not a directory, owned by someone
 * else, or open to group and others). A failure is never answered by quietly
 * using another directory: it is a {@link TempDirectoryError} that names the
 * directory, the cause and `NAMZU_TMPDIR`.
 */

/** The environment variable that moves Namzu's scratch space to another folder or disk. */
export const NAMZU_TMPDIR_ENV = 'NAMZU_TMPDIR'

export type TempDirectoryFailure =
	| 'volume_full'
	| 'quota_exceeded'
	| 'not_writable'
	| 'missing'
	| 'not_absolute'
	| 'refused'

/** Namzu's scratch directory cannot be used. `message` is a sentence for a person. */
export class TempDirectoryError extends Error {
	override readonly name = 'TempDirectoryError'
	constructor(
		message: string,
		readonly reason: TempDirectoryFailure,
		readonly directory: string,
	) {
		super(message)
	}
}

export interface PrivateTempRootOptions {
	/** Base directory. Default `NAMZU_TMPDIR`, else `os.tmpdir()`. */
	readonly tmpdir?: string
	/** Default `process.env`. */
	readonly env?: NodeJS.ProcessEnv
	/** Default `process.platform`. */
	readonly platform?: NodeJS.Platform
	/**
	 * Default `process.getuid`. Pass `undefined` explicitly to model a
	 * platform without it (win32).
	 */
	readonly getuid?: (() => number) | undefined
	/** Default `os.userInfo().username`. */
	readonly username?: () => string
}

/**
 * The directory under which Namzu keeps its temporary files: `NAMZU_TMPDIR`
 * when set (it must be an absolute path), otherwise `os.tmpdir()`. Nothing is
 * created or checked.
 */
export function resolveTempBase(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[NAMZU_TMPDIR_ENV]?.trim()
	if (!configured) return tmpdir()
	if (!isAbsolute(configured)) {
		throw new TempDirectoryError(
			`${NAMZU_TMPDIR_ENV} must be a full path, but it is "${configured}". Set it to a folder on a disk with free space.`,
			'not_absolute',
			configured,
		)
	}
	return configured
}

/** The sentence for a directory that could not be created or written. */
function explain(error: unknown, directory: string): TempDirectoryError | undefined {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	const elsewhere = `Free some space and start again, or set ${NAMZU_TMPDIR_ENV} to a folder on another disk.`
	switch (code) {
		case 'ENOSPC':
			return new TempDirectoryError(
				`The disk is full, so Namzu could not create ${directory}. ${elsewhere}`,
				'volume_full',
				directory,
			)
		case 'EDQUOT':
			return new TempDirectoryError(
				`Your disk quota is used up, so Namzu could not create ${directory}. ${elsewhere}`,
				'quota_exceeded',
				directory,
			)
		case 'EACCES':
		case 'EPERM':
		case 'EROFS':
			return new TempDirectoryError(
				`Namzu could not create ${directory} because the folder cannot be written to. Set ${NAMZU_TMPDIR_ENV} to a folder you can write to.`,
				'not_writable',
				directory,
			)
		case 'ENOENT':
			return new TempDirectoryError(
				`Namzu could not create ${directory} because its parent folder does not exist. Create that folder, or set ${NAMZU_TMPDIR_ENV} to one that does.`,
				'missing',
				directory,
			)
		default:
			return undefined
	}
}

function refuse(root: string, why: string): TempDirectoryError {
	return new TempDirectoryError(
		`Refusing temporary root ${root}: ${why} Set ${NAMZU_TMPDIR_ENV} to a folder only you can write to.`,
		'refused',
		root,
	)
}

function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

/**
 * The per-user private root, `<base>/namzu-<user>`, created if missing.
 *
 * `<user>` is the numeric uid where the platform has one; otherwise the first
 * 12 hex digits of the SHA-256 of the user name; otherwise `user`. On POSIX
 * the directory is created with mode 0700 and refused if it is a symlink, not
 * a directory, owned by another uid, or open to group or others. On win32
 * `%TEMP%` is already per user: a symlink or junction is refused and the
 * owner check is skipped.
 *
 * @throws {TempDirectoryError} when it cannot be created or is not safe to use.
 */
export function privateTempRoot(options: PrivateTempRootOptions = {}): string {
	const platform = options.platform ?? process.platform
	const getuid = 'getuid' in options ? options.getuid : process.getuid?.bind(process)
	let user = 'user'
	if (typeof getuid === 'function') {
		user = String(getuid())
	} else {
		try {
			const name = (options.username ?? (() => userInfo().username))()
			if (name.length > 0) user = sha256Hex(name).slice(0, 12)
		} catch {
			// No user database entry: fall back to the fixed segment.
		}
	}
	const root = join(options.tmpdir ?? resolveTempBase(options.env), `namzu-${user}`)
	try {
		mkdirSync(root, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw explain(error, root) ?? error
	}
	const entry = lstatSync(root)
	if (entry.isSymbolicLink()) throw refuse(root, 'it is a symbolic link.')
	if (!entry.isDirectory()) throw refuse(root, 'it is not a directory.')
	if (platform !== 'win32' && typeof getuid === 'function') {
		if (entry.uid !== getuid()) throw refuse(root, `it belongs to uid ${entry.uid}.`)
		if ((entry.mode & 0o077) !== 0) {
			throw refuse(
				root,
				`mode ${(entry.mode & 0o777).toString(8)} lets other users in; it must be 700.`,
			)
		}
	}
	return root
}

/** A new empty directory named `<prefix>XXXXXX` inside the private root. */
export function createTempDirSync(prefix: string, options: PrivateTempRootOptions = {}): string {
	const root = privateTempRoot(options)
	try {
		return mkdtempSync(join(root, prefix))
	} catch (error) {
		throw explain(error, join(root, prefix)) ?? error
	}
}

/** As {@link createTempDirSync}, without blocking the event loop. */
export async function createTempDir(
	prefix: string,
	options: PrivateTempRootOptions = {},
): Promise<string> {
	const root = privateTempRoot(options)
	try {
		return await mkdtemp(join(root, prefix))
	} catch (error) {
		throw explain(error, join(root, prefix)) ?? error
	}
}

/**
 * The path of a file named `name` inside the private root. The file itself is
 * not created; the caller opens it, and a write that fails because the disk is
 * full is the caller's to report.
 */
export function tempFilePath(name: string, options: PrivateTempRootOptions = {}): string {
	return join(privateTempRoot(options), name)
}
