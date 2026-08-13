import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The worker used to spawn every command with `{ ...process.env, ...body.env }`,
 * so its entire environment reached the code it exists to contain — including
 * `NAMZU_SANDBOX_WORKSPACE`, `_READ_ROOTS` and `_WRITE_ROOTS`, which describe
 * the confinement layout to the thing being confined.
 *
 * These drive the real worker as a subprocess and read the environment back
 * out of an actually-spawned child, because that is the only place the answer
 * is observable. Asserting on `childEnvironment` directly would prove the
 * helper filters and say nothing about whether `/execute` calls it.
 */

async function spawnWorker(env) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-sandbox-worker-env-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, source)

	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: String(port),
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: workspace,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	await waitForListening(child)

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		async stop() {
			// Wait for the process to actually go before removing the
			// directory its script is running from: on Windows the file stays
			// locked until then and `rm` fails with EBUSY, turning teardown
			// into a test failure that says nothing about the subject.
			const exited = new Promise((resolve) => child.once('exit', resolve))
			child.kill('SIGKILL')
			await exited
			await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		},
	}
}

/**
 * A worker spawn plus a child process does not fit in vitest's 5s default.
 *
 * Generous rather than tight on purpose. These wait on two real process
 * starts, so the number bounds a machine under load rather than the work —
 * a healthy run exits as soon as the assertion is made and pays nothing for
 * the headroom, while a tight bound turns a busy CI runner into a red build
 * that says nothing about the subject. One failure was observed here with a
 * heavy repo-wide script running alongside.
 */
const NEEDS_TWO_PROCESSES = 60_000

function waitForListening(child) {
	return new Promise((resolve, reject) => {
		let out = ''
		const onData = (chunk) => {
			out += chunk.toString('utf8')
			if (out.includes('listening on')) {
				cleanup()
				resolve()
			}
		}
		const onExit = (code) => {
			cleanup()
			reject(new Error(`worker exited early (${code}): ${out}`))
		}
		const cleanup = () => {
			child.stdout.off('data', onData)
			child.stderr.off('data', onData)
			child.off('exit', onExit)
		}
		child.stdout.on('data', onData)
		child.stderr.on('data', onData)
		child.on('exit', onExit)
	})
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
	})
}

/** Run a command through the worker and return the environment it saw. */
async function environmentSeenByChild(worker, requestedEnv) {
	const res = await fetch(`${worker.baseUrl}/execute`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			command: process.execPath,
			args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
			...(requestedEnv ? { env: requestedEnv } : {}),
		}),
	})

	const stdout = (await res.text())
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((event) => event.type === 'stdout_delta')
		.map((event) => event.data)
		.join('')

	return JSON.parse(stdout)
}

describe('the environment a sandboxed command runs in', () => {
	let worker

	afterEach(async () => {
		if (worker) await worker.stop()
		worker = undefined
	}, NEEDS_TWO_PROCESSES)

	it('does not describe the confinement layout to the confined code', async () => {
		// The concrete case. A command could read the workspace root and both
		// root lists straight out of its own environment.
		worker = await spawnWorker()

		const seen = await environmentSeenByChild(worker)

		expect(seen.NAMZU_SANDBOX_WORKSPACE).toBeUndefined()
		expect(seen.NAMZU_SANDBOX_READ_ROOTS).toBeUndefined()
		expect(seen.NAMZU_SANDBOX_WRITE_ROOTS).toBeUndefined()
	}, NEEDS_TWO_PROCESSES)

	it('strips by prefix, so a setting added later is covered without being listed', async () => {
		// A deny-list of known names would leak whatever is added next. The
		// prefix is the boundary, which is why the constant carries a docblock
		// saying so.
		worker = await spawnWorker({ NAMZU_SANDBOX_SOME_FUTURE_SECRET: 'must-not-propagate' })

		const seen = await environmentSeenByChild(worker)

		expect(seen.NAMZU_SANDBOX_SOME_FUTURE_SECRET).toBeUndefined()
		expect(Object.keys(seen).filter((k) => k.startsWith('NAMZU_SANDBOX_'))).toEqual([])
	}, NEEDS_TWO_PROCESSES)

	it('still passes the proxy variables, which are set on purpose', async () => {
		// The half that makes an allowlist wrong. The egress boundary works by
		// tooling inside honouring these; dropping them stops every workload
		// being proxied, which looks exactly like the policy working.
		worker = await spawnWorker({
			HTTP_PROXY: 'http://namzu-egress:8080',
			HTTPS_PROXY: 'http://namzu-egress:8080',
			NO_PROXY: 'localhost,127.0.0.1',
		})

		const seen = await environmentSeenByChild(worker)

		expect(seen.HTTP_PROXY).toBe('http://namzu-egress:8080')
		expect(seen.HTTPS_PROXY).toBe('http://namzu-egress:8080')
		expect(seen.NO_PROXY).toBe('localhost,127.0.0.1')
	}, NEEDS_TWO_PROCESSES)

	it('still passes the host’s own environment, which is meant to reach commands', async () => {
		// A host's `options.env` arrives on the same channel as the worker's
		// config and is indistinguishable from it once both are in
		// `process.env`. Only the prefix tells them apart.
		worker = await spawnWorker({ MY_APP_TOKEN: 'host-supplied' })

		const seen = await environmentSeenByChild(worker)

		expect(seen.MY_APP_TOKEN).toBe('host-supplied')
	}, NEEDS_TWO_PROCESSES)

	it('still passes PATH, or nothing would run at all', async () => {
		worker = await spawnWorker()

		const seen = await environmentSeenByChild(worker)

		expect(seen.PATH ?? seen.Path).toBeTruthy()
	}, NEEDS_TWO_PROCESSES)

	it('lets an explicit per-call value through, including a prefixed one', async () => {
		// Inheritance is implicit and gets the default; `body.env` is a caller
		// deciding. Filtering that too would silently drop a value the caller
		// asked for by name.
		worker = await spawnWorker()

		const seen = await environmentSeenByChild(worker, { NAMZU_SANDBOX_WORKSPACE: 'chosen' })

		expect(seen.NAMZU_SANDBOX_WORKSPACE).toBe('chosen')
	}, NEEDS_TWO_PROCESSES)
})
