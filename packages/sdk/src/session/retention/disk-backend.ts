/**
 * DiskArchiveBackend — reference filesystem-backed {@link ArchiveBackend}.
 *
 * Convention #8 (atomic writes): every file lands via write-tmp-rename; the
 * final `archive.json` marker is written LAST so a crash mid-bundle leaves
 * the directory visible but UN-marked, and `restore` treats such a bundle
 * as missing. This mirrors the Phase 5 materializer's "marker-last"
 * invariant.
 *
 * Layout:
 *
 *   {rootDir}/archive/{arc_<opaque>}/
 *     subsession.json        # Identity + metadata
 *     summary.json            # SessionSummaryRef (optional — present iff input.summaryRef)
 *     messages.jsonl          # One SessionMessage per line (append-style, serialized once)
 *     workspace.json          # WorkspaceRef (optional — present iff input.workspace)
 *     archive.json            # Marker — final write; presence = bundle committed
 *
 * Workspace directory contents are NOT archived — we persist the
 * {@link WorkspaceRef} only. The pattern doc §12.3 explicitly allows this:
 * the ref is the re-hydration handle; the worktree itself is disposed at
 * archive time via the caller's {@link WorkspaceBackendDriver}, not copied
 * into the archive bundle. This is a Phase 8 interpretation — see the
 * roadmap deliverable report for rationale (tar bundling deferred).
 *
 * See session-hierarchy.md §12.3.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId, SubSessionId, TenantId } from '../../types/ids/index.js'
import type { ArchiveBackendRef } from '../../types/retention/archive-backend-ref.js'
import type { SessionMessage } from '../../types/session/messages.js'
import type { SessionSummaryRef } from '../../types/summary/ref.js'
import type { WorkspaceRef } from '../../types/workspace/ref.js'
import type { ArchiveBackend, ArchiveInput, ArchiveOutput } from './backend.js'

/**
 * Raised when {@link DiskArchiveBackend.restore} cannot resolve the supplied
 * ref — either the directory is missing, or the `archive.json` marker is
 * absent (crash-mid-write signal).
 */
export class ArchiveNotFoundError extends Error {
	readonly details: { archiveRef: ArchiveBackendRef; reason: 'missing' | 'incomplete' }

	constructor(details: { archiveRef: ArchiveBackendRef; reason: 'missing' | 'incomplete' }) {
		super(`Archive ${details.archiveRef} could not be resolved: ${details.reason}`)
		this.name = 'ArchiveNotFoundError'
		this.details = details
	}
}

/**
 * Config for {@link DiskArchiveBackend}. `rootDir` is absolute — bundles land
 * under `{rootDir}/archive/`.
 */
export interface DiskArchiveBackendConfig {
	readonly rootDir: string
}

interface PersistedSubSessionEntry {
	readonly subSessionId: SubSessionId
	readonly sessionId: SessionId
	readonly tenantId: TenantId
}

interface PersistedWorkspaceEntry {
	readonly workspace: WorkspaceRef
}

interface PersistedSummaryEntry {
	readonly summary: SessionSummaryRef
}

interface PersistedMessageLine {
	readonly id: SessionMessage['id']
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly message: SessionMessage['message']
	readonly at: string
}

interface PersistedArchiveMarker {
	readonly archiveRef: ArchiveBackendRef
	readonly archivedAt: string
}

export class DiskArchiveBackend implements ArchiveBackend {
	readonly kind = 'disk'
	private readonly rootDir: string

	constructor(config: DiskArchiveBackendConfig) {
		this.rootDir = config.rootDir
	}

	async store(input: ArchiveInput): Promise<ArchiveOutput> {
		const archiveRef = generateArchiveBackendRef()
		const archivedAt = new Date()
		const dir = join(this.rootDir, 'archive', archiveRef)
		await mkdir(dir, { recursive: true })

		// 1. Sub-session identity.
		const subEntry: PersistedSubSessionEntry = {
			subSessionId: input.subSessionId,
			sessionId: input.sessionId,
			tenantId: input.tenantId,
		}
		await atomicWriteJson(join(dir, 'subsession.json'), subEntry)

		// 2. Summary (optional).
		if (input.summaryRef) {
			const entry: PersistedSummaryEntry = { summary: serializeSummaryFields(input.summaryRef) }
			await atomicWriteJson(join(dir, 'summary.json'), entry)
		}

		// 3. Workspace ref (optional).
		if (input.workspace) {
			const entry: PersistedWorkspaceEntry = {
				workspace: serializeWorkspaceFields(input.workspace),
			}
			await atomicWriteJson(join(dir, 'workspace.json'), entry)
		}

		// 4. Messages — one JSON per line, serialized once with an atomic
		//    tmp-rename. No append I/O: we have the full bundle upfront, and
		//    single-write is atomic at the file level.
		const lines = input.messages.map((m) => {
			const line: PersistedMessageLine = {
				id: m.id,
				sessionId: m.sessionId,
				tenantId: m.tenantId,
				message: m.message,
				at: m.at.toISOString(),
			}
			return JSON.stringify(line)
		})
		const body = lines.length > 0 ? `${lines.join('\n')}\n` : ''
		await atomicWriteText(join(dir, 'messages.jsonl'), body)

		// 5. Marker — ALWAYS last. Presence = bundle committed.
		const marker: PersistedArchiveMarker = {
			archiveRef,
			archivedAt: archivedAt.toISOString(),
		}
		await atomicWriteJson(join(dir, 'archive.json'), marker)

		return { archiveRef, archivedAt }
	}

	async restore(archiveRef: ArchiveBackendRef): Promise<ArchiveInput> {
		const dir = join(this.rootDir, 'archive', archiveRef)

		// Directory must exist.
		try {
			await readdir(dir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') {
				throw new ArchiveNotFoundError({ archiveRef, reason: 'missing' })
			}
			throw err
		}

		// Marker must exist — absence = crash-mid-write.
		const marker = await readJson<PersistedArchiveMarker>(join(dir, 'archive.json'))
		if (!marker) {
			throw new ArchiveNotFoundError({ archiveRef, reason: 'incomplete' })
		}

		const subEntry = await readJson<PersistedSubSessionEntry>(join(dir, 'subsession.json'))
		if (!subEntry) {
			throw new ArchiveNotFoundError({ archiveRef, reason: 'incomplete' })
		}

		const summaryEntry = await readJson<PersistedSummaryEntry>(join(dir, 'summary.json'))
		const summaryRef = summaryEntry ? deserializeSummaryFields(summaryEntry.summary) : undefined

		const workspaceEntry = await readJson<PersistedWorkspaceEntry>(join(dir, 'workspace.json'))
		const workspace = workspaceEntry
			? deserializeWorkspaceFields(workspaceEntry.workspace)
			: undefined

		const messagesRaw = await readText(join(dir, 'messages.jsonl'))
		const messages: SessionMessage[] =
			messagesRaw === null
				? []
				: messagesRaw
						.split('\n')
						.filter((l) => l.length > 0)
						.map((l) => {
							const raw = JSON.parse(l) as PersistedMessageLine
							return {
								id: raw.id,
								sessionId: raw.sessionId,
								tenantId: raw.tenantId,
								message: raw.message,
								at: new Date(raw.at),
							}
						})

		return {
			subSessionId: subEntry.subSessionId,
			sessionId: subEntry.sessionId,
			tenantId: subEntry.tenantId,
			...(workspace !== undefined && { workspace }),
			...(summaryRef !== undefined && { summaryRef }),
			messages,
		}
	}
}

// Serialization helpers ------------------------------------------------------

function serializeSummaryFields(s: SessionSummaryRef): SessionSummaryRef {
	// Dates survive JSON round-trip as strings; we let JSON.stringify handle
	// the normal `toJSON` path but store them as ISO strings on the wire.
	// On deserialize we coerce back. The in-memory record stays immutable.
	return s
}

function deserializeSummaryFields(s: SessionSummaryRef): SessionSummaryRef {
	// JSON revives Dates as strings — resurrect them.
	const at = s.at instanceof Date ? s.at : new Date(s.at as unknown as string)
	const keyDecisions = s.keyDecisions.map((k) => ({
		at: k.at instanceof Date ? k.at : new Date(k.at as unknown as string),
		summary: k.summary,
	}))
	return { ...s, at, keyDecisions }
}

function serializeWorkspaceFields(w: WorkspaceRef): WorkspaceRef {
	return w
}

function deserializeWorkspaceFields(w: WorkspaceRef): WorkspaceRef {
	const createdAt =
		w.createdAt instanceof Date ? w.createdAt : new Date(w.createdAt as unknown as string)
	return { ...w, createdAt }
}

// ID generation --------------------------------------------------------------

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const MAX_UNIFORM_BYTE = Math.floor(256 / ALPHABET.length) * ALPHABET.length

/**
 * Mints an {@link ArchiveBackendRef}. Local helper rather than a `utils/id`
 * export because the ref's uniqueness + prefix is an archive-backend concern
 * — other backends may mint refs very differently (e.g. S3 keys).
 */
function generateArchiveBackendRef(length = 12): ArchiveBackendRef {
	let suffix = ''
	let remaining = length
	while (remaining > 0) {
		const bytes = randomBytes(remaining + 8)
		for (const byte of bytes) {
			if (remaining <= 0) break
			if (byte < MAX_UNIFORM_BYTE) {
				suffix += ALPHABET[byte % ALPHABET.length]
				remaining--
			}
		}
	}
	return `arc_${suffix}` as ArchiveBackendRef
}

// FS helpers -----------------------------------------------------------------

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteText(filePath, JSON.stringify(value, null, 2))
}

async function atomicWriteText(filePath: string, body: string): Promise<void> {
	const tempPath = `${filePath}.tmp`
	try {
		await writeFile(tempPath, body, 'utf-8')
		await rename(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		const raw = await readFile(path, 'utf-8')
		return JSON.parse(raw) as T
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw err
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf-8')
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw err
	}
}
