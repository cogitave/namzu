import { randomBytes } from 'node:crypto'
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
	DiskLearningGuidance,
	type ProjectId,
	SessionPaths,
	SqliteLearningStore,
	type TenantId,
	earlierGuidanceDirectory,
} from '@namzu/sdk'
import { resolveNamzuHome } from '../state/home.js'
import { readIdentity } from '../state/identity.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { findProject } from '../state/project-lookup.js'
import { cliProjectRoot } from '../state/project.js'

/**
 * A named learning target: one place guidance is learned into by a learning
 * module the person chose (`namzu learn <module> --agent <name>`). It has its
 * own observation and experiment journal and its own revisioned guidance,
 * under the project's `learning/targets/<name>/`:
 *
 *   store/      learning.sqlite and the artifacts it references
 *   guidance/   the revisioned guidance store
 *
 * A person who learned into a named target with an earlier version has that
 * state under `residents/<name>/` (`learning.sqlite`, `artifacts/`) and in the
 * earlier guidance layout beside it. The first time the target is used, the
 * database and artifacts are copied into `store/` and the guidance revisions
 * into `guidance/`. The earlier files are only read, never changed or removed.
 */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u

export interface NamedLearningTarget {
	readonly name: string
	/** Canonical directory the module runs in. */
	readonly cwd: string
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly guidance: DiskLearningGuidance
	/** Where the journal lives; the files exist once the store has been opened for writing. */
	readonly storeDirectory: string
	/** Create the target's private directory, so the first revision is written inside it. */
	prepare(): void
	/** The journal. Null when read-only and nothing has been recorded. */
	openStore(readOnly?: boolean): SqliteLearningStore | null
}

export function assertTargetName(name: string): void {
	if (!NAME.test(name))
		throw new Error(
			'A learning target name must contain 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.',
		)
}

function realDirectory(path: string): boolean {
	try {
		const entry = lstatSync(path)
		if (!entry.isDirectory() || entry.isSymbolicLink())
			throw new Error(`Learning state requires a real directory: ${path}`)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

function privateRegularFile(file: string): boolean {
	try {
		const entry = lstatSync(file)
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
			throw new Error(`Learning database requires a private regular file: ${file}`)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

const DATABASE_FILES = ['learning.sqlite', 'learning.sqlite-journal'] as const

/**
 * Copy an earlier journal and its artifacts into `store/` in one step: they are
 * assembled in a staging directory and published by renaming it, so `store/`
 * either does not exist or holds all of it. A concurrent first use loses the
 * rename and uses the winner's copy. An unfinished write the earlier version
 * left (`learning.sqlite-journal`) is copied beside the database, so the first
 * open of the copy settles it exactly as the earlier one would have.
 */
function carryOverJournal(earlier: string, targetDirectory: string, store: string): void {
	if (existsSync(store)) return
	if (!privateRegularFile(join(earlier, 'learning.sqlite'))) return
	const staging = join(
		targetDirectory,
		`store.adopting-${process.pid}-${randomBytes(4).toString('hex')}`,
	)
	try {
		mkdirSync(staging, { recursive: true, mode: 0o700 })
		for (const file of DATABASE_FILES) {
			if (privateRegularFile(join(earlier, file)))
				cpSync(join(earlier, file), join(staging, file), { force: false, errorOnExist: true })
		}
		if (realDirectory(join(earlier, 'artifacts')))
			cpSync(join(earlier, 'artifacts'), join(staging, 'artifacts'), {
				recursive: true,
				force: false,
				errorOnExist: true,
			})
		writeFileSync(
			join(staging, 'adopted.json'),
			`${JSON.stringify({ from: earlier, adoptedAt: new Date().toISOString() }, null, 2)}\n`,
			{ flag: 'wx' },
		)
		try {
			renameSync(staging, store)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
			if (!existsSync(store)) throw error
		}
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

function handle(input: {
	readonly root: string
	readonly slug: string
	readonly name: string
	readonly cwd: string
	readonly tenantId: TenantId
	readonly projectId: ProjectId
}): NamedLearningTarget {
	const paths = new SessionPaths({ home: input.root, slug: input.slug })
	const projectDirectory = paths.projectDir()
	const learning = join(projectDirectory, 'learning')
	const targetDirectory = join(learning, 'targets', input.name)
	const earlierResidents = join(projectDirectory, 'residents')
	const earlier = join(earlierResidents, input.name)
	const storeDirectory = join(targetDirectory, 'store')
	const scope = { tenantId: input.tenantId, projectId: input.projectId, agentKey: input.name }
	const ensureTarget = () => {
		const targets = ensurePrivateStateDirectory(
			ensurePrivateStateDirectory(projectDirectory, 'learning'),
			'targets',
		)
		return ensurePrivateStateDirectory(targets, input.name)
	}
	return {
		name: input.name,
		cwd: input.cwd,
		tenantId: input.tenantId,
		projectId: input.projectId,
		storeDirectory,
		guidance: new DiskLearningGuidance(
			join(targetDirectory, 'guidance'),
			{ tenantId: input.tenantId, agentKey: input.name },
			{
				adoptFrom: earlierGuidanceDirectory(earlierResidents, {
					tenantId: input.tenantId,
					agentKey: input.name,
				}),
			},
		),
		prepare() {
			ensureTarget()
		},
		openStore(readOnly = false) {
			if (!existsSync(storeDirectory)) {
				if (existsSync(join(earlier, 'learning.sqlite'))) {
					ensureTarget()
					carryOverJournal(earlier, targetDirectory, storeDirectory)
				} else if (readOnly) return null
			}
			if (!readOnly) {
				ensureTarget()
				ensurePrivateStateDirectory(targetDirectory, 'store')
				ensurePrivateStateDirectory(storeDirectory, 'artifacts')
			} else {
				if (!realDirectory(storeDirectory)) return null
				realDirectory(join(storeDirectory, 'artifacts'))
			}
			const databasePath = join(storeDirectory, 'learning.sqlite')
			for (const file of [databasePath, `${databasePath}-journal`]) privateRegularFile(file)
			if (readOnly && !existsSync(databasePath)) return null
			return new SqliteLearningStore({
				databasePath,
				artifactsPath: join(storeDirectory, 'artifacts'),
				scope,
				readOnly,
			})
		},
	}
}

/**
 * An existing target of the project that holds `cwd`, found WITHOUT creating
 * anything. A target exists once it has been written to, or once an earlier
 * version left state for the same name. Null otherwise.
 */
export async function lookupNamedTarget(
	cwd: string,
	name: string,
): Promise<NamedLearningTarget | null> {
	assertTargetName(name)
	const root = resolveNamzuHome()
	const identity = readIdentity(root)
	if (!identity) return null
	const canonical = await realpath(resolve(cwd))
	const project = await findProject(root, cliProjectRoot(canonical))
	if (!project) return null
	const projectDirectory = new SessionPaths({ home: root, slug: project.slug }).projectDir()
	const exists =
		existsSync(join(projectDirectory, 'learning', 'targets', name)) ||
		existsSync(join(projectDirectory, 'residents', name, 'learning.sqlite')) ||
		existsSync(
			earlierGuidanceDirectory(join(projectDirectory, 'residents'), {
				tenantId: identity.tenantId,
				agentKey: name,
			}),
		)
	if (!exists) return null
	return handle({
		root,
		slug: project.slug,
		name,
		cwd: canonical,
		tenantId: identity.tenantId,
		projectId: project.projectId,
	})
}

/**
 * The target for `cwd`, created when it does not exist. This is the explicit
 * act of running a learning module into it, so it may file the project.
 */
export async function createNamedTarget(cwd: string, name: string): Promise<NamedLearningTarget> {
	assertTargetName(name)
	const canonical = await realpath(resolve(cwd))
	const { openSessions, closeSessions } = await import('../sessions/store.js')
	const sessions = await openSessions(canonical)
	try {
		const target = handle({
			root: sessions.root,
			slug: sessions.slug,
			name,
			cwd: canonical,
			tenantId: sessions.tenantId,
			projectId: sessions.projectId,
		})
		target.prepare()
		await target.guidance.open()
		return target
	} finally {
		closeSessions(sessions)
	}
}
