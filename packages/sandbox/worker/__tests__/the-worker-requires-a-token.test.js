import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The worker's control API authenticated nothing. `/execute` ran an
 * arbitrary command inside the sandbox for anyone who could open a socket
 * to it, `/read-file` and `/write-file` did the same for the filesystem,
 * and the only thing standing between those and a caller was where the
 * container happened to sit on the network — which is a property of a
 * deployment, not of the file, and is absent on the standby-pool backend
 * whenever a claim takes a public address.
 *
 * These drive the real worker as a subprocess, because that is the only
 * place the answer is observable: a test of the comparison helper would
 * prove the helper compares and say nothing about whether the router calls
 * it before a handler.
 *
 * `/healthz` is asserted here too, from the other side. It is the route the
 * host probes before it has any other business with the worker, so a
 * worker that required a token for it would answer a liveness question
 * with a credential error. The exact shape of that exemption is asserted
 * with it: the whole URL has to match, and nothing but `GET` does, so
 * `POST /healthz`, `GET /healthz?x=1` and `GET /healthz/` are gated, and
 * the two header shapes a client library cannot produce — a duplicated
 * `Authorization` and an obs-folded one — are asked over a raw socket.
 */

const TOKEN = 'a-per-instance-token-for-this-worker'

async function getFreePort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
	})
}

async function startWorker(env = {}) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-worker-auth-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, source)

	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: String(port),
			// Loopback so this suite is about the credential and not about the
			// bind-address rule, which has its own file.
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: workspace,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	await new Promise((resolve, reject) => {
		let out = ''
		const timer = setTimeout(() => reject(new Error(`worker never bound: ${out}`)), 15_000)
		child.stdout.on('data', (chunk) => {
			out += chunk.toString('utf8')
			if (out.includes('listening on')) {
				clearTimeout(timer)
				resolve()
			}
		})
		child.once('exit', (code) => {
			clearTimeout(timer)
			reject(new Error(`worker exited early (${code}): ${out}`))
		})
	})

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		workspace,
		async stop() {
			const exited = new Promise((resolve) => child.once('exit', resolve))
			child.kill('SIGKILL')
			await exited
			await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		},
	}
}

/**
 * A request written onto the socket by hand, for the header shapes `fetch`
 * will not produce.
 *
 * A duplicated `Authorization` and an obs-folded header are both decided by
 * the HTTP parser, and a client library that normalises headers away cannot
 * ask the question. Every request here carries `Connection: close`, so the
 * answer is bounded by the socket closing rather than by a timer.
 */
async function rawRequest(port, request) {
	return await new Promise((resolve, reject) => {
		const socket = net.connect(port, '127.0.0.1')
		let answer = ''
		socket.setEncoding('utf8')
		socket.on('connect', () => socket.write(request))
		socket.on('data', (chunk) => {
			answer += chunk
		})
		socket.on('error', reject)
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`no answer within 5s: ${JSON.stringify(answer)}`))
		}, 5_000)
		timer.unref?.()
		socket.on('close', () => {
			clearTimeout(timer)
			resolve(answer)
		})
	})
}

/** The status line of a raw answer, as a number. */
function statusOf(answer) {
	return Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? Number.NaN)
}

/**
 * A worker spawn plus an HTTP round trip does not fit vitest's 5s default,
 * and the number bounds a machine under load rather than the work.
 */
const NEEDS_A_PROCESS = 60_000

/** Every route that does something, with the body it needs to do it. */
function calls(workspace) {
	return [
		['/execute', { command: 'echo', args: ['probe'] }],
		['/executions/reserve', undefined],
		['/cancel', { executionId: 'exec_00000000-0000-4000-8000-000000000000' }],
		['/write-file', { path: path.join(workspace, 'written.txt'), content: 'x', encoding: 'utf8' }],
		['/read-file', { path: path.join(workspace, 'written.txt'), encoding: 'utf8' }],
	]
}

async function postRoute(worker, route, body, headers) {
	return await fetch(`${worker.baseUrl}${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
}

describe('the worker control API with a token configured', () => {
	let worker

	afterEach(async () => {
		if (worker) await worker.stop()
		worker = undefined
	}, NEEDS_A_PROCESS)

	it(
		'answers every route with the right token and 401 without one',
		async () => {
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })
			const authorization = { authorization: `Bearer ${TOKEN}` }

			for (const [route, body] of calls(worker.workspace)) {
				const authorized = await postRoute(worker, route, body, authorization)
				// 400/404 are this suite's own fixtures being thin (a file that
				// does not exist yet, an execution id that was never reserved).
				// What is asserted is that the request REACHED the handler: any
				// answer but 401 proves the gate let it through.
				expect(authorized.status, `${route} with the token`).not.toBe(401)

				const anonymous = await postRoute(worker, route, body, {})
				expect(anonymous.status, `${route} without a token`).toBe(401)
				expect(await anonymous.json(), `${route} without a token`).toEqual({
					error: 'unauthorized',
				})
			}
		},
		NEEDS_A_PROCESS,
	)

	it(
		'answers /healthz without a token, because readiness probing has no secret',
		async () => {
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			const response = await fetch(`${worker.baseUrl}/healthz`)

			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ ok: true })
		},
		NEEDS_A_PROCESS,
	)

	it(
		'refuses a wrong token, a bare token and an empty bearer exactly as it refuses none',
		async () => {
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			for (const authorization of [
				'Bearer not-the-token',
				// The value without its scheme is not a credential this API
				// accepts, whatever the intent behind it.
				TOKEN,
				'Bearer ',
				`Basic ${Buffer.from(TOKEN).toString('base64')}`,
			]) {
				const response = await postRoute(worker, '/execute', { command: 'echo' }, { authorization })

				expect(response.status, `authorization: ${authorization}`).toBe(401)
			}
		},
		NEEDS_A_PROCESS,
	)

	it(
		'refuses an unknown route without a token rather than telling the caller it is unknown',
		async () => {
			// Ordering, not politeness: a 404 here would answer "which routes
			// exist" to a caller who has presented nothing. (It would not also
			// disclose the drain state — that is the poison check's answer, and
			// it runs ahead of every dispatch — but the route table is reason
			// enough on its own.)
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			const response = await postRoute(worker, '/not-a-route', undefined, {})

			expect(response.status).toBe(401)
		},
		NEEDS_A_PROCESS,
	)

	it(
		'does not let a refused request write the file it asked to write',
		async () => {
			// The difference between "the handler ran and said no" and "the
			// handler never ran" is observable only in the state it would have
			// changed.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })
			const target = path.join(worker.workspace, 'never-written.txt')

			const refused = await postRoute(
				worker,
				'/write-file',
				{ path: target, content: 'refused', encoding: 'utf8' },
				{},
			)
			expect(refused.status).toBe(401)

			const allowed = await postRoute(
				worker,
				'/write-file',
				{ path: target, content: 'allowed', encoding: 'utf8' },
				{ authorization: `Bearer ${TOKEN}` },
			)
			expect(allowed.status).toBe(200)

			expect(await readFile(target, 'utf8')).toBe('allowed')
		},
		NEEDS_A_PROCESS,
	)

	it(
		'gates every request that is not exactly `GET /healthz`',
		async () => {
			// The exemption is an exact match on the method AND the whole
			// URL. A query string, a trailing slash, another method on the
			// same path and a method with no route behind it all land on the
			// gate — and with the token they are the 404 that says the route
			// does not exist, which is what makes the gate rather than the
			// route table the thing that answered.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			for (const [method, route] of [
				['POST', '/healthz'],
				['GET', '/healthz?x=1'],
				['GET', '/healthz/'],
				['HEAD', '/healthz'],
				['PUT', '/healthz'],
				['DELETE', '/execute'],
			]) {
				const anonymous = await fetch(`${worker.baseUrl}${route}`, { method })
				expect(anonymous.status, `${method} ${route} without a token`).toBe(401)

				const authorized = await fetch(`${worker.baseUrl}${route}`, {
					method,
					headers: { authorization: `Bearer ${TOKEN}` },
				})
				expect(authorized.status, `${method} ${route} with the token`).toBe(404)
			}
		},
		NEEDS_A_PROCESS,
	)

	it(
		'answers a route that does not exist with a 404 once the token is presented',
		async () => {
			// The other half of the ordering assertion above: with the token,
			// a caller gets the answer they have earned — the route is not
			// there — rather than the 401 that would keep the route table a
			// secret from a caller who is already inside the gate.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			const response = await postRoute(worker, '/not-a-route', undefined, {
				authorization: `Bearer ${TOKEN}`,
			})

			expect(response.status).toBe(404)
			expect(await response.json()).toEqual({ error: 'not_found' })
		},
		NEEDS_A_PROCESS,
	)

	it(
		'reads the FIRST of two Authorization headers, whichever order they arrive in',
		async () => {
			// The HTTP parser keeps the first of a header it treats as
			// singular, so a second one is not a second chance at guessing.
			// Worth pinning: if a rewrite ever let the last value win, a
			// caller who appends could displace the credential with one they
			// chose — a proxy, a client that appends its own header, or an
			// attacker who can already add a header.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })
			const route = '/healthz?x=1' // gated, and a 404 when it is reached

			const goodFirst = await rawRequest(
				worker.port,
				[
					`GET ${route} HTTP/1.1`,
					'Host: worker',
					`Authorization: Bearer ${TOKEN}`,
					'Authorization: Bearer not-the-token',
					'Connection: close',
					'',
					'',
				].join('\r\n'),
			)
			expect(statusOf(goodFirst)).toBe(404)

			const badFirst = await rawRequest(
				worker.port,
				[
					`GET ${route} HTTP/1.1`,
					'Host: worker',
					'Authorization: Bearer not-the-token',
					`Authorization: Bearer ${TOKEN}`,
					'Connection: close',
					'',
					'',
				].join('\r\n'),
			)
			expect(statusOf(badFirst)).toBe(401)
		},
		NEEDS_A_PROCESS,
	)

	it(
		'refuses an obs-folded Authorization before the router, so a fold is not a way in',
		async () => {
			// A header continued on the next line is refused by the HTTP
			// parser with its own bare `400 Connection: close` — no JSON body,
			// because no handler and no gate ever saw it. That is the answer
			// for a fold carrying the right token and for one carrying
			// anything else, so the shape is not a way past the gate; it is
			// not a way to ask the worker anything at all.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			for (const continuation of [` ${TOKEN}`, `\t${TOKEN}`, ' anything-at-all']) {
				const answer = await rawRequest(
					worker.port,
					[
						'POST /execute HTTP/1.1',
						'Host: worker',
						'Authorization: Bearer',
						continuation,
						'Connection: close',
						'Content-Length: 0',
						'',
						'',
					].join('\r\n'),
				)

				expect(statusOf(answer), JSON.stringify(continuation)).toBe(400)
				expect(answer).not.toContain('unauthorized')
			}
		},
		NEEDS_A_PROCESS,
	)

	it(
		'never hands the token to a command the sandbox runs',
		async () => {
			// The token rides in this process's environment, and the worker
			// hands its environment to every command it spawns — minus the
			// `NAMZU_SANDBOX_` prefix, which is why the credential has to carry
			// it. Anything a sandboxed task can read is a credential the sandbox
			// can replay against its own control API; inside the container that
			// is privilege it already has, but the execution lease, the file
			// roots and this token would also be readable by a task running
			// under a DIFFERENT sandbox that shares the process, and by every
			// transcript the agent prints.
			worker = await startWorker({ NAMZU_SANDBOX_TOKEN: TOKEN })

			const response = await postRoute(
				worker,
				'/execute',
				{
					command: process.execPath,
					args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
				},
				{ authorization: `Bearer ${TOKEN}` },
			)

			const seen = (await response.text())
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((event) => event.type === 'stdout_delta')
				.map((event) => event.data)
				.join('')

			expect(Object.keys(JSON.parse(seen))).not.toContain('NAMZU_SANDBOX_TOKEN')
			expect(seen).not.toContain(TOKEN)
		},
		NEEDS_A_PROCESS,
	)
})
