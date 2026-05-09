import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type {
	FileCreateInput,
	FileLink,
	FileListInput,
	FileRecord,
	FileRegistry,
	StorageRef,
	TextDocument,
} from '../index.js'
import { InMemoryBlobStore } from '../inmem/index.js'
import {
	type AuthzCheck,
	type AuthzContext,
	DEFAULT_DOWNLOAD_PATH_ROOTS,
	createFilesRouter,
	isPathWithinRoots,
} from './index.js'

// --- Fixtures -----------------------------------------------------

class InMemoryFileRegistry implements FileRegistry {
	readonly #records = new Map<string, FileRecord>()
	readonly #links: FileLink[] = []
	readonly #docs = new Map<string, TextDocument>()

	async create(input: FileCreateInput): Promise<FileRecord> {
		const now = new Date()
		const id = input.id ?? randomUUID()
		const record: FileRecord = {
			id,
			ownerId: input.ownerId,
			filename: input.filename,
			mimeType: input.mimeType,
			sizeBytes: input.sizeBytes,
			sha256: input.sha256,
			source: input.source,
			storage: input.storage,
			createdAt: now,
			updatedAt: now,
		}
		this.#records.set(id, record)
		for (const link of input.links ?? []) {
			this.#links.push({ ...link, fileId: id, createdAt: now })
		}
		if (input.textDocument) {
			this.#docs.set(id, { ...input.textDocument, fileId: id, updatedAt: now })
		}
		return record
	}

	async link(input: Omit<FileLink, 'createdAt'>): Promise<FileLink> {
		const link: FileLink = { ...input, createdAt: new Date() }
		this.#links.push(link)
		return link
	}

	async unlink(input: Omit<FileLink, 'createdAt'>): Promise<void> {
		for (let i = this.#links.length - 1; i >= 0; i--) {
			const link = this.#links[i]
			if (
				link.fileId === input.fileId &&
				link.scope.type === input.scope.type &&
				link.scope.id === input.scope.id &&
				link.role === input.role
			) {
				this.#links.splice(i, 1)
			}
		}
	}

	async list(input: FileListInput): Promise<FileRecord[]> {
		const matchingLinks = this.#links.filter(
			(link) =>
				link.scope.type === input.scope.type &&
				link.scope.id === input.scope.id &&
				(!input.roles || input.roles.includes(link.role)),
		)
		const seen = new Set<string>()
		const out: FileRecord[] = []
		for (const link of matchingLinks) {
			if (seen.has(link.fileId)) continue
			const record = this.#records.get(link.fileId)
			if (!record) continue
			if (input.ownerId && record.ownerId !== input.ownerId) continue
			seen.add(link.fileId)
			out.push(record)
		}
		return out
	}

	async get(fileId: string): Promise<FileRecord | null> {
		return this.#records.get(fileId) ?? null
	}

	async getTextDocument(fileId: string): Promise<TextDocument | null> {
		return this.#docs.get(fileId) ?? null
	}
}

interface SeededFile {
	readonly record: FileRecord
	readonly bytes: Uint8Array
}

interface Harness {
	readonly registry: InMemoryFileRegistry
	readonly blobStore: InMemoryBlobStore
}

async function buildHarness(): Promise<Harness> {
	return {
		registry: new InMemoryFileRegistry(),
		blobStore: new InMemoryBlobStore(),
	}
}

interface SeedOptions {
	readonly scope: { readonly type: 'project' | 'thread'; readonly id: string }
	readonly role?: 'context' | 'input' | 'output' | 'artifact' | 'doc' | 'memory' | 'attachment'
	readonly orgId: string
	readonly filename?: string
	readonly mimeType?: string
	readonly contents?: string
	readonly storageKey?: string
}

async function seedFile(
	{ registry, blobStore }: Harness,
	options: SeedOptions,
): Promise<SeededFile> {
	const filename = options.filename ?? 'note.txt'
	const mimeType = options.mimeType ?? 'text/plain'
	const bytes = new TextEncoder().encode(options.contents ?? 'hello world')
	const ref: StorageRef = await blobStore.put({
		key: options.storageKey,
		bytes,
		filename,
		mimeType,
	})
	const record = await registry.create({
		ownerId: options.orgId,
		filename,
		mimeType,
		sizeBytes: bytes.byteLength,
		source: 'user_upload',
		storage: ref,
		links: [{ scope: options.scope, role: options.role ?? 'attachment' }],
	})
	return { record, bytes }
}

function authzAccept(orgId: string, userId = 'user_1'): AuthzCheck {
	return async () => ({ orgId, userId }) satisfies AuthzContext
}

function authzDenyButAuthenticated(): AuthzCheck {
	return async (req: Request) => {
		// Return null even though the request looks authenticated; the
		// router decides 401 vs 404 based on header presence.
		void req
		return null
	}
}

function makeRequest(url: string, init?: RequestInit): Request {
	return new Request(url, init)
}

// --- isPathWithinRoots --------------------------------------------

describe('isPathWithinRoots', () => {
	const roots = DEFAULT_DOWNLOAD_PATH_ROOTS

	it('accepts an exact root match', () => {
		expect(isPathWithinRoots('/outputs', roots)).toBe(true)
	})

	it('accepts a path under an allowed root', () => {
		expect(isPathWithinRoots('/mnt/user-data/outputs/report.pdf', roots)).toBe(true)
		expect(isPathWithinRoots('/uploads/sub/dir/file.png', roots)).toBe(true)
	})

	it('rejects an empty path', () => {
		expect(isPathWithinRoots('', roots)).toBe(false)
	})

	it('rejects a relative path', () => {
		expect(isPathWithinRoots('outputs/foo.txt', roots)).toBe(false)
	})

	it('rejects a path outside any root', () => {
		expect(isPathWithinRoots('/etc/passwd', roots)).toBe(false)
	})

	it('rejects a `..` traversal segment', () => {
		expect(isPathWithinRoots('/outputs/../etc/passwd', roots)).toBe(false)
	})

	it('rejects a backslash (Windows-style traversal)', () => {
		expect(isPathWithinRoots('/outputs\\..\\etc\\passwd', roots)).toBe(false)
	})

	it('rejects URL-encoded traversal (case-insensitive)', () => {
		expect(isPathWithinRoots('/outputs/%2e%2e/etc', roots)).toBe(false)
		expect(isPathWithinRoots('/outputs/%2E%2E/etc', roots)).toBe(false)
	})

	it('rejects a prefix-collision sibling directory', () => {
		expect(isPathWithinRoots('/outputs2/foo', roots)).toBe(false)
	})

	it('honours custom roots', () => {
		expect(isPathWithinRoots('/data/x', ['/data'])).toBe(true)
		expect(isPathWithinRoots('/data2/x', ['/data'])).toBe(false)
	})
})

// --- createFilesRouter --------------------------------------------

describe('createFilesRouter — listProjectFiles', () => {
	it('returns 200 and the seeded file list', async () => {
		const harness = await buildHarness()
		await seedFile(harness, {
			scope: { type: 'project', id: 'proj_1' },
			orgId: 'org_1',
			filename: 'a.txt',
			contents: 'a',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.listProjectFiles(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1' } },
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { scopeType: string; scopeId: string; files: unknown[] }
		expect(body.scopeType).toBe('project')
		expect(body.scopeId).toBe('proj_1')
		expect(body.files).toHaveLength(1)
	})

	it('returns 401 when the request is unauthenticated and authz denies', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzDenyButAuthenticated(),
		})

		const res = await router.handlers.listProjectFiles(makeRequest('https://host/x'), {
			params: { orgId: 'org_1', projectId: 'proj_1' },
		})

		expect(res.status).toBe(401)
	})

	it('returns 404 when authz denies but credentials are present', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzDenyButAuthenticated(),
		})

		const res = await router.handlers.listProjectFiles(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1' } },
		)

		expect(res.status).toBe(404)
	})

	it('returns 404 when the resolved orgId does not match the URL', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('other_org'),
		})

		const res = await router.handlers.listProjectFiles(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1' } },
		)

		expect(res.status).toBe(404)
	})

	it('returns 400 when the orgId param is missing', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.listProjectFiles(makeRequest('https://host/x'), {
			params: { projectId: 'proj_1' },
		})

		expect(res.status).toBe(400)
	})
})

describe('createFilesRouter — getProjectFileContent', () => {
	it('streams bytes with content-type, content-length, and content-disposition', async () => {
		const harness = await buildHarness()
		const seeded = await seedFile(harness, {
			scope: { type: 'project', id: 'proj_1' },
			orgId: 'org_1',
			filename: 'spec.md',
			mimeType: 'text/markdown',
			contents: '# title',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.getProjectFileContent(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1', fileId: seeded.record.id } },
		)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('text/markdown')
		expect(res.headers.get('content-length')).toBe(String(seeded.bytes.byteLength))
		expect(res.headers.get('content-disposition')).toContain('filename="spec.md"')
		const buf = new Uint8Array(await res.arrayBuffer())
		expect(buf).toEqual(seeded.bytes)
	})

	it('returns 404 when the fileId is not linked to the scope', async () => {
		const harness = await buildHarness()
		// Seed file under thread scope, then request via project scope.
		await seedFile(harness, {
			scope: { type: 'thread', id: 'thr_1' },
			orgId: 'org_1',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.getProjectFileContent(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1', fileId: 'no_such' } },
		)

		expect(res.status).toBe(404)
	})

	it('returns 410 when the blob is missing from storage', async () => {
		const harness = await buildHarness()
		const seeded = await seedFile(harness, {
			scope: { type: 'project', id: 'proj_1' },
			orgId: 'org_1',
		})
		await harness.blobStore.delete(seeded.record.storage)
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.getProjectFileContent(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1', fileId: seeded.record.id } },
		)

		expect(res.status).toBe(410)
	})
})

describe('createFilesRouter — getProjectFileStorageInfo', () => {
	it('returns 200 with storage metadata as JSON', async () => {
		const harness = await buildHarness()
		const seeded = await seedFile(harness, {
			scope: { type: 'project', id: 'proj_1' },
			orgId: 'org_1',
			filename: 'a.bin',
			mimeType: 'application/octet-stream',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.getProjectFileStorageInfo(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1', fileId: seeded.record.id } },
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			id: string
			filename: string
			mimeType: string
			sizeBytes: number
			storage: { provider: string; key: string }
		}
		expect(body.id).toBe(seeded.record.id)
		expect(body.filename).toBe('a.bin')
		expect(body.mimeType).toBe('application/octet-stream')
		expect(body.sizeBytes).toBe(seeded.bytes.byteLength)
		expect(body.storage.provider).toBe('memory')
		expect(body.storage.key).toBe(seeded.record.storage.key)
	})

	it('returns 404 when the file is not in scope', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.getProjectFileStorageInfo(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', projectId: 'proj_1', fileId: 'missing' } },
		)

		expect(res.status).toBe(404)
	})
})

describe('createFilesRouter — listThreadFiles', () => {
	it('returns 200 with thread-scoped files', async () => {
		const harness = await buildHarness()
		await seedFile(harness, {
			scope: { type: 'thread', id: 'thr_1' },
			orgId: 'org_1',
			filename: 'msg.txt',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.listThreadFiles(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { scopeType: string; scopeId: string; files: unknown[] }
		expect(body.scopeType).toBe('thread')
		expect(body.scopeId).toBe('thr_1')
		expect(body.files).toHaveLength(1)
	})

	it('returns 404 when authz denies for a credentialed user', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzDenyButAuthenticated(),
		})

		const res = await router.handlers.listThreadFiles(
			makeRequest('https://host/x', { headers: { cookie: 'sid=abc' } }),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(404)
	})
})

describe('createFilesRouter — downloadByPath', () => {
	it('streams the matching output file', async () => {
		const harness = await buildHarness()
		const seeded = await seedFile(harness, {
			scope: { type: 'thread', id: 'thr_1' },
			orgId: 'org_1',
			role: 'output',
			filename: 'report.txt',
			mimeType: 'text/plain',
			contents: 'final report',
			storageKey: '/mnt/user-data/outputs/report.txt',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.downloadByPath(
			makeRequest(
				`https://host/x?path=${encodeURIComponent('/mnt/user-data/outputs/report.txt')}`,
				{ headers: { authorization: 'Bearer t' } },
			),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('text/plain')
		const buf = new Uint8Array(await res.arrayBuffer())
		expect(buf).toEqual(seeded.bytes)
	})

	it('returns 400 for a path outside the allowed roots', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.downloadByPath(
			makeRequest(`https://host/x?path=${encodeURIComponent('/etc/passwd')}`, {
				headers: { authorization: 'Bearer t' },
			}),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(400)
	})

	it('returns 400 when the path query param is missing', async () => {
		const harness = await buildHarness()
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.downloadByPath(
			makeRequest('https://host/x', { headers: { authorization: 'Bearer t' } }),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(400)
	})

	it('returns 404 when no file in scope matches the requested path', async () => {
		const harness = await buildHarness()
		// Seed with a different storage key than what the request asks for.
		await seedFile(harness, {
			scope: { type: 'thread', id: 'thr_1' },
			orgId: 'org_1',
			role: 'output',
			storageKey: '/mnt/user-data/outputs/other.txt',
		})
		const router = createFilesRouter({
			...harness,
			authz: authzAccept('org_1'),
		})

		const res = await router.handlers.downloadByPath(
			makeRequest(
				`https://host/x?path=${encodeURIComponent('/mnt/user-data/outputs/missing.txt')}`,
				{ headers: { authorization: 'Bearer t' } },
			),
			{ params: { orgId: 'org_1', threadId: 'thr_1' } },
		)

		expect(res.status).toBe(404)
	})
})
