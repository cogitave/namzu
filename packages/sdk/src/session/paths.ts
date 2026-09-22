import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { link, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
	CheckpointId,
	GoalId,
	MessageId,
	ProjectId,
	SessionId,
	TaskId,
	TurnId,
} from '../types/ids/index.js'
import { type ProjectDocument, ProjectDocumentSchema } from '../types/session/records.js'
import { type EntityIdKind, asSessionId, generateProjectId, isEntityId } from '../utils/id.js'
import { uuidv7 } from '../utils/uuidv7.js'

/**
 * The on-disk layout of `NAMZU_HOME`, shared by the SDK and the CLI:
 *
 * ```text
 * $NAMZU_HOME/
 *   index.sqlite                     rebuildable index over every log
 *   projects/<slug>/
 *     project.json                   the project id, minted once
 *     memory/  residents/  worktrees/<label>/
 *     <session-id>.jsonl             the session log (source of truth)
 *     <session-id>/
 *       subagents/<child-id>.jsonl, <child-id>.meta.json, <child-id>/subagents/…
 *       tool-results/  checkpoints/  budgets/  tasks/  feedback/  goals/
 *       file-history/  lease.json
 * $TMPDIR/namzu-<user>/<slug>/<session-id>/scratchpad/
 * ```
 *
 * Every id that becomes a path segment is checked here, because a brand does
 * not validate a value read from JSON.
 */

/** Names a session in the tree: its id, and its ancestors from the root down (empty for a root session). */
export interface SessionLocator {
	readonly sessionId: SessionId
	readonly ancestors?: readonly SessionId[]
}

/**
 * The locator a session log's own path spells out: `<session-id>.jsonl` at the
 * top of a project is a root session, and each `<ancestor-id>/subagents/`
 * above it names an ancestor, nearest last. `undefined` when the file is not
 * named `<sessionId>.jsonl`, so a log kept outside the layout claims no place
 * in it.
 *
 * A log opened from the index's `logPath` knows only its file; this is how it
 * finds the same `checkpoints/` (and the rest of its session directory) that
 * {@link SessionPaths} placed for it.
 */
export function sessionLocatorFromLogFile(
	file: string,
	sessionId: SessionId,
): SessionLocator | undefined {
	if (basename(file) !== `${sessionId}.jsonl`) return undefined
	const ancestors: SessionId[] = []
	let directory = dirname(file)
	while (basename(directory) === 'subagents') {
		const owner = basename(dirname(directory))
		if (!isEntityId(owner, 'session')) break
		ancestors.unshift(asSessionId(owner))
		directory = dirname(dirname(directory))
	}
	return ancestors.length === 0 ? { sessionId } : { sessionId, ancestors }
}

export interface SessionPathsOptions {
	/** The resolved `NAMZU_HOME` (see `resolveNamzuHome`). */
	readonly home: string
	/** The project's slug, as `ensureProject` returned it. */
	readonly slug: string
	/**
	 * The per-user temporary root (`$TMPDIR/namzu-<user>`). Defaults to
	 * {@link tempRoot}, resolved (and created) the first time `tempDir` is called.
	 */
	readonly tempRoot?: string
}

/** A path segment that is not an id of the expected kind, or not a safe name. */
export class SessionPathError extends Error {
	override readonly name = 'SessionPathError'
}

const SLUG = /^[A-Za-z0-9-]+$/
/** Worktree labels and resident agent keys: one plain segment, never `.` or `..`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Longest slug before a hash suffix replaces the tail; well under the 255-byte segment limit. */
const MAX_SLUG = 200

function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function checkId(value: string, kind: EntityIdKind): string {
	if (!isEntityId(value, kind)) {
		throw new SessionPathError(`Invalid ${kind} id for a path: ${JSON.stringify(value)}`)
	}
	return value
}

function checkName(value: string, what: string): string {
	if (!NAME.test(value) || value.includes('..')) {
		throw new SessionPathError(`Invalid ${what} for a path: ${JSON.stringify(value)}`)
	}
	return value
}

/**
 * The slug a working directory is filed under: every character outside
 * `[A-Za-z0-9]` becomes `-`.
 *
 * Pass the canonical path (`realpath`); `ensureProject` does. A POSIX
 * absolute path starts with `/`, so its slug starts with `-`; a Windows path
 * `C:\…` gives `C-…`; a UNC path gives `--…`. None of these can look like a
 * UUID, which is how a layout reader tells a slug from a legacy
 * `projects/<uuid>/` directory. A slug longer than 200 characters keeps its
 * first 191 and ends in `-` plus 8 hex digits of the path's SHA-256.
 */
export function slugForCwd(cwd: string): string {
	const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
	if (slug.length <= MAX_SLUG) return slug
	return `${slug.slice(0, MAX_SLUG - 9)}-${sha256Hex(cwd).slice(0, 8)}`
}

/** The slug used when `project.json` under the plain slug belongs to a different directory. */
export function hashedSlugForCwd(cwd: string): string {
	return `${slugForCwd(cwd)}-${sha256Hex(cwd).slice(0, 8)}`
}

export interface EnsureProjectOptions {
	readonly home: string
	readonly cwd: string
	/** Clock for `createdAt`; tests pin it. */
	readonly now?: () => Date
}

export interface EnsuredProject {
	readonly slug: string
	readonly projectId: ProjectId
	/** The canonical working directory the project stands for. */
	readonly cwd: string
	readonly projectDir: string
	/** True when this call minted `project.json`; false when it adopted an existing one. */
	readonly created: boolean
}

/** `project.json` exists and cannot be read as a project document. */
export class ProjectDocumentError extends Error {
	override readonly name = 'ProjectDocumentError'
}

async function readProjectDocument(file: string): Promise<ProjectDocument | null> {
	let raw: string
	try {
		raw = await readFile(file, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new ProjectDocumentError(
			`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const result = ProjectDocumentSchema.safeParse(parsed)
	if (!result.success) {
		throw new ProjectDocumentError(`${file} is not a project document: ${result.error.message}`)
	}
	return result.data
}

/**
 * Find or create the project a working directory stands for.
 *
 * The directory is canonicalised, slugged, and `projects/<slug>/project.json`
 * is created exclusively: the document is written complete to a private
 * temporary file and then hard-linked into place, which fails with `EEXIST`
 * if another process got there first. So a reader never sees a half-written
 * document, and of two processes racing, exactly one mints the project id and
 * the other adopts it. If the existing document names a different directory
 * (two paths that slug alike), the project moves to the hashed slug.
 */
export async function ensureProject(options: EnsureProjectOptions): Promise<EnsuredProject> {
	const cwd = await realpath(options.cwd)
	const now = options.now ?? (() => new Date())
	const candidates = [slugForCwd(cwd), hashedSlugForCwd(cwd)]
	for (const slug of candidates) {
		const projectDir = join(options.home, 'projects', slug)
		await mkdir(projectDir, { recursive: true })
		const file = join(projectDir, 'project.json')
		let existing = await readProjectDocument(file)
		if (existing === null) {
			const document: ProjectDocument = {
				v: 1,
				kind: 'project',
				projectId: generateProjectId(),
				cwd,
				slug,
				createdAt: now().toISOString(),
			}
			const temporary = join(projectDir, `.project.json.${process.pid}.${uuidv7()}.tmp`)
			const handle = await open(temporary, 'wx', 0o600)
			try {
				await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8')
				await handle.sync()
			} finally {
				await handle.close()
			}
			let won = false
			try {
				await link(temporary, file)
				won = true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			} finally {
				await unlink(temporary).catch(() => undefined)
			}
			if (won) return { slug, projectId: document.projectId, cwd, projectDir, created: true }
			existing = await readProjectDocument(file)
			if (existing === null) {
				throw new ProjectDocumentError(`${file} vanished while it was being created.`)
			}
		}
		if (existing.cwd === cwd) {
			return { slug, projectId: existing.projectId, cwd, projectDir, created: false }
		}
	}
	throw new ProjectDocumentError(
		`No project slug is free for ${JSON.stringify(cwd)}: both ${candidates.join(' and ')} belong to other directories.`,
	)
}

export interface TempRootOptions {
	/** Base directory. Default `os.tmpdir()`. */
	readonly tmpdir?: string
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
 * The per-user temporary root, `$TMPDIR/namzu-<user>`, created if missing.
 *
 * `<user>` is the numeric uid where the platform has one; otherwise the first
 * 12 hex digits of the SHA-256 of the user name; otherwise `user`. On POSIX
 * the directory is created with mode 0700 and refused if it is a symlink, not
 * a directory, owned by another uid, or open to group or others. On win32
 * `%TEMP%` is already per user: a symlink or junction is refused and the
 * owner check is skipped.
 */
export function tempRoot(options: TempRootOptions = {}): string {
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
	const root = join(options.tmpdir ?? tmpdir(), `namzu-${user}`)
	try {
		mkdirSync(root, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
	}
	const entry = lstatSync(root)
	if (entry.isSymbolicLink()) {
		throw new SessionPathError(`Refusing temporary root ${root}: it is a symbolic link.`)
	}
	if (!entry.isDirectory()) {
		throw new SessionPathError(`Refusing temporary root ${root}: it is not a directory.`)
	}
	if (platform !== 'win32' && typeof getuid === 'function') {
		if (entry.uid !== getuid()) {
			throw new SessionPathError(`Refusing temporary root ${root}: it belongs to uid ${entry.uid}.`)
		}
		if ((entry.mode & 0o077) !== 0) {
			throw new SessionPathError(
				`Refusing temporary root ${root}: mode ${(entry.mode & 0o777).toString(8)} lets other users in; it must be 700.`,
			)
		}
	}
	return root
}

/** Every path of one project's layout. Pure: nothing is created or read. */
export class SessionPaths {
	readonly home: string
	readonly slug: string
	#tempRoot: string | undefined

	constructor(options: SessionPathsOptions) {
		if (!SLUG.test(options.slug)) {
			throw new SessionPathError(`Invalid project slug: ${JSON.stringify(options.slug)}`)
		}
		this.home = options.home
		this.slug = options.slug
		this.#tempRoot = options.tempRoot
	}

	/** `$NAMZU_HOME/index.sqlite`. */
	indexFile(): string {
		return join(this.home, 'index.sqlite')
	}

	projectDir(): string {
		return join(this.home, 'projects', this.slug)
	}

	projectFile(): string {
		return join(this.projectDir(), 'project.json')
	}

	memoryDir(): string {
		return join(this.projectDir(), 'memory')
	}

	residentDir(agentKey: string): string {
		return join(this.projectDir(), 'residents', checkName(agentKey, 'resident agent key'))
	}

	/** The `GitWorktreeManager` default root, or one labelled worktree inside it. */
	worktrees(label?: string): string {
		const root = join(this.projectDir(), 'worktrees')
		return label === undefined ? root : join(root, checkName(label, 'worktree label'))
	}

	/** The directory that holds `<session-id>.jsonl`: the project for a root session, `subagents/` of its parent otherwise. */
	#logParent(locator: SessionLocator): string {
		let parent = this.projectDir()
		for (const ancestor of locator.ancestors ?? []) {
			parent = join(parent, checkId(ancestor, 'session'), 'subagents')
		}
		return parent
	}

	/** `<session-id>.jsonl`, or `…/subagents/<child-id>.jsonl` for a child session. */
	sessionLog(locator: SessionLocator): string {
		return join(this.#logParent(locator), `${checkId(locator.sessionId, 'session')}.jsonl`)
	}

	/** The session's own directory, beside its log. */
	sessionDir(locator: SessionLocator): string {
		return join(this.#logParent(locator), checkId(locator.sessionId, 'session'))
	}

	#child(parent: SessionLocator, childId: SessionId): SessionLocator {
		return { sessionId: childId, ancestors: [...(parent.ancestors ?? []), parent.sessionId] }
	}

	subagentLog(parent: SessionLocator, childId: SessionId): string {
		return this.sessionLog(this.#child(parent, childId))
	}

	/** `<parent-dir>/subagents/<child-id>.meta.json`. */
	subagentMeta(parent: SessionLocator, childId: SessionId): string {
		return join(this.sessionDir(parent), 'subagents', `${checkId(childId, 'session')}.meta.json`)
	}

	toolResults(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'tool-results')
	}

	/** A spilled tool result, named by the SHA-256 of its provider tool-use id; the manifest is `<file>.manifest.json`. */
	toolResultFile(locator: SessionLocator, toolUseId: string): string {
		if (toolUseId.length === 0) throw new SessionPathError('A tool-use id is required.')
		return join(this.toolResults(locator), `${sha256Hex(toolUseId)}.txt`)
	}

	checkpoints(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'checkpoints')
	}

	checkpointFile(locator: SessionLocator, checkpointId: CheckpointId): string {
		return join(this.checkpoints(locator), `${checkId(checkpointId, 'checkpoint')}.json`)
	}

	/** Token ledgers; written for root sessions only. */
	budgets(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'budgets')
	}

	budgetFile(locator: SessionLocator, rootTurnId: TurnId): string {
		return join(this.budgets(locator), `${checkId(rootTurnId, 'turn')}.json`)
	}

	tasks(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'tasks')
	}

	taskFile(locator: SessionLocator, taskId: TaskId): string {
		return join(this.tasks(locator), `${checkId(taskId, 'task')}.json`)
	}

	feedback(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'feedback')
	}

	feedbackFile(locator: SessionLocator, messageId: MessageId): string {
		return join(this.feedback(locator), `${checkId(messageId, 'message')}.json`)
	}

	goals(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'goals')
	}

	goalFile(locator: SessionLocator, goalId: GoalId): string {
		return join(this.goals(locator), `${checkId(goalId, 'goal')}.json`)
	}

	/** File snapshots a CLI `/restore` rolls back to. */
	fileHistory(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'file-history')
	}

	lease(locator: SessionLocator): string {
		return join(this.sessionDir(locator), 'lease.json')
	}

	/** `$TMPDIR/namzu-<user>/<slug>/<session-id>/scratchpad`. Not created; the per-user root is. */
	tempDir(sessionId: SessionId): string {
		this.#tempRoot ??= tempRoot()
		return join(this.#tempRoot, this.slug, checkId(sessionId, 'session'), 'scratchpad')
	}
}
