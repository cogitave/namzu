import { posix } from 'node:path'
import { MCPClient, type PalEnvironmentLease, type Toolset, mcpToolset } from '@namzu/sdk'
import type { ConnectedMcpServer, FailedMcpServer } from '../integrations/mcp/servers.js'
import { PalGuestMcpTransport } from './guest-mcp-transport.js'

export const PAL_GUEST_MCP_MANIFEST = '/home/namzu/.config/namzu/mcp.json'
const MAX_MANIFEST_BYTES = 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000

export interface PalGuestMcpServer {
	readonly name: string
	readonly outcomeProtocol: 'namzu-v1'
	readonly command: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	readonly allow: readonly string[]
	readonly requestTimeoutMs?: number
}

function absoluteGuestPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 4096 &&
		!value.includes('\0') &&
		!value.includes('\\') &&
		posix.isAbsolute(value) &&
		posix.normalize(value) === value
	)
}

/** A guest installation is explicit; no host config, environment expansion or HTTP endpoint. */
export function parsePalGuestMcpManifest(bytes: Uint8Array): readonly PalGuestMcpServer[] {
	if (bytes.byteLength > MAX_MANIFEST_BYTES)
		throw new Error('The guest MCP manifest exceeds 64 KiB.')
	const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('The guest MCP manifest must be an object.')
	const manifest = value as Record<string, unknown>
	if (
		manifest.version !== 1 ||
		Object.keys(manifest).some((key) => key !== 'version' && key !== 'servers') ||
		!Array.isArray(manifest.servers) ||
		manifest.servers.length > 16
	)
		throw new Error('The guest MCP manifest requires version 1 and at most 16 servers.')
	const names = new Set<string>()
	return manifest.servers.map((value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('A guest MCP server must be an object.')
		const server = value as Record<string, unknown>
		if (
			Object.keys(server).some(
				(key) =>
					![
						'name',
						'outcomeProtocol',
						'command',
						'args',
						'cwd',
						'env',
						'allow',
						'requestTimeoutMs',
					].includes(key),
			)
		)
			throw new Error('A guest MCP server contains an unsupported field.')
		if (typeof server.name !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(server.name))
			throw new Error('A guest MCP server requires a lowercase name.')
		if (names.has(server.name)) throw new Error(`Duplicate guest MCP server "${server.name}".`)
		names.add(server.name)
		if (server.outcomeProtocol !== 'namzu-v1')
			throw new Error(
				`Guest MCP server "${server.name}" requires the reviewed namzu-v1 outcome bridge.`,
			)
		if (!absoluteGuestPath(server.command))
			throw new Error(`Guest MCP server "${server.name}" requires an absolute guest command.`)
		if (server.cwd !== undefined && !absoluteGuestPath(server.cwd))
			throw new Error(`Guest MCP server "${server.name}" requires an absolute guest cwd.`)
		if (
			server.args !== undefined &&
			(!Array.isArray(server.args) ||
				server.args.length > 64 ||
				!server.args.every(
					(arg: unknown) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'),
				))
		)
			throw new Error(`Guest MCP server "${server.name}" has invalid arguments.`)
		if (
			!Array.isArray(server.allow) ||
			server.allow.length === 0 ||
			server.allow.length > 128 ||
			!server.allow.every(
				(name: unknown) => typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(name),
			)
		)
			throw new Error(`Guest MCP server "${server.name}" requires an explicit tool allowlist.`)
		if (server.env !== undefined) {
			if (!server.env || typeof server.env !== 'object' || Array.isArray(server.env))
				throw new Error(`Guest MCP server "${server.name}" has invalid environment values.`)
			const entries = Object.entries(server.env)
			if (
				entries.length > 64 ||
				entries.some(
					([key, value]) =>
						!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
						key.startsWith('NAMZU_SANDBOX_') ||
						typeof value !== 'string' ||
						value.length > 8192 ||
						value.includes('\0'),
				)
			)
				throw new Error(`Guest MCP server "${server.name}" has invalid environment values.`)
		}
		if (
			server.requestTimeoutMs !== undefined &&
			(typeof server.requestTimeoutMs !== 'number' ||
				!Number.isSafeInteger(server.requestTimeoutMs) ||
				server.requestTimeoutMs < 1000 ||
				server.requestTimeoutMs > 300_000)
		)
			throw new Error(`Guest MCP server "${server.name}" requires a 1–300 second request deadline.`)
		return structuredClone(server) as unknown as PalGuestMcpServer
	})
}

export interface PalGuestMcpConnection {
	readonly toolsets: readonly Toolset[]
	readonly connected: readonly ConnectedMcpServer[]
	readonly failed: readonly FailedMcpServer[]
}

export async function connectPalGuestMcp(
	lease: PalEnvironmentLease,
	assertExecutionAllowed: () => Promise<void>,
	signal?: AbortSignal,
): Promise<PalGuestMcpConnection> {
	const connected: ConnectedMcpServer[] = []
	const failed: FailedMcpServer[] = []
	const toolsets: Toolset[] = []
	const openStdio = lease.sandbox.openStdio?.bind(lease.sandbox)
	if (!openStdio) return { connected, failed, toolsets }
	let servers: readonly PalGuestMcpServer[]
	try {
		await assertExecutionAllowed()
		signal?.throwIfAborted()
		const exists = await lease.sandbox.exec(
			'python3',
			[
				'-c',
				'import os,sys; sys.exit(0 if os.path.isfile(sys.argv[1]) else 3)',
				PAL_GUEST_MCP_MANIFEST,
			],
			{ signal, timeout: 10_000 },
		)
		if (exists.exitCode === 3 && !exists.timedOut) return { connected, failed, toolsets }
		if (exists.exitCode !== 0 || exists.timedOut)
			throw new Error('The guest could not inspect its MCP installation manifest.')
		await assertExecutionAllowed()
		servers = parsePalGuestMcpManifest(
			await lease.sandbox.readFile(PAL_GUEST_MCP_MANIFEST, {
				length: MAX_MANIFEST_BYTES + 1,
				signal,
			}),
		)
	} catch (error) {
		signal?.throwIfAborted()
		await assertExecutionAllowed()
		failed.push({
			name: 'guest-manifest',
			reason: error instanceof Error ? error.message : String(error),
		})
		return { connected, failed, toolsets }
	}
	try {
		for (const server of servers) {
			const setup = new AbortController()
			const onAbort = () => setup.abort(signal?.reason)
			signal?.addEventListener('abort', onAbort, { once: true })
			if (signal?.aborted) onAbort()
			const deadline = setTimeout(
				() => setup.abort(new Error('Guest MCP setup exceeded 20 seconds.')),
				20_000,
			)
			deadline.unref()
			const clearSetup = () => clearTimeout(deadline)
			const releaseSignal = () => {
				clearSetup()
				signal?.removeEventListener('abort', onAbort)
			}
			const requestTimeoutMs = server.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
			const client = new MCPClient({
				serverName: server.name,
				transport: {
					type: 'stdio',
					command: server.command,
					args: [...(server.args ?? [])],
				},
				transportFactory: () =>
					new PalGuestMcpTransport(async () => {
						await assertExecutionAllowed()
						setup.signal.throwIfAborted()
						return openStdio(server.command, server.args, {
							cwd: server.cwd ?? lease.sandbox.rootDir,
							env: server.env,
							signal: setup.signal,
							assertExecutionAllowed,
						})
					}),
				requestTimeoutMs,
			})
			try {
				await client.connect()
				const sources = await mcpToolset(client, {
					id: `pal:${lease.palId}/computer:${lease.environmentId}:${lease.generation}/mcp:${server.name}`,
					allow: server.allow,
					maxRetries: 0,
					readOnlyHintTrusted: false,
					reconnect: { enabled: false },
				})
				clearSetup()
				let closing: Promise<void> | undefined
				const close = () => {
					closing ??= (async () => {
						releaseSignal()
						for (const source of sources) await source.close?.()
						await client.disconnect()
					})()
					return closing
				}
				for (const source of sources)
					toolsets.push({
						...source,
						tools: () =>
							source.tools().map((tool) => ({
								...tool,
								timeoutMs: requestTimeoutMs + 1000,
								isConcurrencySafe: () => false,
							})),
						close,
					})
				const names = () => sources.flatMap((source) => source.tools().map((tool) => tool.name))
				connected.push({
					name: server.name,
					get toolCount() {
						return names().length
					},
					get tools() {
						return names()
					},
				})
			} catch (error) {
				releaseSignal()
				await client.disconnect()
				signal?.throwIfAborted()
				await assertExecutionAllowed()
				failed.push({
					name: server.name,
					reason:
						setup.signal.aborted && setup.signal.reason instanceof Error
							? setup.signal.reason.message
							: error instanceof Error
								? error.message
								: String(error),
				})
			}
		}
	} catch (error) {
		const failures: unknown[] = [error]
		for (const source of toolsets) {
			try {
				await source.close?.()
			} catch (cleanup) {
				failures.push(cleanup)
			}
		}
		throw failures.length === 1
			? error
			: new AggregateError(failures, 'Guest MCP setup and cleanup were not confirmed.')
	}
	return { connected, failed, toolsets }
}
