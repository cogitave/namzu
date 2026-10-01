import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackgroundJobRegistry, type Sandbox } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { localComputerClients } from '../client.js'
import type { OwnedDetachedProcess } from '../detached-process.js'

const cleanups: (() => Promise<void>)[] = []
const helper = fileURLToPath(
	new URL('../../../dist/local-virtual-computer/detached-worker.js', import.meta.url),
)

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function workerFixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-pal-background-protocol-'))
	const program = join(root, 'worker.cjs')
	await copyFile(new URL('../../../worker/server.js', import.meta.url), program)
	const worker = spawn(process.execPath, [program], {
		cwd: root,
		env: {
			...process.env,
			NAMZU_SANDBOX_TOKEN: 'private-fixture-worker-token',
			NAMZU_SANDBOX_PORT: '0',
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: root,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			NAMZU_SANDBOX_MAX_TIMEOUT_MS: '2147000000',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()))
	worker.stderr.resume()
	const port = await new Promise<number>((resolve, reject) => {
		let log = ''
		worker.stdout.on('data', (chunk) => {
			log += chunk.toString()
			const match = log.match(/listening on 127\.0\.0\.1:(\d+)/)
			if (match) resolve(Number(match[1]))
		})
		worker.once('error', reject)
		worker.once('close', (code) =>
			reject(new Error(`Fixture worker stopped before readiness (${code})`)),
		)
	})
	let stopped = false
	const stop = async () => {
		if (!stopped) {
			stopped = true
			// Model the Docker allocation stop, which removes every remaining
			// guest process, rather than treating the RPC worker's pipe as the
			// boundary. These PIDs belong only to this private fixture.
			try {
				const pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) as number[]
				for (const pid of pids)
					if (await running(pid)) {
						try {
							process.kill(pid, 'SIGKILL')
						} catch {}
					}
			} catch {}
			worker.kill('SIGKILL')
			await closed
		}
	}
	cleanups.push(async () => {
		await stop()
		await rm(root, { recursive: true, force: true })
	})
	const clients = localComputerClients({
		executionUrl: `http://127.0.0.1:${port}`,
		desktopUrl: `http://127.0.0.1:${port}`,
		token: 'private-fixture-worker-token',
		geometry: { width: 1280, height: 800, scaleFactor: 1 },
		stop,
		detachedWorkerPath: helper,
	})
	return { root, clients }
}

function observe(process: OwnedDetachedProcess, marker?: string) {
	const { stdout, stderr } = process.child
	if (!stdout || !stderr) throw new Error('The background bridge must supply real output pipes')
	let output = ''
	const ready = new Promise<void>((resolve, reject) => {
		stdout.on('data', (chunk) => {
			output += chunk.toString()
			if (!marker || output.includes(marker)) resolve()
		})
		process.child.once('error', reject)
		process.child.once('close', (code) => {
			if (marker && !output.includes(marker))
				reject(new Error(`Background fixture exited before its marker (${code})`))
			else resolve()
		})
	})
	stderr.resume()
	return { ready, output: () => output }
}

function background(
	sandbox: Sandbox,
	...args: Parameters<NonNullable<Sandbox['spawnDetached']>>
): OwnedDetachedProcess {
	if (!sandbox.spawnDetached) throw new Error('The guest must support background commands')
	return sandbox.spawnDetached(...args) as OwnedDetachedProcess
}

async function running(pid: number): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
		return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3))
	} catch {
		return false
	}
}

// Real subprocess/socket protocol tests. No host desktop is contacted and no
// timing race decides the outcome; Vitest owns the legitimate I/O timeout.
describe.skipIf(process.platform !== 'linux')('guest background process protocol', () => {
	it('streams a finite worker-owned command through a real child pipe', async () => {
		const { clients, root } = await workerFixture()
		const process = background(
			clients.sandbox,
			processExecutable(),
			['-e', 'console.log("guest-result"); process.stderr.write("guest-error\\n")'],
			{ cwd: root },
		) as OwnedDetachedProcess
		const observed = observe(process)
		await process.closed
		expect(observed.output()).toContain('guest-result')
		expect(process.child.exitCode).toBe(0)
		await clients.sandbox.destroy()
	}, 15_000)
	it('keeps a server between calls and confirms its complete owned tree stops', async () => {
		const { clients, root } = await workerFixture()
		const grandchild =
			"process.on('SIGTERM',()=>{}); process.send('READY'); setInterval(()=>{},1000)"
		const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']}); c.once('message',()=>{fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid])); console.log('READY-GUEST-TREE')}); setInterval(()=>{},1000)`
		const process = background(clients.sandbox, processExecutable(), ['-e', script], {
			cwd: root,
		}) as OwnedDetachedProcess
		const observed = observe(process, 'READY-GUEST-TREE')
		await observed.ready
		const pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) as number[]
		expect(await Promise.all(pids.map(running))).toEqual([true, true])
		// A second operation uses the same live computer while the server runs.
		expect(
			(
				await clients.sandbox.exec(processExecutable(), ['-e', 'console.log("second-call")'], {
					cwd: root,
				})
			).stdout,
		).toContain('second-call')
		process.kill('SIGTERM')
		process.kill('SIGKILL')
		await process.closed
		expect(await Promise.all(pids.map(running))).toEqual([false, false])
		await clients.sandbox.destroy()
	}, 15_000)
	it('cancels admission before a background command can execute', async () => {
		const { clients, root } = await workerFixture()
		const process = background(
			clients.sandbox,
			processExecutable(),
			['-e', 'require("node:fs").writeFileSync("should-not-start","bad")'],
			{ cwd: root },
		) as OwnedDetachedProcess
		observe(process)
		process.kill('SIGTERM')
		await process.closed
		await expect(readFile(join(root, 'should-not-start'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		})
		await clients.sandbox.destroy()
	}, 15_000)
	it.each([false, true])(
		'retires an unknown cancellation, preserving a failed retirement (%s)',
		async (initialFailure) => {
			const executionId = 'exec_00000000-0000-4000-8000-000000000001'
			const server = createServer(async (req, res) => {
				for await (const _chunk of req) {
				}
				if (req.url === '/executions/reserve') {
					res.writeHead(200, { 'content-type': 'application/json' })
					res.end(
						JSON.stringify({
							ok: true,
							protocolVersion: 2,
							executionId,
							leaseExpiresAt: Date.now() + 30_000,
						}),
					)
					return
				}
				if (req.url === '/execute') {
					res.writeHead(200, { 'content-type': 'application/x-ndjson' })
					res.write(`${JSON.stringify({ type: 'stdout_delta', data: 'READY-UNCONFIRMED\n' })}\n`)
					return
				}
				res.writeHead(503)
				res.end('{}')
			})
			server.listen(0, '127.0.0.1')
			await once(server, 'listening')
			const address = server.address()
			if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
			let retirements = 0
			let failRetirement = initialFailure
			const stop = async () => {
				retirements += 1
				if (failRetirement) throw new Error('Fixture engine cannot confirm removal')
				server.closeAllConnections()
				await new Promise<void>((resolve) => server.close(() => resolve()))
			}
			const clients = localComputerClients({
				executionUrl: `http://127.0.0.1:${address.port}`,
				desktopUrl: `http://127.0.0.1:${address.port}`,
				token: 'private-fixture-worker-token',
				geometry: { width: 1280, height: 800, scaleFactor: 1 },
				stop,
				detachedWorkerPath: helper,
			})
			cleanups.push(async () => {
				failRetirement = false
				await clients.sandbox.destroy()
			})
			const process = background(clients.sandbox, 'fixture-program', [])
			const registry = new BackgroundJobRegistry()
			const job = registry.start({
				owner: 'private-fixture-pal',
				command: 'fixture-program',
				workingDirectory: '/guest',
				spawn: () => process,
			})
			await observe(process, 'READY-UNCONFIRMED').ready
			const termination = registry.kill(job.id)
			if (initialFailure) {
				await expect(termination).rejects.toThrow('operator recovery')
				expect(process.child.exitCode).toBeNull()
				expect(process.child.connected).toBe(true)
				expect(registry.get(job.id)).toMatchObject({ status: 'running', recoveryRequired: true })
				expect(retirements).toBe(1)
				await expect(clients.sandbox.exec('must-not-run', [])).rejects.toThrow('lease has ended')
				failRetirement = false
				await registry.kill(job.id)
			} else await termination
			await process.closed
			expect(registry.get(job.id)).toMatchObject({ status: 'killed' })
			expect(registry.get(job.id).recoveryRequired).toBeUndefined()
			expect(retirements).toBe(initialFailure ? 2 : 1)
			expect(clients.sandbox.status).toBe('destroyed')
		},
		15_000,
	)
})

function processExecutable(): string {
	return process.execPath
}
