// HTTP route handler factory: createFilesRouter({ registry, blobStore, authz }).
// Returns Web Standards (Request/Response) handlers for the canonical
// URL layout. Next.js App Router consumes them directly; thin Hono /
// Express adapters can be layered on top in a later phase. URL semantics
// and path-traversal protection live here; Vandal merely wires the
// routes into its host framework.

import type { BlobStore, FileRecord, FileRegistry, FileRole, FileScopeType } from '../index.js'

/**
 * Path roots accepted by `downloadByPath`. The defaults match the
 * legacy `claude.ai`-style sandbox conventions used by Namzu agents:
 * `/mnt/user-data/{outputs,uploads}` and the shorter `/{outputs,uploads}`.
 * Operators can override with `FilesRouterOptions.downloadPathRoots`.
 */
export const DEFAULT_DOWNLOAD_PATH_ROOTS: readonly string[] = Object.freeze([
	'/mnt/user-data/outputs',
	'/mnt/user-data/uploads',
	'/outputs',
	'/uploads',
])

/** Roles eligible for path-based download lookups. */
const DOWNLOAD_BY_PATH_ROLES: readonly FileRole[] = ['output', 'artifact', 'attachment', 'input']

export interface AuthzContext {
	readonly userId: string
	readonly orgId: string
}

/**
 * Authorisation hook supplied by the host. The implementation should
 * resolve the request's user, confirm membership of the addressed
 * scope, and return an `AuthzContext` on success or `null` on deny.
 *
 * The router cannot distinguish "no credentials" from "authenticated
 * but not a scope member" purely from the `null` return — handlers
 * inspect the request's `authorization`/`cookie` headers to decide
 * whether to respond with 401 (unauthenticated) or 404 (mirroring
 * claude.ai's "leak nothing about other tenants" pattern).
 */
export type AuthzCheck = (
	req: Request,
	scope: { readonly type: FileScopeType; readonly id: string },
) => Promise<AuthzContext | null>

export interface FilesRouterOptions {
	readonly registry: FileRegistry
	readonly blobStore: BlobStore
	readonly authz: AuthzCheck
	/** Path-based download whitelist roots. Defaults to `DEFAULT_DOWNLOAD_PATH_ROOTS`. */
	readonly downloadPathRoots?: readonly string[]
}

export interface RouteContext {
	/** Route params resolved by the host framework (e.g. Next.js dynamic segments). */
	readonly params: Readonly<Record<string, string>>
}

export type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response>

export interface FilesRouterHandlers {
	/** GET .../organizations/{orgId}/projects/{projectId}/files */
	readonly listProjectFiles: RouteHandler
	/** GET .../organizations/{orgId}/projects/{projectId}/files/{fileId}/content */
	readonly getProjectFileContent: RouteHandler
	/** GET .../organizations/{orgId}/projects/{projectId}/files/{fileId}/storage/info */
	readonly getProjectFileStorageInfo: RouteHandler
	/** GET .../organizations/{orgId}/conversations/{threadId}/files */
	readonly listThreadFiles: RouteHandler
	/** GET .../organizations/{orgId}/conversations/{threadId}/files/{fileId}/content */
	readonly getThreadFileContent: RouteHandler
	/** GET .../organizations/{orgId}/conversations/{threadId}/namzu/download-file?path=... */
	readonly downloadByPath: RouteHandler
}

export interface FilesRouter {
	readonly handlers: FilesRouterHandlers
}

/**
 * Path-traversal guard for the `download-file?path=...` endpoint.
 *
 * Returns `true` only when `path`:
 * - is non-empty and absolute (`startsWith('/')`),
 * - contains no `..` segments (raw or URL-encoded `%2e%2e`,
 *   case-insensitive),
 * - contains no backslashes (Windows path injection),
 * - lies under one of the allowed roots, where each root is matched
 *   as a strict directory prefix (the root itself or `<root>/...`).
 *   `/outputs2/foo` does NOT match the root `/outputs`.
 */
export function isPathWithinRoots(path: string, roots: readonly string[]): boolean {
	if (!path) return false
	if (!path.startsWith('/')) return false
	if (path.includes('\\')) return false

	const lower = path.toLowerCase()
	if (lower.includes('%2e%2e')) return false

	const segments = path.split('/')
	for (const segment of segments) {
		if (segment === '..') return false
	}

	for (const root of roots) {
		if (path === root) return true
		const rootWithSlash = root.endsWith('/') ? root : `${root}/`
		if (path.startsWith(rootWithSlash)) return true
	}
	return false
}

interface ResolvedScope {
	readonly type: FileScopeType
	readonly id: string
}

interface ScopeResolution {
	readonly auth: AuthzContext
	readonly scope: ResolvedScope
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function isAuthenticatedRequest(req: Request): boolean {
	const auth = req.headers.get('authorization')
	if (auth && auth.trim().length > 0) return true
	const cookie = req.headers.get('cookie')
	if (cookie && cookie.trim().length > 0) return true
	return false
}

async function resolveScope(
	req: Request,
	options: FilesRouterOptions,
	scope: ResolvedScope,
	expectedOrgId: string,
): Promise<ScopeResolution | Response> {
	const auth = await options.authz(req, scope)
	if (!auth) {
		return isAuthenticatedRequest(req)
			? jsonResponse(404, { error: 'not_found' })
			: jsonResponse(401, { error: 'unauthenticated' })
	}
	if (auth.orgId !== expectedOrgId) {
		return jsonResponse(404, { error: 'not_found' })
	}
	return { auth, scope }
}

function serialiseFileRecord(record: FileRecord): Record<string, unknown> {
	return {
		id: record.id,
		ownerId: record.ownerId,
		filename: record.filename,
		mimeType: record.mimeType,
		sizeBytes: record.sizeBytes,
		sha256: record.sha256,
		source: record.source,
		storage: {
			provider: record.storage.provider,
			key: record.storage.key,
			etag: record.storage.etag,
			sizeBytes: record.storage.sizeBytes,
			downloadable: record.storage.downloadable,
		},
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	}
}

function serialiseStorageInfo(record: FileRecord): Record<string, unknown> {
	return {
		id: record.id,
		filename: record.filename,
		mimeType: record.mimeType,
		sizeBytes: record.sizeBytes,
		sha256: record.sha256,
		storage: {
			provider: record.storage.provider,
			key: record.storage.key,
			etag: record.storage.etag,
			downloadable: record.storage.downloadable,
		},
		createdAt: record.createdAt.toISOString(),
		updatedAt: record.updatedAt.toISOString(),
	}
}

function contentDispositionHeader(filename: string): string {
	// RFC 6266 / 5987: quote and backslash-escape for the ASCII form,
	// and add filename* with UTF-8 percent-encoding when the original
	// contains non-ASCII characters.
	const escapedQuoted = filename.replace(/["\\]/g, '\\$&')
	const asciiSafe = escapedQuoted.replace(/[^\x20-\x7e]/g, '_')
	const encoded = encodeURIComponent(filename)
	return asciiSafe === escapedQuoted
		? `attachment; filename="${asciiSafe}"`
		: `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`
}

async function streamRecord(record: FileRecord, options: FilesRouterOptions): Promise<Response> {
	const blob = await options.blobStore.get(record.storage)
	if (!blob) {
		return jsonResponse(410, { error: 'blob_missing' })
	}
	const headers = new Headers({
		'content-type': record.mimeType || 'application/octet-stream',
		'content-length': String(record.sizeBytes),
		'content-disposition': contentDispositionHeader(record.filename),
	})
	// `Uint8Array` satisfies BodyInit in modern runtimes (Node 18+, Bun, browsers).
	return new Response(blob.bytes, { status: 200, headers })
}

function requireParam(params: Readonly<Record<string, string>>, name: string): string | Response {
	const value = params[name]
	if (!value || value.trim().length === 0) {
		return jsonResponse(400, { error: 'missing_param', param: name })
	}
	return value
}

export function createFilesRouter(options: FilesRouterOptions): FilesRouter {
	const roots = options.downloadPathRoots ?? DEFAULT_DOWNLOAD_PATH_ROOTS

	const listProjectFiles: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const projectId = requireParam(ctx.params, 'projectId')
		if (projectId instanceof Response) return projectId

		const resolved = await resolveScope(req, options, { type: 'project', id: projectId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({ scope: resolved.scope })
		return jsonResponse(200, {
			scopeType: 'project',
			scopeId: projectId,
			files: files.map(serialiseFileRecord),
		})
	}

	const getProjectFileContent: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const projectId = requireParam(ctx.params, 'projectId')
		if (projectId instanceof Response) return projectId
		const fileId = requireParam(ctx.params, 'fileId')
		if (fileId instanceof Response) return fileId

		const resolved = await resolveScope(req, options, { type: 'project', id: projectId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({ scope: resolved.scope })
		const record = files.find((f) => f.id === fileId)
		if (!record) return jsonResponse(404, { error: 'not_found' })
		return streamRecord(record, options)
	}

	const getProjectFileStorageInfo: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const projectId = requireParam(ctx.params, 'projectId')
		if (projectId instanceof Response) return projectId
		const fileId = requireParam(ctx.params, 'fileId')
		if (fileId instanceof Response) return fileId

		const resolved = await resolveScope(req, options, { type: 'project', id: projectId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({ scope: resolved.scope })
		const record = files.find((f) => f.id === fileId)
		if (!record) return jsonResponse(404, { error: 'not_found' })
		return jsonResponse(200, serialiseStorageInfo(record))
	}

	const listThreadFiles: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const threadId = requireParam(ctx.params, 'threadId')
		if (threadId instanceof Response) return threadId

		const resolved = await resolveScope(req, options, { type: 'thread', id: threadId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({ scope: resolved.scope })
		return jsonResponse(200, {
			scopeType: 'thread',
			scopeId: threadId,
			files: files.map(serialiseFileRecord),
		})
	}

	const getThreadFileContent: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const threadId = requireParam(ctx.params, 'threadId')
		if (threadId instanceof Response) return threadId
		const fileId = requireParam(ctx.params, 'fileId')
		if (fileId instanceof Response) return fileId

		const resolved = await resolveScope(req, options, { type: 'thread', id: threadId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({ scope: resolved.scope })
		const record = files.find((f) => f.id === fileId)
		if (!record) return jsonResponse(404, { error: 'not_found' })
		return streamRecord(record, options)
	}

	const downloadByPath: RouteHandler = async (req, ctx) => {
		const orgId = requireParam(ctx.params, 'orgId')
		if (orgId instanceof Response) return orgId
		const threadId = requireParam(ctx.params, 'threadId')
		if (threadId instanceof Response) return threadId

		const url = new URL(req.url)
		const rawPath = url.searchParams.get('path') ?? ''
		if (!isPathWithinRoots(rawPath, roots)) {
			return jsonResponse(400, { error: 'invalid_path' })
		}

		const resolved = await resolveScope(req, options, { type: 'thread', id: threadId }, orgId)
		if (resolved instanceof Response) return resolved

		const files = await options.registry.list({
			scope: resolved.scope,
			roles: DOWNLOAD_BY_PATH_ROLES,
		})
		const record = files.find((f) => f.storage.key === rawPath)
		if (!record) return jsonResponse(404, { error: 'not_found' })
		return streamRecord(record, options)
	}

	return {
		handlers: {
			listProjectFiles,
			getProjectFileContent,
			getProjectFileStorageInfo,
			listThreadFiles,
			getThreadFileContent,
			downloadByPath,
		},
	}
}
