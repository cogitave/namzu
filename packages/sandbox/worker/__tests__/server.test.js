import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `worker/server.js` is a plain CommonJS script meant to run standalone
 * inside the sandbox container (see the Dockerfile `CMD`), not a module
 * this package imports. `packages/sandbox/package.json` declares `"type":
 * "module"`, so running the real path directly makes Node treat the `.js`
 * as ESM and reject its `require(...)` calls. Copying the live source into
 * a temp `.cjs` file — same bytes, extension Node treats as CommonJS — lets
 * this test exercise the actual file as a real subprocess (the only way to
 * observe its HTTP behaviour) without renaming the shipped file or touching
 * how the Dockerfile invokes it.
 */
async function spawnWorker(env, transformSource = (source) => source) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-sandbox-worker-test-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, transformSource(source))

	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: String(port),
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: workspace,
			// Disable the idle-exit layer so a slow CI runner can't race the
			// worker's self-shutdown against the test's requests.
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	await waitForListening(child)

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		workspace,
		child,
		async stop() {
			child.kill('SIGKILL')
			await rm(workspace, { recursive: true, force: true })
		},
	}
}

function replaceUnique(source, target, replacement) {
	const matches = source.split(target).length - 1
	if (matches !== 1) throw new Error(`expected one mutation anchor, found ${matches}: ${target}`)
	return source.replace(target, replacement)
}

function waitForExit(child, timeoutMs = 2_000) {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode)
	return new Promise((resolve, reject) => {
		const onExit = (code) => {
			clearTimeout(timer)
			resolve(code)
		}
		const timer = setTimeout(() => {
			child.off('exit', onExit)
			reject(new Error(`worker did not exit within ${timeoutMs}ms`))
		}, timeoutMs)
		child.once('exit', onExit)
	})
}

async function reserve(worker) {
	const response = await fetch(`${worker.baseUrl}/executions/reserve`, {
		method: 'POST',
	})
	expect(response.status).toBe(201)
	return await response.json()
}

async function cancel(worker, executionId) {
	return await fetch(`${worker.baseUrl}/cancel`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ executionId }),
	})
}

function waitForListening(child) {
	return new Promise((resolve, reject) => {
		let out = ''
		let errOut = ''
		const onData = (chunk) => {
			out += chunk.toString('utf8')
			if (out.includes('listening on')) {
				cleanup()
				resolve()
			}
		}
		const onError = (err) => {
			cleanup()
			reject(err)
		}
		const onExit = (code) => {
			cleanup()
			reject(new Error(`worker exited early (code=${code}); stderr:\n${errOut}`))
		}
		const onErrData = (chunk) => {
			errOut += chunk.toString('utf8')
		}
		function cleanup() {
			child.stdout.off('data', onData)
			child.stderr.off('data', onErrData)
			child.off('error', onError)
			child.off('exit', onExit)
		}
		child.stdout.on('data', onData)
		child.stderr.on('data', onErrData)
		child.on('error', onError)
		child.on('exit', onExit)
		setTimeout(() => {
			cleanup()
			reject(new Error(`worker did not log "listening" in time; stderr:\n${errOut}`))
		}, 10_000).unref()
	})
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer()
		probe.on('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address()
			probe.close(() => resolve(port))
		})
	})
}

describe('worker /execute — timeoutMs ceiling', () => {
	let worker

	afterEach(async () => {
		if (worker) await worker.stop()
		worker = undefined
	})

	it('refuses a timeoutMs above the ceiling rather than quietly running under a different one', async () => {
		// Silently clamping would run the command under a deadline the caller
		// never chose and never learns about — the "accepted and not applied"
		// shape this codebase treats as worse than not offering the control.
		// The guest agent on the other transport already refuses; this pins
		// that the two say the same thing.
		worker = await spawnWorker({ NAMZU_SANDBOX_MAX_TIMEOUT_MS: '400' })

		const res = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				command: process.execPath,
				args: ['-e', 'setTimeout(() => {}, 60_000)'],
				// Attacker- or model-controlled, with no cap of its own: the
				// bash tool's `timeout` argument reaches here unmodified.
				timeoutMs: 60_000,
			}),
		})

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error).toBe('invalid_timeout')
	})

	it('refuses a timeoutMs that is not a positive finite number', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_MAX_TIMEOUT_MS: '5000' })

		for (const timeoutMs of [0, -1, 'nonsense']) {
			const res = await fetch(`${worker.baseUrl}/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					command: process.execPath,
					args: ['-e', ''],
					timeoutMs,
				}),
			})
			expect(res.status).toBe(400)
		}
	})
})

describe('worker execution leases and cancellation', () => {
	let worker

	afterEach(async () => {
		if (worker) await worker.stop()
		worker = undefined
	})

	it('cancels a reservation before admission and never auto-admits that id later', async () => {
		worker = await spawnWorker()
		const lease = await reserve(worker)

		const cancelled = await cancel(worker, lease.executionId)
		expect(cancelled.status).toBe(200)
		const cancellation = await cancelled.json()
		expect(cancellation).toMatchObject({
			ok: true,
			state: 'cancelled',
			started: false,
		})
		expect(cancellation.result).not.toHaveProperty('signal')

		const execute = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: process.execPath,
				args: ['-e', 'process.exit(0)'],
			}),
		})
		expect(execute.status).toBe(409)
	})

	it('refuses a delayed execute after its inert lease expires', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_EXECUTION_LEASE_TTL_MS: '40' })
		const lease = await reserve(worker)
		await new Promise((resolve) => setTimeout(resolve, 80))

		const execute = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: process.execPath,
				args: ['-e', 'process.exit(0)'],
			}),
		})
		expect(execute.status).toBe(404)
	})

	it.each([
		['invalid cwd', { cwd: '../outside' }, 'invalid_cwd'],
		['invalid timeout', { timeoutMs: 0 }, 'invalid_timeout'],
	])(
		'keeps an expiring reservation after %s instead of leaking starting capacity',
		async (_label, invalid, error) => {
			worker = await spawnWorker({
				NAMZU_SANDBOX_EXECUTION_LEASE_TTL_MS: '40',
				NAMZU_SANDBOX_MAX_TRACKED_EXECUTIONS: '1',
			})
			const lease = await reserve(worker)
			const rejected = await fetch(`${worker.baseUrl}/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					executionId: lease.executionId,
					command: process.execPath,
					args: ['-e', ''],
					...invalid,
				}),
			})
			expect(rejected.status).toBe(400)
			expect((await rejected.json()).error).toBe(error)
			expect(
				(
					await fetch(`${worker.baseUrl}/executions/reserve`, {
						method: 'POST',
					})
				).status,
			).toBe(503)

			await new Promise((resolve) => setTimeout(resolve, 80))
			expect(
				(
					await fetch(`${worker.baseUrl}/executions/reserve`, {
						method: 'POST',
					})
				).status,
			).toBe(201)
		},
	)

	it('lets cancellation close admission while the execute body is still arriving', async () => {
		worker = await spawnWorker()
		const lease = await reserve(worker)
		let finishBody
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{'))
				finishBody = () => {
					controller.enqueue(
						new TextEncoder().encode(
							`"executionId":${JSON.stringify(lease.executionId)},"command":${JSON.stringify(process.execPath)},"args":["-e","process.exit(0)"]}`,
						),
					)
					controller.close()
				}
			},
		})
		const execute = fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			duplex: 'half',
		}).then(
			(response) => ({ ok: true, response }),
			(error) => ({ ok: false, error }),
		)
		await new Promise((resolve) => setTimeout(resolve, 30))
		const cancellation = await cancel(worker, lease.executionId)
		expect(cancellation.status).toBe(200)
		finishBody()
		expect(await execute).toMatchObject({
			ok: true,
			response: { status: 409 },
		})
	})

	it('lets cancellation close admission during awaited preparation', async () => {
		worker = await spawnWorker({}, (source) =>
			replaceUnique(
				source,
				'await fs.mkdir(cwd, { recursive: true })',
				'await new Promise((resolve) => setTimeout(resolve, 120))\n\t\tawait fs.mkdir(cwd, { recursive: true })',
			),
		)
		const lease = await reserve(worker)
		const execute = fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: process.execPath,
				args: ['-e', 'process.exit(0)'],
			}),
		}).then(
			(response) => ({ ok: true, response }),
			(error) => ({ ok: false, error }),
		)
		await new Promise((resolve) => setTimeout(resolve, 30))
		const cancellation = await cancel(worker, lease.executionId)
		expect(await cancellation.json()).toMatchObject({
			state: 'cancelled',
			started: false,
		})
		expect(await execute).toMatchObject({
			ok: true,
			response: { status: 409 },
		})
	})

	it('refuses capacity instead of evicting a live reservation', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_MAX_TRACKED_EXECUTIONS: '2' })
		const first = await reserve(worker)
		const second = await reserve(worker)
		const full = await fetch(`${worker.baseUrl}/executions/reserve`, {
			method: 'POST',
		})
		expect(full.status).toBe(503)

		// The first lease is still owned. If capacity evicted it, this would be
		// an unknown-id 404 rather than an idempotent terminal cancellation.
		expect((await cancel(worker, first.executionId)).status).toBe(200)
		expect((await cancel(worker, second.executionId)).status).toBe(200)
	})

	it('evicts terminal history before refusing a new sequential command', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_MAX_TRACKED_EXECUTIONS: '1' })
		for (const output of ['first', 'second']) {
			const lease = await reserve(worker)
			const response = await fetch(`${worker.baseUrl}/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					executionId: lease.executionId,
					command: process.execPath,
					args: ['-e', `console.log(${JSON.stringify(output)})`],
				}),
			})
			expect(await response.text()).toContain(output)
		}
	})

	it('keeps a terminal id idempotent and refuses duplicate execution', async () => {
		worker = await spawnWorker()
		const lease = await reserve(worker)
		const request = () =>
			fetch(`${worker.baseUrl}/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					executionId: lease.executionId,
					command: process.execPath,
					args: ['-e', 'console.log("once")'],
				}),
			})

		const first = await request()
		expect(first.status).toBe(200)
		expect(await first.text()).toContain('once')
		expect((await request()).status).toBe(409)
		const terminal = await cancel(worker, lease.executionId)
		expect(await terminal.json()).toMatchObject({
			state: 'completed',
			started: true,
		})
	})

	it('kills the process group and confirms terminal state before a delayed descendant can write', async () => {
		worker = await spawnWorker({
			NAMZU_SANDBOX_CANCEL_GRACE_MS: '80',
			NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: '1500',
		})
		const marker = path.join(worker.workspace, 'descendant-survived.txt')
		const childScript = path.join(worker.workspace, 'stubborn-child.cjs')
		await writeFile(
			childScript,
			`process.on('SIGTERM', () => {})\nsetTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 500)\nsetInterval(() => {}, 1000)`,
		)
		const lease = await reserve(worker)
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: '/bin/sh',
				args: ['-c', `${process.execPath} ${childScript} & echo READY; wait`],
				timeoutMs: 5_000,
			}),
		})
		expect(response.status).toBe(200)
		const reader = response.body.getReader()
		const firstChunk = await reader.read()
		expect(new TextDecoder().decode(firstChunk.value)).toContain('READY')

		const cancelled = await cancel(worker, lease.executionId)
		expect(cancelled.status).toBe(200)
		const cancellation = await cancelled.json()
		expect(cancellation).toMatchObject({
			ok: true,
			state: 'cancelled',
			started: true,
		})
		expect(cancellation.result.timedOut).toBe(false)

		let tail = ''
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) break
			tail += new TextDecoder().decode(chunk.value)
		}
		expect(tail).toContain('"type":"result"')
		await new Promise((resolve) => setTimeout(resolve, 650))
		await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
	}, 10_000)

	it('delivers TERM to the owned process group before the kill grace expires', async () => {
		worker = await spawnWorker({
			NAMZU_SANDBOX_CANCEL_GRACE_MS: '700',
			NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: '1500',
		})
		const marker = path.join(worker.workspace, 'term-missed.txt')
		const childScript = path.join(worker.workspace, 'term-child.cjs')
		await writeFile(
			childScript,
			`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'term missed'), 500)\nsetInterval(() => {}, 1000)`,
		)
		const lease = await reserve(worker)
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: '/bin/sh',
				args: ['-c', `${process.execPath} ${childScript} & echo READY; wait`],
				timeoutMs: 5_000,
			}),
		})
		const reader = response.body.getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('READY')

		const startedAt = Date.now()
		expect((await cancel(worker, lease.executionId)).status).toBe(200)
		expect(Date.now() - startedAt).toBeLessThan(500)
		await new Promise((resolve) => setTimeout(resolve, 550))
		await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
	}, 10_000)

	it('preserves natural completion when cancel arrives between exit and close', async () => {
		worker = await spawnWorker({
			NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: '1500',
		})
		const descendant = path.join(worker.workspace, 'stdio-holder.cjs')
		await writeFile(descendant, 'setTimeout(() => process.exit(0), 300)')
		const lease = await reserve(worker)
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: '/bin/sh',
				args: ['-c', `${process.execPath} ${descendant} & echo LEADER_EXIT; exit 0`],
				timeoutMs: 120,
			}),
		})
		const reader = response.body.getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('LEADER_EXIT')
		await new Promise((resolve) => setTimeout(resolve, 80))

		const cancellation = await cancel(worker, lease.executionId)
		expect(await cancellation.json()).toMatchObject({
			state: 'completed',
			started: true,
			result: { exitCode: 0, timedOut: false },
		})
	}, 10_000)

	it('does not report natural completion while a detached-stdio descendant can still mutate', async () => {
		worker = await spawnWorker({
			NAMZU_SANDBOX_CANCEL_GRACE_MS: '80',
			NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: '1500',
		})
		const marker = path.join(worker.workspace, 'background-survived.txt')
		const groupFile = path.join(worker.workspace, 'background.pgid')
		const childScript = path.join(worker.workspace, 'background-child.cjs')
		await writeFile(
			childScript,
			`process.on('SIGTERM', () => {})\nsetTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 500)\nsetInterval(() => {}, 1000)`,
		)
		const lease = await reserve(worker)
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				executionId: lease.executionId,
				command: '/bin/sh',
				args: [
					'-c',
					`printf '%s' $$ > ${groupFile}; ${process.execPath} ${childScript} >/dev/null 2>&1 & echo DONE`,
				],
				timeoutMs: 5_000,
			}),
		})

		expect(response.status).toBe(200)
		await expect(response.text()).rejects.toThrow()
		expect(await waitForExit(worker.child)).toBe(1)
		const processGroupId = Number(await readFile(groupFile, 'utf8'))
		expect(Number.isSafeInteger(processGroupId)).toBe(true)
		try {
			process.kill(-processGroupId, 'SIGKILL')
		} catch (error) {
			if (error?.code !== 'ESRCH') throw error
		}
		await new Promise((resolve) => setTimeout(resolve, 650))
		await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
	}, 10_000)

	it('retires the worker when timeout termination cannot be confirmed', async () => {
		worker = await spawnWorker({
			NAMZU_SANDBOX_CANCEL_GRACE_MS: '1000',
			NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: '0',
		})
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				command: process.execPath,
				args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
				timeoutMs: 20,
			}),
		})
		await response.text().catch(() => '')
		expect(await waitForExit(worker.child)).toBe(1)
	}, 10_000)

	it('does not let the idle timer exit while a command is active', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '40' })
		const response = await fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				command: process.execPath,
				args: ['-e', 'setTimeout(() => console.log("done"), 150)'],
				timeoutMs: 1_000,
			}),
		})
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('done')
		expect(worker.child.exitCode).toBeNull()
	})

	it('does not arm idle shutdown during awaited command preparation', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '40' }, (source) =>
			replaceUnique(
				source,
				'await fs.mkdir(cwd, { recursive: true })',
				'await new Promise((resolve) => setTimeout(resolve, 120))\n\t\tawait fs.mkdir(cwd, { recursive: true })',
			),
		)
		const execution = fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				command: process.execPath,
				args: ['-e', 'console.log("done")'],
				timeoutMs: 1_000,
			}),
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		await fetch(`${worker.baseUrl}/read-file`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'server.cjs' }),
		})
		expect(await (await execution).text()).toContain('done')
		expect(worker.child.exitCode).toBeNull()
	})

	it('does not arm idle shutdown while an execute request body is still arriving', async () => {
		worker = await spawnWorker({ NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '40' })
		let finishBody
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{'))
				finishBody = () => {
					controller.enqueue(
						new TextEncoder().encode(
							`"command":${JSON.stringify(process.execPath)},"args":["-e","console.log('done')"]}`,
						),
					)
					controller.close()
				}
			},
		})
		const execution = fetch(`${worker.baseUrl}/execute`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			duplex: 'half',
		}).then(
			async (response) => ({ ok: true, text: await response.text() }),
			(error) => ({ ok: false, error }),
		)
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect((await fetch(`${worker.baseUrl}/executions/reserve`, { method: 'POST' })).status).toBe(
			201,
		)
		await new Promise((resolve) => setTimeout(resolve, 70))
		finishBody()
		expect(await execution).toMatchObject({
			ok: true,
			text: expect.stringContaining('done'),
		})
	})

	it.each([
		[
			'read',
			'const buf = await fs.readFile(real)',
			'await new Promise((resolve) => setTimeout(resolve, 120))\n\t\tconst buf = await fs.readFile(real)',
			'/read-file',
			{ path: 'server.cjs' },
		],
		[
			'write',
			'await fs.writeFile(real, buf)',
			'await new Promise((resolve) => setTimeout(resolve, 120))\n\t\tawait fs.writeFile(real, buf)',
			'/write-file',
			{ path: 'held.txt', content: 'done' },
		],
	])(
		'keeps the worker alive throughout an awaited %s request',
		async (_label, anchor, replacement, endpoint, body) => {
			worker = await spawnWorker({ NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '40' }, (source) =>
				replaceUnique(source, anchor, replacement),
			)
			const response = await fetch(`${worker.baseUrl}${endpoint}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			expect(response.status).toBe(200)
			expect(worker.child.exitCode).toBeNull()
		},
	)
})
