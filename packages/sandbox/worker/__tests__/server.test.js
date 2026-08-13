import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
async function spawnWorker(env) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-sandbox-worker-test-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, source)

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
		async stop() {
			child.kill('SIGKILL')
			await rm(workspace, { recursive: true, force: true })
		},
	}
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
				body: JSON.stringify({ command: process.execPath, args: ['-e', ''], timeoutMs }),
			})
			expect(res.status).toBe(400)
		}
	})
})
