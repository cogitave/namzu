import type { PalEnvironmentLease, ToolContext } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
	GUEST_MCP_IMAGE,
	guestMcpChannel,
	guestMcpResponse,
} from './__fixtures__/guest-mcp-channel.js'
import {
	PAL_GUEST_MCP_MANIFEST,
	connectPalGuestMcp,
	parsePalGuestMcpManifest,
} from './guest-mcp.js'

const server = {
	name: 'blender',
	outcomeProtocol: 'namzu-v1',
	command: '/home/namzu/app/.venv/bin/python',
	args: ['/home/namzu/app/bridge.py'],
	allow: ['inspect_scene'],
	env: { BLENDER_HOST: '127.0.0.1', LITERAL: '${HOST_SECRET}' },
}
const manifest = (servers: unknown[] = [server]) =>
	Buffer.from(JSON.stringify({ version: 1, servers }))
afterEach(() => vi.useRealTimers())

it('requires an explicit bounded guest-only installation and refuses host inheritance or endpoints', () => {
	expect(parsePalGuestMcpManifest(manifest())).toEqual([server])
	for (const invalid of [
		{ ...server, command: 'python' },
		{ ...server, command: 'C:\\host\\python.exe' },
		{ ...server, cwd: '/home/namzu/../host' },
		{ ...server, allow: [] },
		{ ...server, inheritEnv: ['HOST_SECRET'] },
		{ ...server, url: 'http://host:9876' },
		{ ...server, outcomeProtocol: undefined },
		{ ...server, requestTimeoutMs: 0 },
		{ ...server, env: { NAMZU_SANDBOX_SECRET: 'no' } },
	])
		expect(() => parsePalGuestMcpManifest(manifest([invalid]))).toThrow()
	expect(() => parsePalGuestMcpManifest(manifest([server, server]))).toThrow('Duplicate')
	expect(() => parsePalGuestMcpManifest(Buffer.alloc(65537))).toThrow('64 KiB')
})

function fixture() {
	const f = guestMcpChannel(guestMcpResponse)
	const assertAllowed = vi.fn(async () => {})
	const sandbox = {
		rootDir: '/home/namzu/workspace',
		exec: vi.fn(async () => ({
			exitCode: 0,
			timedOut: false,
			stdout: '',
			stderr: '',
			durationMs: 0,
		})),
		readFile: vi.fn(async () => manifest()),
		openStdio: vi.fn<NonNullable<PalEnvironmentLease['sandbox']['openStdio']>>(
			async () => f.channel,
		),
	}
	const lease = {
		palId: 'owned-pal',
		environmentId: 'original-guest',
		generation: 7,
		sandbox,
	} as unknown as PalEnvironmentLease
	return { ...f, assertAllowed, sandbox, lease }
}

it('mounts the actual admitted guest listing with rich output and existing MCP provenance, with no paid tools or host environment expansion', async () => {
	const f = fixture()
	const connection = await connectPalGuestMcp(f.lease, f.assertAllowed)
	try {
		expect(f.sandbox.readFile).toHaveBeenCalledWith(
			PAL_GUEST_MCP_MANIFEST,
			expect.objectContaining({ length: 65537 }),
		)
		expect(f.sandbox.openStdio).toHaveBeenCalledWith(
			server.command,
			server.args,
			expect.objectContaining({
				cwd: '/home/namzu/workspace',
				env: server.env,
				assertExecutionAllowed: f.assertAllowed,
			}),
		)
		expect(connection.failed).toEqual([])
		expect(connection.connected).toEqual([
			{ name: 'blender', toolCount: 1, tools: ['mcp__blender__inspect_scene'] },
		])
		const main = connection.toolsets[0]
		expect(main?.source).toMatchObject({
			kind: 'mcp_server',
			id: 'pal:owned-pal/computer:original-guest:7/mcp:blender',
			mcpServer: { name: 'blender', readOnlyHintTrusted: false },
		})
		const tool = main?.tools()[0]
		expect(tool?.maxRetries).toBe(0)
		expect(tool?.isConcurrencySafe?.({})).toBe(false)
		expect(tool?.timeoutMs).toBe(181000)
		const result = await tool?.execute({}, {
			abortSignal: new AbortController().signal,
		} as ToolContext)
		expect(result?.success).toBe(true)
		expect(result?.output).toContain('Actual guest scene')
		expect(result?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'image',
					data: GUEST_MCP_IMAGE,
					mediaType: 'image/png',
				}),
			]),
		)
	} finally {
		for (const source of connection.toolsets) await source.close?.()
	}
	expect(f.channel.close).toHaveBeenCalledOnce()
})

it('does no manifest or process work for a guest without the capability and treats a missing manifest as no installation', async () => {
	const f = fixture()
	;(f.lease.sandbox as { openStdio?: unknown }).openStdio = undefined
	expect(await connectPalGuestMcp(f.lease, f.assertAllowed)).toEqual({
		connected: [],
		failed: [],
		toolsets: [],
	})
	expect(f.sandbox.exec).not.toHaveBeenCalled()
	expect(f.sandbox.readFile).not.toHaveBeenCalled()
	const installed = fixture()
	installed.sandbox.exec.mockResolvedValue({
		exitCode: 3,
		timedOut: false,
		stdout: '',
		stderr: '',
		durationMs: 0,
	})
	expect((await connectPalGuestMcp(installed.lease, installed.assertAllowed)).toolsets).toEqual([])
	expect(installed.sandbox.openStdio).not.toHaveBeenCalled()
})

it('propagates lost execution authority instead of treating it as an optional missing server', async () => {
	const f = fixture()
	f.assertAllowed.mockRejectedValue(new Error('Pal admission was retired'))
	await expect(connectPalGuestMcp(f.lease, f.assertAllowed)).rejects.toThrow(
		'Pal admission was retired',
	)
	expect(f.sandbox.exec).not.toHaveBeenCalled()
	expect(f.sandbox.openStdio).not.toHaveBeenCalled()
})

it('closes earlier admitted servers if subsequent setup loses the original execution authority', async () => {
	const f = fixture()
	let allowed = true
	f.assertAllowed.mockImplementation(async () => {
		if (!allowed) throw new Error('Original admission retired')
	})
	f.sandbox.readFile.mockResolvedValue(manifest([server, { ...server, name: 'godot' }]))
	f.sandbox.openStdio
		.mockImplementationOnce(async () => f.channel)
		.mockImplementationOnce(async () => {
			allowed = false
			throw new Error('Computer changed while opening second server')
		})
	await expect(connectPalGuestMcp(f.lease, f.assertAllowed)).rejects.toThrow(
		'Original admission retired',
	)
	expect(f.channel.close).toHaveBeenCalledOnce()
})

it('admits allowed lazy application tools after the real SDK list_changed notification without reconnecting', async () => {
	const f = fixture()
	let expanded = false
	const live = guestMcpChannel((message) => {
		if (message.method !== 'tools/list' || !expanded) return guestMcpResponse(message)
		return {
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools: [
					{ name: 'inspect_scene', inputSchema: { type: 'object', properties: {} } },
					{ name: 'lazy_screenshot', inputSchema: { type: 'object', properties: {} } },
					{ name: 'paid_generate', inputSchema: { type: 'object', properties: {} } },
				],
			},
		}
	})
	f.sandbox.openStdio.mockResolvedValue(live.channel)
	f.sandbox.readFile.mockResolvedValue(
		manifest([{ ...server, allow: ['inspect_scene', 'lazy_screenshot'] }]),
	)
	const connection = await connectPalGuestMcp(f.lease, f.assertAllowed)
	try {
		const main = connection.toolsets[0]
		const changed = new Promise<void>((resolve) => main?.onChange?.(resolve))
		expanded = true
		live.reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
		await changed
		expect(main?.tools().map((tool) => tool.name)).toEqual([
			'mcp__blender__inspect_scene',
			'mcp__blender__lazy_screenshot',
		])
		expect(connection.connected[0]?.tools).toEqual([
			'mcp__blender__inspect_scene',
			'mcp__blender__lazy_screenshot',
		])
		expect(f.sandbox.openStdio).toHaveBeenCalledOnce()
	} finally {
		for (const source of connection.toolsets) await source.close?.()
	}
})

it('bounds an unresponsive setup using the installed deadline without inventing application cancellation', async () => {
	vi.useFakeTimers()
	const f = fixture()
	const silent = guestMcpChannel()
	let admitted!: () => void
	const opened = new Promise<void>((resolve) => {
		admitted = resolve
	})
	f.sandbox.openStdio.mockImplementation(async (_command, _args, options) => {
		options?.signal?.addEventListener('abort', () => silent.finish(), { once: true })
		admitted()
		return silent.channel
	})
	const pending = connectPalGuestMcp(f.lease, f.assertAllowed)
	await opened
	await vi.advanceTimersByTimeAsync(20_000)
	const result = await pending
	expect(result.failed).toEqual([
		{ name: 'blender', reason: 'Guest MCP setup exceeded 20 seconds.' },
	])
	expect(result.toolsets).toEqual([])
	expect(silent.operations[0]?.outcomeUnknown).toHaveBeenCalledOnce()
	expect(silent.operations[0]?.complete).not.toHaveBeenCalled()
	expect(silent.channel.close).toHaveBeenCalledOnce()
})
