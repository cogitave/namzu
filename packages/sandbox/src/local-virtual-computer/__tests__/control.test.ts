import { once } from 'node:events'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { HttpWorkerClient } from '../../backends/http-worker-client.js'
import { localComputerClients } from '../client.js'

const { createDesktopServer } = createRequire(import.meta.url)(
	'../../../local-computer/desktop-worker.cjs',
) as {
	createDesktopServer(options: {
		token: string
		run: (binary: string, args: string[]) => Promise<Buffer>
		fetchBrowser: () => Promise<boolean>
	}): Server
}
const servers: Server[] = []
const png = Buffer.alloc(24)
png.write('89504e470d0a1a0a', 0, 'hex')
png.writeUInt32BE(1280, 16)
png.writeUInt32BE(800, 20)
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function clients(desktopUrl = 'http://127.0.0.1:1') {
	return localComputerClients({
		executionUrl: 'http://127.0.0.1:2',
		desktopUrl,
		token: 'owned-fixture-token',
		geometry: { width: 1280, height: 800, scaleFactor: 1 },
		stop: async () => {},
	})
}
async function desktop(run: (binary: string, args: string[]) => Promise<Buffer>) {
	const server = createDesktopServer({
		token: 'owned-fixture-token',
		run,
		fetchBrowser: async () => true,
	})
	servers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Missing test server')
	return `http://127.0.0.1:${address.port}`
}
function runner() {
	return vi.fn(async (binary: string, args: string[]): Promise<Buffer> => {
		if (binary === 'maim') return png
		if (args[0] === 'getdisplaygeometry') return Buffer.from('1280 800')
		return Buffer.alloc(0)
	})
}
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})

it('delivers authenticated human input while every agent guest path is fenced, then requires a fresh screen', async () => {
	const run = runner()
	const owned = clients(await desktop(run))
	await owned.operatorControl.takeOver()
	expect(owned.operatorControl.mode).toBe('operator')
	await expect(owned.sandbox.exec('xdotool', ['key', 'A'])).rejects.toThrow('operator has control')
	await expect(owned.sandbox.writeFile('/home/namzu/workspace/a', 'bad')).rejects.toThrow(
		'operator has control',
	)
	await expect(owned.sandbox.readFile('/home/namzu/workspace/a')).rejects.toThrow(
		'operator has control',
	)
	await expect(owned.sandbox.listFiles('/')).rejects.toThrow('operator has control')
	expect(() => owned.sandbox.walkFiles?.('/', { maxEntries: 1 })).toThrow('operator has control')
	expect(() => owned.sandbox.spawnDetached?.('sh', ['-c', 'bad'])).toThrow('operator has control')
	await expect(owned.computerUseHost.execute({ type: 'key', keys: 'A' })).rejects.toThrow(
		'operator has control',
	)
	await expect(owned.computerUseHost.execute({ type: 'screenshot' })).resolves.toMatchObject({
		type: 'screenshot',
	})
	await expect(
		owned.operatorControl.executeInput({ type: 'type_text', text: 'literal $(no shell)' }),
	).resolves.toEqual({ type: 'ok' })
	expect(run).toHaveBeenCalledWith('xdotool', [
		'type',
		'--clearmodifiers',
		'--delay',
		'0',
		'--',
		'literal $(no shell)',
	])
	await owned.operatorControl.returnControl()
	await expect(owned.operatorControl.executeInput({ type: 'key', keys: 'A' })).rejects.toThrow(
		'does not have control',
	)
	await expect(owned.computerUseHost.execute({ type: 'key', keys: 'A' })).rejects.toThrow('fresh')
	await owned.computerUseHost.execute({ type: 'screenshot' })
	await expect(owned.computerUseHost.execute({ type: 'key', keys: 'A' })).resolves.toEqual({
		type: 'ok',
	})
})
it('requests computer ownership for a completed foreground launcher and still admits operator takeover', async () => {
	const fetch_ = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
		if (String(input).endsWith('/executions/reserve'))
			return Response.json({
				ok: true,
				protocolVersion: 2,
				normalExitPolicy: 'computer-lifetime',
				executionId: 'exec_00000000-0000-4000-8000-000000000001',
				leaseExpiresAt: Date.now() + 30_000,
			})
		return new Response(
			`${JSON.stringify({ type: 'result', exitCode: 0, timedOut: false, durationMs: 1 })}\n`,
		)
	})
	vi.stubGlobal('fetch', fetch_)
	const owned = clients()
	await expect(owned.sandbox.exec('launcher', [])).resolves.toMatchObject({ exitCode: 0 })
	const body = JSON.parse(String(fetch_.mock.calls[1]?.[1]?.body))
	expect(body.normalExitPolicy).toBe('computer-lifetime')
	await owned.operatorControl.takeOver()
	expect(owned.operatorControl.mode).toBe('operator')
	expect(owned.sandbox.status).toBe('ready')
})

it('refuses takeover while a foreground command is pending and preserves Pal authority', async () => {
	const pending = deferred<Awaited<ReturnType<HttpWorkerClient['exec']>>>()
	vi.spyOn(HttpWorkerClient.prototype, 'exec').mockReturnValue(pending.promise)
	const owned = clients()
	const executing = owned.sandbox.exec('sh', ['-c', 'work'])
	await expect(owned.operatorControl.takeOver()).rejects.toThrow('all Pal computer work')
	expect(owned.operatorControl.mode).toBe('pal')
	pending.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 })
	await executing
	await owned.operatorControl.takeOver()
	expect(owned.operatorControl.mode).toBe('operator')
})
it('tracks an in-flight file request until the worker confirms completion', async () => {
	const pending = deferred<Response>()
	vi.stubGlobal(
		'fetch',
		vi.fn(() => pending.promise),
	)
	const owned = clients()
	const writing = owned.sandbox.writeFile('/home/namzu/workspace/a', 'data')
	await expect(owned.operatorControl.takeOver()).rejects.toThrow('all Pal computer work')
	pending.resolve(Response.json({ ok: true }))
	await writing
	await owned.operatorControl.takeOver()
})
it('refuses return while actual human input is executing without silently replaying it', async () => {
	const entered = deferred<void>()
	const pending = deferred<Buffer>()
	const run = runner()
	run.mockImplementation(async (_binary, args) => {
		if (args[0] === 'getdisplaygeometry') return Buffer.from('1280 800')
		entered.resolve()
		return pending.promise
	})
	const owned = clients(await desktop(run))
	await owned.operatorControl.takeOver()
	const input = owned.operatorControl.executeInput({ type: 'key', keys: 'A' })
	await entered.promise
	await expect(owned.operatorControl.returnControl()).rejects.toThrow('all Pal computer work')
	expect(owned.operatorControl.mode).toBe('operator')
	pending.resolve(Buffer.alloc(0))
	await input
	await owned.operatorControl.returnControl()
	expect(run.mock.calls.filter((call) => call[1][0] === 'key')).toHaveLength(1)
})
it('retains unknown input ownership and refuses transfer and further effects until computer stop', async () => {
	const run = runner()
	run.mockImplementation(async (_binary, args) => {
		if (args[0] === 'getdisplaygeometry') return Buffer.from('1280 800')
		throw new Error('Guest input may have acted')
	})
	const owned = clients(await desktop(run))
	await owned.operatorControl.takeOver()
	await expect(
		owned.operatorControl.executeInput({ type: 'key', keys: 'A' }),
	).rejects.toMatchObject({ code: 'computer_use_outcome_unknown' })
	await expect(owned.operatorControl.returnControl()).rejects.toThrow('outcome is unknown')
	await expect(owned.operatorControl.executeInput({ type: 'key', keys: 'B' })).rejects.toThrow(
		'outcome is unknown',
	)
	expect(owned.operatorControl.mode).toBe('operator')
	expect(run.mock.calls.filter((call) => call[1][0] === 'key')).toHaveLength(1)
	await owned.sandbox.destroy()
	await expect(owned.operatorControl.returnControl()).rejects.toThrow('lease has ended')
})
it('does not transfer control after an unconfirmed remote file write', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('Transport lost after write dispatch')
		}),
	)
	const owned = clients()
	await expect(owned.sandbox.writeFile('/home/namzu/workspace/a', 'data')).rejects.toThrow(
		'Transport lost',
	)
	await expect(owned.operatorControl.takeOver()).rejects.toThrow('outcome is unknown')
	expect(owned.operatorControl.mode).toBe('pal')
})
