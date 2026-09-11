import { lstatSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
	DefaultPathBuilder,
	DiskResidentAgenda,
	DiskSessionStore,
	type ProjectId,
	ResidentConflictError,
	type TenantId,
} from '@namzu/sdk'

import { resolveNamzuHome } from '../state/home.js'
import { readIdentity } from '../state/identity.js'
import { publishPrivateJsonIfAbsent } from '../state/immutable-json.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { cliProjectRoot, findCliProject } from '../state/project.js'

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
	/** Installation state root, never a second resident-specific hierarchy. */
	readonly root: string
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

function residentHandle(
	root: string,
	residentsRoot: string,
	binding: ResidentBinding,
): CliResident {
	return {
		agenda: new DiskResidentAgenda(residentsRoot, binding),
		cwd: binding.cwd,
		agentKey: binding.agentKey,
		artifactsRoot: join(residentsRoot, binding.agentKey, 'attempts'),
		projectId: binding.projectId,
		tenantId: binding.tenantId,
		root,
	}
}

/** Resolve existing state only; a status request never mints identity or state. */
export async function lookupResident(cwd: string, agentKey: string): Promise<CliResident | null> {
	validateAgentKey(agentKey)
	const root = resolveNamzuHome()
	const identity = readIdentity(root)
	if (!identity) return null
	const workingDirectory = await realpath(resolve(cwd))
	const store = new DiskSessionStore({ rootDir: root })
	const project = await findCliProject(store, workingDirectory, identity.tenantId)
	if (!project) return null
	const projectStateRoot = new DefaultPathBuilder(root).projectDir(project.id)
	const residentsRoot = join(projectStateRoot, 'cli', 'residents')
	const binding = readBinding(
		residentsRoot,
		{ tenantId: identity.tenantId, projectId: project.id, agentKey },
		cliProjectRoot(workingDirectory),
	)
	return binding ? residentHandle(root, residentsRoot, binding) : null
}

/** Initialize an explicit operator mutation, reusing the first creator's cwd. */
export async function createResident(cwd: string, agentKey: string): Promise<CliResident> {
	validateAgentKey(agentKey)
	const workingDirectory = await realpath(resolve(cwd))
	const { openSessions } = await import('../sessions/store.js')
	const sessions = await openSessions(workingDirectory)
	const residentsRoot = ensurePrivateStateDirectory(sessions.controlRoot, 'residents')
	const agentRoot = ensurePrivateStateDirectory(residentsRoot, agentKey)
	const expected = { tenantId: sessions.tenantId, projectId: sessions.projectId, agentKey }
	const projectRoot = cliProjectRoot(workingDirectory)
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
	const resident = residentHandle(sessions.root, residentsRoot, binding)
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
