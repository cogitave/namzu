import { type SpawnOptions, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const hostPath = fileURLToPath(
	new URL('../../../local-computer/app-native-host.cjs', import.meta.url),
)
const host = require(hostPath)
const catalogue = require('../../../local-computer/app-catalog.cjs')

function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message))
	const header = Buffer.alloc(4)
	header.writeUInt32LE(body.length)
	return Buffer.concat([header, body])
}

async function nativeProcess(origin: string, input: Buffer): Promise<unknown> {
	const child = spawn(process.execPath, [hostPath, origin], { stdio: ['pipe', 'pipe', 'pipe'] })
	const chunks: Buffer[] = []
	let stderr = ''
	child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	child.stdin.on('error', () => {})
	const closed = new Promise<void>((resolve, reject) => {
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`Native host exited ${code}`)),
		)
	})
	child.stdin.end(input)
	await closed
	expect(stderr).toBe('')
	const result = Buffer.concat(chunks)
	expect(result.readUInt32LE(0)).toBe(result.length - 4)
	return JSON.parse(result.toString('utf8', 4))
}

describe('bundled New Tab native application host', () => {
	it('allows the exact bundled extension to obtain only the installed catalogue', async () => {
		expect(await nativeProcess(host.EXTENSION_ORIGIN, frame({ type: 'list' }))).toEqual({
			ok: false,
			error: 'catalogue_unavailable',
		})
		const apps = [{ id: 'blender', name: 'Blender', icon: 'icons/blender.svg' }]
		expect(
			await host.handleMessage({ type: 'list' }, { readApps: () => JSON.stringify(apps) }),
		).toEqual({ ok: true, apps })
	})
	it('refuses website and other extension origins before any application request', async () => {
		for (const origin of [
			'https://example.test/',
			'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
			`${host.EXTENSION_ORIGIN}home.html`,
		])
			expect(await nativeProcess(origin, frame({ type: 'launch', appId: 'blender' }))).toEqual({
				ok: false,
				error: 'unauthorized_origin',
			})
	})
	it('accepts only a bounded single native frame, including partial and excess data rejection', async () => {
		const oversized = Buffer.alloc(4)
		oversized.writeUInt32LE(host.MAX_MESSAGE + 1)
		for (const input of [
			oversized,
			Buffer.from([1, 0]),
			Buffer.concat([frame({ type: 'list' }), frame({ type: 'list' })]),
		])
			expect(await nativeProcess(host.EXTENSION_ORIGIN, input)).toEqual({
				ok: false,
				error: 'invalid_request',
			})
	})
	it('rejects unknown app ids, commands and extra properties without spawning', async () => {
		const execute = vi.fn()
		for (const request of [
			{ type: 'launch', appId: 'blender', args: ['--python', '/tmp/code.py'] },
			{ type: 'launch', appId: '/usr/bin/bash' },
			{ type: 'launch', appId: 'blender;touch /tmp/marker' },
			{ type: 'launch', appId: 'unknown' },
			{ type: 'list', command: 'bash' },
		]) {
			const result = await host.handleMessage(request, { access: () => {}, spawn: execute })
			expect(result.ok).toBe(false)
		}
		expect(execute).not.toHaveBeenCalled()
	})
	it('launches fixed installed guest argv exactly once with detached protocol-free stdio', async () => {
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
		const execute = vi.fn((_binary: string, _args: string[], _options: SpawnOptions) => child)
		const result = host.handleMessage(
			{ type: 'launch', appId: 'draw' },
			{ access: () => {}, spawn: execute },
		)
		expect(execute).toHaveBeenCalledTimes(1)
		const [binary, args, options] = execute.mock.calls[0]!
		expect(binary).toBe('/usr/bin/libreoffice')
		expect(args).toEqual(['--draw'])
		expect(options).toMatchObject({
			cwd: '/home/namzu/workspace',
			detached: true,
			shell: false,
			stdio: 'ignore',
		})
		child.emit('spawn')
		expect(await result).toEqual({ ok: true, appId: 'draw' })
		expect(child.unref).toHaveBeenCalledTimes(1)
	})
	it('reports missing executables and spawn failures without leaking OS messages', async () => {
		const execute = vi.fn()
		expect(
			await host.handleMessage(
				{ type: 'launch', appId: 'blender' },
				{
					access: () => {
						throw new Error('private path')
					},
					spawn: execute,
				},
			),
		).toEqual({ ok: false, error: 'application_unavailable' })
		expect(execute).not.toHaveBeenCalled()
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
		const result = host.handleMessage(
			{ type: 'launch', appId: 'blender' },
			{ access: () => {}, spawn: () => child },
		)
		child.emit('error', new Error('private credential and path'))
		expect(await result).toEqual({ ok: false, error: 'launch_failed' })
		expect(child.unref).not.toHaveBeenCalled()
	})
	it('strips allocation secrets and injection environment while keeping guest display/profile', () => {
		const app = catalogue.APPLICATIONS.find((entry: { id: string }) => entry.id === 'blender')
		const env = catalogue.applicationEnvironment(app, {
			NAMZU_SANDBOX_TOKEN: 'private-allocation-token',
			NAMZU_OTHER_SECRET: 'private',
			NODE_OPTIONS: '--require=/tmp/evil.cjs',
			LD_PRELOAD: '/tmp/evil.so',
			HOME: '/host/private',
			DISPLAY: ':host',
			LANG: 'C.UTF-8',
		})
		expect(env).toEqual({
			HOME: '/home/namzu',
			DISPLAY: ':99',
			LANG: 'C.UTF-8',
			PATH: '/usr/local/bin:/usr/bin:/bin:/usr/games',
			LIBGL_ALWAYS_SOFTWARE: '1',
			BLENDERMCP_NO_UPDATE_CHECK: '1',
			BLENDER_MCP_DISABLE_TELEMETRY: '1',
		})
	})
	it('launches the supported Godot editor with the guest compatibility renderer', async () => {
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
		const execute = vi.fn((_binary: string, _args: string[], _options: SpawnOptions) => child)
		const result = host.handleMessage(
			{ type: 'launch', appId: 'godot' },
			{ access: () => {}, spawn: execute },
		)
		expect(execute.mock.calls[0]?.slice(0, 2)).toEqual([
			'/usr/local/bin/godot4',
			['--rendering-method', 'gl_compatibility'],
		])
		child.emit('spawn')
		expect(await result).toEqual({ ok: true, appId: 'godot' })
	})
	it('starts Kdenlive with software rendering and SDL dummy audio without a host audio device', () => {
		const app = catalogue.APPLICATIONS.find((entry: { id: string }) => entry.id === 'kdenlive')
		const env = catalogue.applicationEnvironment(app, {
			SDL_AUDIODRIVER: 'alsa',
			LIBGL_ALWAYS_SOFTWARE: '0',
			NAMZU_SANDBOX_TOKEN: 'private-allocation-token',
		})
		expect(env.SDL_AUDIODRIVER).toBe('dummy')
		expect(env.LIBGL_ALWAYS_SOFTWARE).toBe('1')
		expect(env.NAMZU_SANDBOX_TOKEN).toBeUndefined()
		expect(app.binary).toBe('/usr/bin/kdenlive')
		expect(app.args).toEqual([])
	})
	it("removes Chromium's disabled D-Bus sentinel while preserving a real guest session bus", () => {
		const app = catalogue.APPLICATIONS.find((entry: { id: string }) => entry.id === 'kdenlive')
		const disabled = { DBUS_SESSION_BUS_ADDRESS: 'disabled:', GTK_THEME: 'Adwaita:dark' }
		const env = catalogue.applicationEnvironment(app, disabled)
		expect(env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS')
		expect(env.GTK_THEME).toBe('Adwaita:dark')
		expect(disabled.DBUS_SESSION_BUS_ADDRESS).toBe('disabled:')
		const guestBus = 'unix:path=/tmp/guest-session-bus'
		expect(
			catalogue.applicationEnvironment(app, { DBUS_SESSION_BUS_ADDRESS: guestBus })
				.DBUS_SESSION_BUS_ADDRESS,
		).toBe(guestBus)
	})
	it('executes a real detached subprocess with literal arguments without a shell or protocol output', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-guest-launch-'))
		try {
			const marker = join(directory, 'result.json')
			const literal = 'spaces and $(exit 93); literal'
			let closed: Promise<void> | undefined
			const spawnProcess = (binary: string, args: string[], options: SpawnOptions) => {
				// The fixture supplies its own existing cwd; production always uses the guest workspace.
				const child = spawn(binary, args, { ...options, cwd: directory })
				closed = new Promise<void>((resolve, reject) => {
					child.on('error', reject)
					child.on('close', (code) =>
						code === 0 ? resolve() : reject(new Error('Fixture failed')),
					)
				})
				return child
			}
			const result = await host.launchApplication(
				{
					id: 'fixture',
					binary: process.execPath,
					args: [
						'-e',
						'require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))',
						marker,
						literal,
					],
				},
				spawnProcess,
			)
			expect(result).toEqual({ ok: true, appId: 'fixture' })
			await closed
			expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual([literal])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
