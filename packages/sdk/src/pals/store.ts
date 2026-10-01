/** Durable, local Pal definitions. Every revision is an immutable, exclusive publication. */
import { randomUUID } from 'node:crypto'
import {
	chmodSync,
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
	DiskPalStoreOptions,
	PalAppearance,
	PalCreate,
	PalDefinition,
	PalModel,
	PalStore,
	PalUpdate,
} from './types.js'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const REVISION_FILE = /^[1-9][0-9]*\.json$/u

export class PalConflictError extends Error {
	override readonly name = 'PalConflictError'
	constructor(readonly id: string) {
		super(`Pal ${id} changed while it was being edited; reload it and try again.`)
	}
}

function palId(id: string): string {
	if (!ID.test(id)) throw new Error('Invalid Pal id.')
	return id
}
function homePath(home: string): string {
	const path = resolve(home)
	mkdirSync(path, { recursive: true, mode: 0o700 })
	const entry = lstatSync(path)
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error('Pal home must be a real directory.')
	const canonical = realpathSync(path)
	if (canonical !== path) throw new Error('Pal root may not contain symlink aliases.')
	return canonical
}
function contained(path: string, root: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function paths(home: string, workspaceRoot: string, id: string) {
	const definitionsRoot = home
	if (contained(workspaceRoot, home) || contained(home, workspaceRoot))
		throw new Error('Pal workspaces must be outside the application home.')
	return {
		definitionsRoot,
		palDir: join(definitionsRoot, id),
		revisions: join(definitionsRoot, id, 'revisions'),
		workspaceRoot,
		workspaces: workspaceRoot,
		workspace: join(workspaceRoot, id),
	}
}
function safeText(value: unknown, key: string, max: number, allowEmpty = false): string {
	if (typeof value !== 'string') throw new Error(`Invalid Pal ${key}.`)
	const text = value.trim()
	const invalidControl = [...text].some((character) => {
		const code = character.charCodeAt(0)
		return (
			code === 127 || (code < 32 && !(allowEmpty && (code === 9 || code === 10 || code === 13)))
		)
	})
	if ((!allowEmpty && !text) || text.length > max || invalidControl)
		throw new Error(`Invalid Pal ${key}.`)

	return text
}
function safeModel(value: unknown): PalModel | null {
	if (value === null) return null
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid Pal model.')
	const object = value as Record<string, unknown>
	if (Object.keys(object).some((key) => key !== 'provider' && key !== 'model'))
		throw new Error('Invalid Pal model.')
	return {
		provider: safeText(object.provider, 'provider', 400),
		model: safeText(object.model, 'model', 400),
	}
}
function safeAppearance(value: unknown): PalAppearance {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid Pal appearance.')
	const object = value as Record<string, unknown>
	const { character, color } = object
	if (
		Object.keys(object).some((key) => key !== 'character' && key !== 'color') ||
		!['pixel', 'sprout', 'spark'].includes(character as string) ||
		!['green', 'blue', 'amber', 'violet', 'rose'].includes(color as string)
	)
		throw new Error('Invalid Pal appearance.')
	return { character, color } as PalAppearance
}
function readRevision(
	home: string,
	workspaceRoot: string,
	id: string,
	revision: number,
): PalDefinition {
	const source = join(paths(home, workspaceRoot, id).revisions, `${revision}.json`)
	assertDirectory(paths(home, workspaceRoot, id).palDir)
	assertDirectory(paths(home, workspaceRoot, id).revisions)
	const file = lstatSync(source)
	if (!file.isFile() || file.isSymbolicLink()) throw new Error('Pal revision must be a real file.')
	const raw = JSON.parse(readFileSync(source, 'utf8')) as Partial<PalDefinition>
	if (
		raw.v !== 1 ||
		raw.kind !== 'pal' ||
		raw.id !== id ||
		raw.revision !== revision ||
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		typeof raw.createdAt !== 'string' ||
		typeof raw.updatedAt !== 'string' ||
		typeof raw.workspace !== 'string' ||
		typeof raw.paused !== 'boolean'
	)
		throw new Error(`Invalid Pal definition ${id} revision ${revision}.`)
	const expected = paths(home, workspaceRoot, id).workspace
	const entry = lstatSync(expected)
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		realpathSync(expected) !== expected ||
		raw.workspace !== expected ||
		contained(expected, home)
	)
		throw new Error(`Pal ${id} workspace identity changed.`)
	return {
		v: 1,
		kind: 'pal',
		id,
		revision,
		name: safeText(raw.name, 'name', 80),
		purpose: safeText(raw.purpose, 'purpose', 4000, true),
		workspace: expected,
		model: safeModel(raw.model),
		...(raw.appearance === undefined ? {} : { appearance: safeAppearance(raw.appearance) }),
		paused: raw.paused,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	}
}

function latestRevision(home: string, workspaceRoot: string, id: string): number | null {
	let names: string[]
	try {
		assertDirectory(paths(home, workspaceRoot, id).palDir)
		assertDirectory(paths(home, workspaceRoot, id).revisions)
		names = readdirSync(paths(home, workspaceRoot, id).revisions)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	const revisions = names
		.filter((name) => REVISION_FILE.test(name))
		.map((name) => Number(name.slice(0, -5)))
		.filter(Number.isSafeInteger)
	return revisions.length ? Math.max(...revisions) : null
}

export class DiskPalStore implements PalStore {
	readonly root: string
	readonly workspaceRoot: string
	private readonly secureDirectory: (path: string) => void
	constructor(options: DiskPalStoreOptions) {
		this.root = homePath(options.root)
		this.workspaceRoot = homePath(options.workspaceRoot)
		if (contained(this.root, this.workspaceRoot) || contained(this.workspaceRoot, this.root))
			throw new Error('Pal registry and workspace roots must not overlap.')
		this.secureDirectory =
			options.secureDirectory ??
			((path) => {
				if (process.platform !== 'win32') chmodSync(path, 0o700)
			})
		this.secureDirectory(this.root)
		this.secureDirectory(this.workspaceRoot)
	}
	get(id: string): PalDefinition | null {
		palId(id)
		assertDirectory(this.root)
		const revision = latestRevision(this.root, this.workspaceRoot, id)
		return revision === null ? null : readRevision(this.root, this.workspaceRoot, id, revision)
	}
	getRevision(id: string, revision: number): PalDefinition {
		palId(id)
		if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid Pal revision.')
		return readRevision(this.root, this.workspaceRoot, id, revision)
	}
	list(): PalDefinition[] {
		assertDirectory(this.root)
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => ID.test(entry.name))
			.map((entry) => this.get(entry.name))
			.filter((pal): pal is PalDefinition => pal !== null)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
	}
	create(input: PalCreate): PalDefinition {
		const name = safeText(input.name, 'name', 80)
		const purpose = safeText(input.purpose ?? '', 'purpose', 4000, true)
		const model = safeModel(input.model ?? null)
		const appearance = input.appearance === undefined ? undefined : safeAppearance(input.appearance)
		const id = randomUUID()
		const at = new Date().toISOString()
		const p = paths(this.root, this.workspaceRoot, id)
		assertDirectory(this.root)
		assertDirectory(this.workspaceRoot)
		// Exclusive directory allocation: pre-existing contents are never adopted or trusted.
		mkdirSync(p.workspace, { mode: 0o700 })
		this.secureDirectory(p.workspace)
		assertDirectory(p.workspace)
		if (readdirSync(p.workspace).length !== 0) throw new Error('New Pal workspace must be empty.')
		mkdirSync(p.palDir, { mode: 0o700 })
		this.secureDirectory(p.palDir)
		mkdirSync(p.revisions, { mode: 0o700 })
		this.secureDirectory(p.revisions)
		const definition: PalDefinition = {
			v: 1,
			kind: 'pal',
			id,
			name,
			purpose,
			workspace: p.workspace,
			model,
			...(appearance === undefined ? {} : { appearance }),
			paused: false,
			revision: 1,
			createdAt: at,
			updatedAt: at,
		}
		if (!publishExclusive(join(p.revisions, '1.json'), definition)) throw new PalConflictError(id)
		return definition
	}
	update(id: string, expectedRevision: number, changes: PalUpdate): PalDefinition {
		palId(id)
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
			throw new Error('Invalid Pal revision.')
		const current = this.get(id)
		if (!current) throw new Error('Pal does not exist.')
		if (current.revision !== expectedRevision) throw new PalConflictError(id)
		const next: PalDefinition = {
			...current,
			...(changes.name === undefined ? {} : { name: safeText(changes.name, 'name', 80) }),
			...(changes.purpose === undefined
				? {}
				: { purpose: safeText(changes.purpose, 'purpose', 4000, true) }),
			...(changes.model === undefined ? {} : { model: safeModel(changes.model) }),
			...(changes.appearance === undefined
				? {}
				: { appearance: safeAppearance(changes.appearance) }),
			...(changes.paused === undefined ? {} : { paused: changes.paused }),
			revision: expectedRevision + 1,
			updatedAt: new Date().toISOString(),
		}
		if (typeof next.paused !== 'boolean' || !Number.isSafeInteger(next.revision))
			throw new Error('Invalid Pal change.')
		if (
			!publishExclusive(
				join(paths(this.root, this.workspaceRoot, id).revisions, `${next.revision}.json`),
				next,
			)
		)
			throw new PalConflictError(id)
		return next
	}
	/** Exact validated host control directory; never an execution-computer claim. */
	atWorkspace(cwd: string): PalDefinition | null {
		const lexical = resolve(cwd)
		const canonical = realpathSync(lexical)
		const lexicalReserved = contained(lexical, this.workspaceRoot)
		const canonicalReserved = contained(canonical, this.workspaceRoot)
		if (!lexicalReserved && !canonicalReserved) return null
		if (lexical !== canonical) throw new Error('Pal workspace is a symlink alias.')
		const rel = relative(this.workspaceRoot, canonical)
		if (!ID.test(rel))
			throw new Error(
				'Reserved Pal control directories cannot run ordinary host sessions. Open the exact Pal workspace.',
			)
		const pal = this.get(rel)
		if (!pal || pal.workspace !== canonical)
			throw new Error('Pal workspace has no matching definition.')
		return pal
	}
}
function assertDirectory(path: string): void {
	const entry = lstatSync(path)
	if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path)
		throw new Error(`Pal directory identity changed: ${path}`)
}
function publishExclusive(path: string, value: unknown): boolean {
	const temporary = join(dirname(path), `.pal-${randomUUID()}.tmp`)
	const fd = openSync(temporary, 'wx', 0o600)
	try {
		writeSync(fd, `${JSON.stringify(value)}\n`)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	try {
		linkSync(temporary, path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw error
	} finally {
		unlinkSync(temporary)
	}
}
