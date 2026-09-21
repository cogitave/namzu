import { lstatSync, readFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
	DiskResidentAgenda,
	ProjectDocumentSchema,
	type ProjectId,
	ResidentConflictError,
	SessionPaths,
	type TenantId,
	hashedSlugForCwd,
	slugForCwd,
} from '@namzu/sdk'

import { resolveNamzuHome } from '../state/home.js'
import { readIdentity } from '../state/identity.js'
import { publishPrivateJsonIfAbsent } from '../state/immutable-json.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { cliProjectRoot } from '../state/project.js'

const MANDATE =
	'Pursue only objectives explicitly added by this project’s operator. Respect project instructions and current tool permissions.'

export interface CliResident {
	readonly agenda: DiskResidentAgenda
	/** Canonical execution directory chosen by the first creator. */
	readonly cwd: string
	readonly agentKey: string
	readonly artifactsRoot: string
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	/** Installation state root (`NAMZU_HOME`), never a second resident-specific hierarchy. */
	readonly root: string
	/** The project's directory name under `<root>/projects/`, as `project.json` records it. */
	readonly slug: string
}

/**
 * Where one project's resident state lives: `<root>/projects/<slug>/residents`,
 * with each agent's binding, runner state, attempts and learning database in
 * `<agent-key>/` below it (the SDK's `SessionPaths.residentDir`).
 */
export function residentsRootFor(root: string, slug: string): string {
	return join(new SessionPaths({ home: root, slug }).projectDir(), 'residents')
}

/** One agent's directory under {@link residentsRootFor}. */
export function residentDirectoryFor(root: string, slug: string, agentKey: string): string {
	return new SessionPaths({ home: root, slug }).residentDir(agentKey)
}

/**
 * The project a checkout root is filed under, found WITHOUT creating one.
 *
 * The same two slugs `ensureProject` tries, in the same order: the plain
 * slug, then the hashed one when the plain slug's `project.json` names a
 * different directory. A status request must never mint a project, so a
 * missing document ends the search.
 */
export async function findResidentProject(
	root: string,
	projectRoot: string,
): Promise<{ readonly slug: string; readonly projectId: ProjectId } | null> {
	for (const slug of [slugForCwd(projectRoot), hashedSlugForCwd(projectRoot)]) {
		const file = new SessionPaths({ home: root, slug }).projectFile()
		let raw: string
		try {
			const entry = lstatSync(file)
			if (!entry.isFile() || entry.isSymbolicLink())
				throw new Error(`${file} must be a regular file, without a symbolic link.`)
			raw = await readFile(file, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
		const document = ProjectDocumentSchema.parse(JSON.parse(raw))
		if (document.cwd === projectRoot) return { slug, projectId: document.projectId as ProjectId }
	}
	return null
}

interface ResidentBinding {
	readonly version: 1
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly agentKey: string
	readonly cwd: string
}

function validateAgentKey(agentKey: string): void {
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentKey)) {
		throw new Error(
			'Resident agent key must contain 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.',
		)
	}
}

/** Check state boundaries without creating directories or changing their modes. */
function existingDirectory(path: string): boolean {
	try {
		const entry = lstatSync(path)
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Resident state must use a real directory: ${path}`)
		}
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

function readBinding(
	residentsRoot: string,
	expected: Pick<ResidentBinding, 'tenantId' | 'projectId' | 'agentKey'>,
	projectRoot: string,
): ResidentBinding | null {
	const agentRoot = join(residentsRoot, expected.agentKey)
	if (!existingDirectory(residentsRoot) || !existingDirectory(agentRoot)) return null
	const path = join(agentRoot, 'binding.json')
	try {
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error('expected a regular file, without a symbolic link')
		}
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new Error('expected an object')
		}
		const value = raw as Record<string, unknown>
		if (
			value.version !== 1 ||
			value.tenantId !== expected.tenantId ||
			value.projectId !== expected.projectId ||
			value.agentKey !== expected.agentKey
		) {
			throw new Error('version, tenant, project or agent key does not match this resident')
		}
		const cwd = value.cwd
		if (typeof cwd !== 'string' || cwd.includes('\0') || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
			throw new Error('expected an absolute canonical execution directory')
		}
		const withinProject = relative(projectRoot, cwd)
		if (
			withinProject === '..' ||
			withinProject.startsWith(`..${sep}`) ||
			isAbsolute(withinProject)
		) {
			throw new Error('execution directory is outside the bound project')
		}
		return { version: 1, ...expected, cwd }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw new Error(
			`${path} is not a valid resident binding: ${error instanceof Error ? error.message : String(error)}. Refusing to replace it.`,
		)
	}
}

function residentHandle(root: string, slug: string, binding: ResidentBinding): CliResident {
	return {
		agenda: new DiskResidentAgenda(residentsRootFor(root, slug), binding),
		cwd: binding.cwd,
		agentKey: binding.agentKey,
		artifactsRoot: join(residentDirectoryFor(root, slug, binding.agentKey), 'attempts'),
		projectId: binding.projectId,
		tenantId: binding.tenantId,
		root,
		slug,
	}
}

/** Resolve existing state only; a status request never mints identity or state. */
export async function lookupResident(cwd: string, agentKey: string): Promise<CliResident | null> {
	validateAgentKey(agentKey)
	const root = resolveNamzuHome()
	const identity = readIdentity(root)
	if (!identity) return null
	const workingDirectory = await realpath(resolve(cwd))
	const projectRoot = cliProjectRoot(workingDirectory)
	const project = await findResidentProject(root, projectRoot)
	if (!project) return null
	const binding = readBinding(
		residentsRootFor(root, project.slug),
		{ tenantId: identity.tenantId, projectId: project.projectId, agentKey },
		projectRoot,
	)
	return binding ? residentHandle(root, project.slug, binding) : null
}

/** Initialize an explicit operator mutation, reusing the first creator's cwd. */
export async function createResident(cwd: string, agentKey: string): Promise<CliResident> {
	validateAgentKey(agentKey)
	const workingDirectory = await realpath(resolve(cwd))
	const { openSessions } = await import('../sessions/store.js')
	const sessions = await openSessions(workingDirectory)
	const projectRoot = cliProjectRoot(workingDirectory)
	// Opening the sessions files the project; the resident state goes beside it.
	const project = await findResidentProject(sessions.root, projectRoot)
	if (!project || project.projectId !== sessions.projectId)
		throw new Error(
			`The project for ${projectRoot} is not filed under ${join(sessions.root, 'projects')}; refusing to place resident state elsewhere.`,
		)
	const residentsRoot = ensurePrivateStateDirectory(
		new SessionPaths({ home: sessions.root, slug: project.slug }).projectDir(),
		'residents',
	)
	const agentRoot = ensurePrivateStateDirectory(residentsRoot, agentKey)
	const expected = { tenantId: sessions.tenantId, projectId: sessions.projectId, agentKey }
	let binding = readBinding(residentsRoot, expected, projectRoot)
	if (!binding) {
		publishPrivateJsonIfAbsent(join(agentRoot, 'binding.json'), {
			version: 1,
			...expected,
			cwd: workingDirectory,
		})
		binding = readBinding(residentsRoot, expected, projectRoot)
		if (!binding) throw new Error('Resident binding disappeared while it was being initialized.')
	}
	const resident = residentHandle(sessions.root, project.slug, binding)
	let agenda = await resident.agenda.read()
	if (!agenda) {
		try {
			agenda = await resident.agenda.create(MANDATE)
		} catch (error) {
			if (!(error instanceof ResidentConflictError)) throw error
			agenda = await resident.agenda.read()
			if (!agenda) throw error
		}
	}
	if (agenda.identity !== MANDATE) {
		throw new Error('Resident agenda mandate does not match the CLI operator mandate.')
	}
	ensurePrivateStateDirectory(agentRoot, 'attempts')
	return resident
}
