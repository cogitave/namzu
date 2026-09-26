/**
 * Namzu-owned MCP OAuth state. Each complete resource endpoint has its own
 * private file: a token for one path or query must never be sent to another.
 * Discovery and PKCE state share that file so a browser round trip cannot
 * accidentally resume against a different authorization server.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { platform } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type {
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from '@modelcontextprotocol/client'

import { restrictToOwner } from '../providers/credential-store.js'
import { namzuHomePath } from '../state/home.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const PENDING_LIFETIME_MS = 10 * 60 * 1000

export class McpOAuthStoreError extends Error {
	override readonly name = 'McpOAuthStoreError'
}

export class McpOAuthLoginRequiredError extends Error {
	override readonly name = 'McpOAuthLoginRequiredError'
	constructor() {
		super('MCP authorization requires `namzu mcp login <name>`.')
	}
}

interface PendingAuthorization {
	readonly state: string
	readonly codeVerifier?: string
	readonly createdAt: number
	readonly consumed: boolean
	readonly discovery: OAuthDiscoveryState
	/** Token set when this authorization URL was generated. */
	readonly baseTokens: string | null
	/** Client registration whose ID went into this authorization URL. */
	readonly baseClient: string | null
}

interface OAuthRecord {
	readonly version: 1
	readonly endpoint: string
	readonly redirectUrl?: string
	readonly issuer?: string
	readonly clientInformation?: StoredOAuthClientInformation
	readonly tokens?: StoredOAuthTokens
	readonly discovery?: OAuthDiscoveryState
	readonly pending?: PendingAuthorization
}

export interface McpOAuthProviderOptions {
	/** The complete configured MCP URL, including its path and query. */
	readonly endpoint: string
	/** Existing credential-store test seam: the OS home, not NAMZU_HOME. */
	readonly home?: string
	/** The loopback callback for an interactive login. Omit in a running agent. */
	readonly redirectUrl?: string
	/** Only an explicit login may open a browser. */
	readonly onRedirect?: (authorizationUrl: URL) => void | Promise<void>
}

function normalizedEndpoint(value: string): string {
	if (value !== value.trim()) throw new McpOAuthStoreError('Invalid MCP OAuth endpoint.')
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new McpOAuthStoreError('Invalid MCP OAuth endpoint.')
	}
	if (!isSecureMcpOAuthUrl(url)) {
		throw new McpOAuthStoreError(
			'MCP OAuth requires HTTPS or a loopback HTTP endpoint without embedded credentials or a fragment.',
		)
	}
	return url.href
}

/** Shared network policy for interactive sign-in and background token refresh. */
export function isSecureMcpOAuthUrl(url: URL): boolean {
	return (
		(url.protocol === 'https:' ||
			(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
		!url.username &&
		!url.password &&
		!url.hash
	)
}

function normalizedRedirect(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new McpOAuthStoreError('Invalid MCP OAuth callback URL.')
	}
	if (!isSecureMcpOAuthUrl(url)) {
		throw new McpOAuthStoreError('MCP OAuth callback must use HTTPS or loopback HTTP.')
	}
	return url.href
}

/** A hash keeps possibly secret URL path and query values out of file names. */
export function mcpOAuthPath(endpoint: string, home?: string): string {
	const exact = normalizedEndpoint(endpoint)
	const key = createHash('sha256').update(exact).digest('hex')
	return join(namzuHomePath(home), 'mcp-oauth', `${key}.json`)
}

function ensurePrivateDirectory(file: string, home?: string): void {
	const appHome = namzuHomePath(home)
	const storeDir = dirname(file)
	mkdirSync(appHome, { recursive: true, mode: DIR_MODE })
	assertRealDirectory(appHome)
	if (platform() === 'win32') restrictToOwner(appHome)
	mkdirSync(storeDir, { recursive: true, mode: DIR_MODE })
	assertRealDirectory(storeDir)
	restrictToOwner(storeDir)
}

function assertRealDirectory(path: string): void {
	const entry = lstatSync(path)
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new McpOAuthStoreError('MCP OAuth credentials require a real private directory.')
	}
}

function existingEntry(path: string): Stats | null {
	try {
		return lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

function checkPrivateDirectoryForRead(file: string, home?: string): boolean {
	const appHome = namzuHomePath(home)
	const storeDir = dirname(file)
	if (!existingEntry(appHome)) return false
	assertRealDirectory(appHome)
	if (platform() === 'win32') restrictToOwner(appHome)
	if (!existingEntry(storeDir)) return false
	assertRealDirectory(storeDir)
	restrictToOwner(storeDir)
	return true
}

function readRecord(endpoint: string, home?: string): OAuthRecord | null {
	const exact = normalizedEndpoint(endpoint)
	const file = mcpOAuthPath(exact, home)
	if (!checkPrivateDirectoryForRead(file, home)) return null
	const entry = existingEntry(file)
	if (!entry) return null
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new McpOAuthStoreError('MCP OAuth credential file must be a regular file.')
	}
	restrictToOwner(file)
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		throw new McpOAuthStoreError('MCP OAuth credential file is invalid.')
	}
	if (!isRecord(parsed) || parsed.version !== 1 || parsed.endpoint !== exact) {
		throw new McpOAuthStoreError('MCP OAuth credential file does not match its endpoint.')
	}
	const issuer = parsed.issuer
	if (issuer !== undefined && !nonempty(issuer)) {
		throw new McpOAuthStoreError('MCP OAuth credential issuer is invalid.')
	}
	const client = parsed.clientInformation
	if (
		client !== undefined &&
		(!isRecord(client) ||
			!nonempty(client.client_id) ||
			!nonempty(client.issuer) ||
			client.issuer !== issuer)
	) {
		throw new McpOAuthStoreError('MCP OAuth client information has no matching issuer stamp.')
	}
	const tokens = parsed.tokens
	if (
		tokens !== undefined &&
		(!isRecord(tokens) ||
			!nonempty(tokens.access_token) ||
			!nonempty(tokens.token_type) ||
			tokens.token_type.toLowerCase() !== 'bearer' ||
			!nonempty(tokens.issuer) ||
			tokens.issuer !== issuer)
	) {
		throw new McpOAuthStoreError('MCP OAuth tokens have no matching issuer stamp.')
	}
	if (parsed.redirectUrl !== undefined && !nonempty(parsed.redirectUrl)) {
		throw new McpOAuthStoreError('MCP OAuth callback URL is invalid.')
	}
	if (typeof parsed.redirectUrl === 'string') normalizedRedirect(parsed.redirectUrl)
	if (tokens !== undefined && client === undefined) {
		throw new McpOAuthStoreError('MCP OAuth tokens have no client registration.')
	}
	if (parsed.discovery !== undefined) checkedDiscovery(parsed.discovery)
	if (parsed.pending !== undefined) checkedPending(parsed.pending)
	return parsed as unknown as OAuthRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function checkedDiscovery(value: unknown): OAuthDiscoveryState {
	if (!isRecord(value) || !nonempty(value.authorizationServerUrl)) {
		throw new McpOAuthStoreError('MCP OAuth discovery state is invalid.')
	}
	const metadata = value.authorizationServerMetadata
	if (metadata !== undefined && (!isRecord(metadata) || !nonempty(metadata.issuer))) {
		throw new McpOAuthStoreError('MCP OAuth authorization server issuer is invalid.')
	}
	normalizedEndpoint(value.authorizationServerUrl)
	return value as unknown as OAuthDiscoveryState
}

function checkedPending(value: unknown): PendingAuthorization {
	if (
		!isRecord(value) ||
		!nonempty(value.state) ||
		(typeof value.codeVerifier !== 'undefined' && !nonempty(value.codeVerifier)) ||
		typeof value.createdAt !== 'number' ||
		!Number.isFinite(value.createdAt) ||
		typeof value.consumed !== 'boolean' ||
		(value.baseTokens !== null && !nonempty(value.baseTokens)) ||
		(value.baseClient !== null && !nonempty(value.baseClient))
	) {
		throw new McpOAuthStoreError('MCP OAuth login state is invalid.')
	}
	checkedDiscovery(value.discovery)
	return value as unknown as PendingAuthorization
}

function writeRecord(file: string, record: OAuthRecord): void {
	const temp = `${file}.tmp.${process.pid}.${randomBytes(12).toString('hex')}`
	let descriptor: number | undefined
	try {
		const previous = existingEntry(file)
		if (previous) {
			if (!previous.isFile() || previous.isSymbolicLink()) {
				throw new McpOAuthStoreError('MCP OAuth credential file must be a regular file.')
			}
		}
		descriptor = openSync(temp, 'wx', FILE_MODE)
		// Windows file modes do not prove ACL privacy. Secure the empty file first.
		restrictToOwner(temp)
		const body = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
		for (let offset = 0; offset < body.length; ) {
			const written = writeSync(descriptor, body, offset, body.length - offset)
			if (written <= 0) throw new McpOAuthStoreError('Could not write MCP OAuth credentials.')
			offset += written
		}
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined
		restrictToOwner(temp)
		renameSync(temp, file)
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor)
		rmSync(temp, { force: true })
		if (error instanceof McpOAuthStoreError) throw error
		throw new McpOAuthStoreError('Could not store MCP OAuth credentials privately.')
	}
}

function withRecordLock<T>(
	endpoint: string,
	home: string | undefined,
	work: (record: OAuthRecord) => T,
	options: { readonly skipRead?: boolean } = {},
): T {
	const exact = normalizedEndpoint(endpoint)
	const file = mcpOAuthPath(exact, home)
	ensurePrivateDirectory(file, home)
	const lock = `${file}.lock`
	const token = randomBytes(32).toString('hex')
	let descriptor: number | undefined
	try {
		descriptor = openSync(lock, 'wx', FILE_MODE)
		restrictToOwner(lock)
		const bytes = Buffer.from(token, 'utf8')
		for (let offset = 0; offset < bytes.length; ) {
			const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
			if (written <= 0) throw new McpOAuthStoreError('Could not write MCP OAuth store lock.')
			offset += written
		}
		fsyncSync(descriptor)
		closeSync(descriptor)
		descriptor = undefined
	} catch {
		if (descriptor !== undefined) {
			closeSync(descriptor)
			try {
				rmSync(lock, { force: true })
			} catch {
				// The next writer will refuse the unproven lock.
			}
		}
		throw new McpOAuthStoreError('MCP OAuth credential store is locked or cannot be made private.')
	}
	try {
		removeOwnTemporaryFiles(file)
		return work(
			options.skipRead
				? { version: 1, endpoint: exact }
				: (readRecord(exact, home) ?? { version: 1, endpoint: exact }),
		)
	} finally {
		// Never remove a lock replaced by another owner.
		try {
			if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
		} catch {
			// A missing or replaced lock does not undo the credential write.
		}
	}
}

/** Only the endpoint lock owner may remove its private crash leftovers. */
function removeOwnTemporaryFiles(file: string): void {
	const prefix = `${basename(file)}.tmp.`
	for (const entry of readdirSync(dirname(file))) {
		if (!entry.startsWith(prefix) || !/^\d+\.[0-9a-f]{24}$/u.test(entry.slice(prefix.length))) {
			continue
		}
		rmSync(join(dirname(file), entry), { force: true })
	}
}

function updateRecord(
	endpoint: string,
	home: string | undefined,
	transform: (record: OAuthRecord) => OAuthRecord,
): void {
	withRecordLock(endpoint, home, (record) => {
		writeRecord(mcpOAuthPath(endpoint, home), transform(record))
	})
}

function discoveryIssuer(state: OAuthDiscoveryState): string {
	return state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl
}

function fingerprint(value: unknown): string | null {
	return value === undefined
		? null
		: createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** True only for a private, issuer-stamped token belonging to this exact URL. */
export function hasMcpOAuthTokens(endpoint: string, home?: string): boolean {
	const record = readRecord(endpoint, home)
	return !!(record?.issuer && record.tokens?.issuer === record.issuer)
}

/** Validate and consume state before passing callback parameters to `finishAuth`. */
export function consumeMcpOAuthCallbackState(
	endpoint: string,
	state: string | null,
	home?: string,
): void {
	withRecordLock(endpoint, home, (record) => {
		const pending = record.pending
		if (
			!pending ||
			pending.consumed ||
			!pending.codeVerifier ||
			Date.now() - pending.createdAt > PENDING_LIFETIME_MS ||
			pending.createdAt > Date.now() ||
			fingerprint(record.clientInformation) !== pending.baseClient ||
			!state ||
			!sameSecret(state, pending.state)
		) {
			throw new McpOAuthStoreError('MCP OAuth callback state is invalid or expired.')
		}
		writeRecord(mcpOAuthPath(endpoint, home), {
			...record,
			pending: { ...pending, consumed: true },
		})
	})
}

function sameSecret(left: string, right: string): boolean {
	const a = Buffer.from(left)
	const b = Buffer.from(right)
	return a.length === b.length && timingSafeEqual(a, b)
}

export function clearMcpOAuthPending(endpoint: string, home?: string): void {
	withRecordLock(endpoint, home, (record) => {
		if (!record.pending) return
		const { pending: _pending, ...rest } = record
		writeRecord(mcpOAuthPath(endpoint, home), rest)
	})
}

/** Remove only this URL's credentials; another server on the same host survives. */
export function clearMcpOAuthCredentials(endpoint: string, home?: string): boolean {
	return withRecordLock(
		endpoint,
		home,
		(record) => {
			const file = mcpOAuthPath(endpoint, home)
			const entry = existingEntry(file)
			if (!entry) return false
			if (!entry.isFile() || entry.isSymbolicLink()) {
				throw new McpOAuthStoreError('MCP OAuth credential file must be a regular file.')
			}
			if (record.endpoint !== normalizedEndpoint(endpoint)) {
				throw new McpOAuthStoreError('MCP OAuth credential endpoint mismatch.')
			}
			rmSync(file)
			return true
		},
		{ skipRead: true },
	)
}

/** The official MCP client consumes this provider for login and token refresh. */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
	const endpoint = normalizedEndpoint(options.endpoint)
	const interactive = options.onRedirect !== undefined
	if (interactive !== (options.redirectUrl !== undefined)) {
		throw new McpOAuthStoreError(
			'Interactive MCP OAuth requires a callback and browser opener together.',
		)
	}
	const requestedRedirect = options.redirectUrl
		? normalizedRedirect(options.redirectUrl)
		: undefined
	const initial = readRecord(endpoint, options.home)
	const redirect = requestedRedirect ?? initial?.redirectUrl
	if (!redirect) throw new McpOAuthLoginRequiredError()
	const home = options.home
	let observedTokens: string | null | undefined
	let observedClient: string | null | undefined
	return {
		get redirectUrl() {
			return redirect
		},
		get clientMetadata(): OAuthClientMetadata {
			return { redirect_uris: [redirect], client_name: 'Namzu', application_type: 'native' }
		},
		state() {
			if (!interactive) throw new McpOAuthLoginRequiredError()
			const state = randomBytes(32).toString('base64url')
			updateRecord(endpoint, home, (record) => {
				if (!record.discovery) {
					throw new McpOAuthStoreError('MCP OAuth discovery is missing before redirect.')
				}
				return {
					...record,
					pending: {
						state,
						createdAt: Date.now(),
						consumed: false,
						discovery: record.discovery,
						baseTokens: fingerprint(record.tokens),
						baseClient: fingerprint(record.clientInformation),
					},
				}
			})
			return state
		},
		clientInformation(ctx: OAuthClientInformationContext | undefined) {
			const record = readRecord(endpoint, home)
			if (ctx) observedClient = fingerprint(record?.clientInformation)
			if (!ctx?.issuer || !record?.issuer || record.issuer !== ctx.issuer) return undefined
			if (requestedRedirect && record.redirectUrl !== requestedRedirect) return undefined
			return record.clientInformation?.issuer === ctx.issuer ? record.clientInformation : undefined
		},
		saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
			if (!interactive) throw new McpOAuthLoginRequiredError()
			if (!ctx?.issuer || info.issuer !== ctx.issuer || !nonempty(info.client_id)) {
				throw new McpOAuthStoreError('MCP OAuth client information is missing its issuer stamp.')
			}
			updateRecord(endpoint, home, (record) => {
				if (
					observedClient === undefined ||
					fingerprint(record.clientInformation) !== observedClient
				) {
					throw new McpOAuthStoreError(
						'MCP OAuth client registration changed during authorization.',
					)
				}
				const priorClient = record.clientInformation
				const replacing =
					record.issuer !== ctx.issuer ||
					record.redirectUrl !== redirect ||
					priorClient?.client_id !== info.client_id
				return {
					...record,
					issuer: ctx.issuer,
					redirectUrl: redirect,
					clientInformation: info,
					...(replacing ? { tokens: undefined } : {}),
				}
			})
			observedClient = fingerprint(info)
			observedTokens = null
		},
		tokens(ctx?: OAuthClientInformationContext) {
			const record = readRecord(endpoint, home)
			const tokens =
				record?.issuer &&
				(!ctx || ctx.issuer === record.issuer) &&
				record.tokens?.issuer === record.issuer
					? record.tokens
					: undefined
			if (ctx) observedTokens = fingerprint(record?.tokens)
			return tokens
		},
		saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext) {
			if (
				!ctx?.issuer ||
				tokens.issuer !== ctx.issuer ||
				!nonempty(tokens.access_token) ||
				!nonempty(tokens.token_type) ||
				tokens.token_type.toLowerCase() !== 'bearer'
			) {
				throw new McpOAuthStoreError('MCP OAuth requires issuer-stamped Bearer tokens.')
			}
			updateRecord(endpoint, home, (record) => {
				if (record.issuer !== ctx.issuer || record.clientInformation?.issuer !== ctx.issuer) {
					throw new McpOAuthStoreError(
						'MCP OAuth token issuer does not match its client registration.',
					)
				}
				const expected = record.pending?.consumed ? record.pending.baseTokens : observedTokens
				if (expected === undefined || fingerprint(record.tokens) !== expected) {
					throw new McpOAuthStoreError('MCP OAuth credential changed during token refresh.')
				}
				if (
					record.pending?.consumed &&
					fingerprint(record.clientInformation) !== record.pending.baseClient
				) {
					throw new McpOAuthStoreError(
						'MCP OAuth client registration changed during authorization.',
					)
				}
				return { ...record, tokens }
			})
			observedTokens = fingerprint(tokens)
		},
		redirectToAuthorization(url: URL) {
			if (!options.onRedirect) throw new McpOAuthLoginRequiredError()
			return options.onRedirect(url)
		},
		saveCodeVerifier(codeVerifier: string) {
			if (!interactive || !nonempty(codeVerifier)) throw new McpOAuthLoginRequiredError()
			updateRecord(endpoint, home, (record) => {
				if (!record.pending || record.pending.consumed) {
					throw new McpOAuthStoreError('MCP OAuth login state is missing.')
				}
				return { ...record, pending: { ...record.pending, codeVerifier } }
			})
		},
		codeVerifier() {
			const pending = readRecord(endpoint, home)?.pending
			if (!pending?.consumed || !pending.codeVerifier) {
				throw new McpOAuthStoreError('MCP OAuth callback state has not been verified.')
			}
			return pending.codeVerifier
		},
		saveDiscoveryState(state: OAuthDiscoveryState) {
			checkedDiscovery(state)
			updateRecord(endpoint, home, (record) => ({ ...record, discovery: state }))
		},
		discoveryState() {
			const record = readRecord(endpoint, home)
			// The callback must reuse the exact discovery snapshot that generated
			// its authorization URL, even if another process refreshed the cache.
			return record?.pending?.consumed ? record.pending.discovery : record?.discovery
		},
		invalidateCredentials(scope) {
			if (scope === 'all') {
				clearMcpOAuthCredentials(endpoint, home)
				return
			}
			updateRecord(endpoint, home, (record) => {
				if (scope === 'tokens') {
					if (observedTokens === undefined || fingerprint(record.tokens) !== observedTokens) {
						throw new McpOAuthStoreError('MCP OAuth credential changed during token refresh.')
					}
					return { ...record, tokens: undefined }
				}
				if (scope === 'client') {
					if (
						observedClient === undefined ||
						fingerprint(record.clientInformation) !== observedClient
					) {
						throw new McpOAuthStoreError(
							'MCP OAuth client registration changed during authorization.',
						)
					}
					return { ...record, clientInformation: undefined, tokens: undefined, issuer: undefined }
				}
				if (scope === 'verifier') return { ...record, pending: undefined }
				return { ...record, discovery: undefined, pending: undefined }
			})
			if (scope === 'client') {
				observedClient = null
				observedTokens = null
			} else if (scope === 'tokens') {
				observedTokens = null
			}
		},
	}
}

/** The authorization-server identity captured before the browser opened. */
export function pendingMcpOAuthIssuer(endpoint: string, home?: string): string | null {
	const pending = readRecord(endpoint, home)?.pending
	return pending && Date.now() - pending.createdAt <= PENDING_LIFETIME_MS
		? discoveryIssuer(pending.discovery)
		: null
}
