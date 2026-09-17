import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A worker with no credential may listen on loopback and may not listen
 * anywhere else.
 *
 * The default bind is `0.0.0.0` and stays that way — a published container
 * port forwards to the container's interface address, not to its loopback,
 * so narrowing the default disables the container backend rather than
 * hardening it (see the sibling suite that pins that). That is exactly why
 * the credential has to exist, and why its absence cannot be allowed to
 * mean "serve anyway" on a routable address: a deployment that has not
 * been provisioned stops working, loudly, instead of continuing to run an
 * unauthenticated execute endpoint.
 *
 * The escape is asserted from both sides. `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1`
 * restores the old behaviour on purpose, and a value that is neither
 * affirmative nor absent fails CLOSED rather than being read as "on" —
 * a flag whose off-spelling enables it is a trap.
 *
 * A token that is SET is the other family of refusal: empty, padded, or
 * carrying a character an HTTP header cannot hold, each of which would
 * leave a worker that boots looking authenticated and refuses every caller
 * including its own host. The first two are asserted here; the third is
 * asserted against the boundary it draws (latin-1 is accepted), because a
 * refusal that also refused working tokens would be the same defect.
 */

const TOKEN = 'a-per-instance-token-for-this-worker'

const workers = []

afterEach(async () => {
	while (workers.length > 0) {
		const { child, workspace } = workers.pop()
		// A refused worker has already exited, and `once('exit')` on a process
		// that will not exit again is a test suite that hangs instead of
		// failing.
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once('exit', resolve))
			child.kill('SIGKILL')
			await exited
		}
		await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	}
})

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

/**
 * Start the real worker and report which way the startup decision went.
 *
 * The three-way answer the file's contract has: it bound, it refused with a
 * reason on stderr, or it DIED of something else — and the third is a
 * failure of the harness rather than a case, because a worker that exits
 * because its port was taken is not a worker that refused. Both `bound` and
 * `refused` are read from evidence rather than from the exit code: an
 * unhandled `listen` error used to exit 0 with nothing on stdout, which
 * this harness would have read as a refusal.
 */
async function startWorker(env) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-worker-bind-rule-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, source)

	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: String(port),
			NAMZU_SANDBOX_WORKSPACE: workspace,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	workers.push({ child, workspace })

	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString('utf8')
	})
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString('utf8')
	})

	const outcome = await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`worker neither bound nor refused: ${stdout}${stderr}`)),
			15_000,
		)
		child.stdout.on('data', () => {
			if (stdout.includes('listening on')) {
				clearTimeout(timer)
				resolve({ bound: true, refused: false, code: undefined, stdout, stderr })
			}
		})
		// `close` rather than `exit`: `exit` can fire while the refusal still
		// sits in the stderr pipe, and this suite asserts on that message.
		child.once('close', (code) => {
			clearTimeout(timer)
			resolve({
				bound: false,
				refused: stderr.includes('refusing to start'),
				code,
				stdout,
				stderr,
			})
		})
	})

	return { outcome, stdout: () => stdout, stderr: () => stderr }
}

/**
 * Every refusal, asserted as a refusal: it did NOT bind, it said why, and it
 * exited non-zero.
 *
 * The `refused` flag is what separates "the worker refused" from "the
 * worker died" — a distinction this suite needs, because a port that was
 * taken between `getFreePort()` and the spawn produces an exit with no
 * refusal in it, and reading that as a pass would turn a harness race into
 * a green test asserting nothing.
 */
function expectRefusal(outcome, reason) {
	expect(outcome.bound, reason).toBe(false)
	expect(outcome.refused, `${reason}: ${outcome.stderr || outcome.stdout}`).toBe(true)
	expect(outcome.code, reason).toBe(1)
}

/** The line the worker logs when it binds, which is where the address is. */
function bindLine(outcome) {
	return outcome.stdout.split('\n').find((line) => line.includes('listening on')) ?? ''
}

describe('the worker startup decision', () => {
	it('starts on loopback with no token, and says the mode out loud', async () => {
		// A local-only worker is not the exposure this rule is about: nothing
		// outside this container's network namespace can open that socket.
		// Refusing here would break the dev case and close nothing.
		const { outcome } = await startWorker({ NAMZU_SANDBOX_BIND: '127.0.0.1' })

		expect(outcome.bound).toBe(true)
		expect(bindLine(outcome)).toContain('listening on 127.0.0.1:')
		expect(bindLine(outcome)).toContain('auth=none')
	})

	it('starts on loopback when a token is configured, and says which mode', async () => {
		const { outcome } = await startWorker({
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_TOKEN: TOKEN,
		})

		expect(outcome.bound).toBe(true)
		expect(bindLine(outcome)).toContain('auth=bearer')
	})

	it('REFUSES to start when it would bind a routable address with no token', async () => {
		// The default bind, which is also the case that has to fail: it is the
		// shape every existing container deployment is in.
		const { outcome } = await startWorker({})

		expectRefusal(outcome, 'default bind, no token')
		// The refusal has to say what is wrong AND name a way out of it, or it
		// is a wall rather than a decision.
		expect(outcome.stderr).toContain('NAMZU_SANDBOX_TOKEN')
		expect(outcome.stderr).toContain('NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1')
		// Nothing answered on the port: the refusal happens before `listen`,
		// not after a socket has already accepted connections.
		expect(outcome.stdout).not.toContain('listening on')
	})

	it('REFUSES an explicit routable bind for the same reason', async () => {
		const { outcome } = await startWorker({ NAMZU_SANDBOX_BIND: '0.0.0.0' })

		expectRefusal(outcome, 'explicit 0.0.0.0, no token')
		expect(outcome.stderr).toContain('NAMZU_SANDBOX_BIND=0.0.0.0')
	})

	it('REFUSES a token that is empty, or only whitespace, in every mode', async () => {
		// An empty value is the shape an injected secret takes when the
		// injection resolved to nothing: honour it and the worker
		// authenticates nobody while looking configured, the worst of the
		// three states. A padded one is the same failure from the other side —
		// the token is read out of a TRIMMED header, so `' xyz '` can never be
		// presented, and the worker would boot authenticated and refuse every
		// caller including its host for the life of the container.
		for (const value of ['', ' ', '\t', `${TOKEN} `, ` ${TOKEN}`]) {
			const loopback = await startWorker({
				NAMZU_SANDBOX_BIND: '127.0.0.1',
				NAMZU_SANDBOX_TOKEN: value,
			})
			expectRefusal(loopback.outcome, `loopback, token ${JSON.stringify(value)}`)
			expect(loopback.outcome.stderr).toContain('NAMZU_SANDBOX_TOKEN is set but')

			const routable = await startWorker({ NAMZU_SANDBOX_TOKEN: value })
			expectRefusal(routable.outcome, `routable, token ${JSON.stringify(value)}`)
		}
	})

	it('REFUSES a token no HTTP header can carry, in every mode', async () => {
		// The same "boots authenticated and refuses its own host" shape as the
		// padded value above, one rung further out. The credential travels as
		// a header VALUE, and a header value carries one byte per character:
		// the client's own `fetch` throws `Cannot convert argument to a
		// ByteString` for a code point above U+00FF before the request leaves
		// the host, and the parser on this side drops the connection for the
		// C0 controls it will not accept. Either way the token can never be
		// presented, so the worker is asked for something nobody can give.
		for (const value of ['€-token', '🔑', 'a\u0001b', 'a\u007fb', 'a\nb', 'a\rb']) {
			const loopback = await startWorker({
				NAMZU_SANDBOX_BIND: '127.0.0.1',
				NAMZU_SANDBOX_TOKEN: value,
			})
			expectRefusal(loopback.outcome, `loopback, token ${JSON.stringify(value)}`)
			expect(loopback.outcome.stderr).toContain('NAMZU_SANDBOX_TOKEN carries a character')

			const routable = await startWorker({ NAMZU_SANDBOX_TOKEN: value })
			expectRefusal(routable.outcome, `routable, token ${JSON.stringify(value)}`)
		}
	})

	it('accepts every character a header CAN carry, so the rule is the byte, not ASCII', async () => {
		// The boundary from the other side. `é` and `ÿ` survive the round trip
		// — both ends carry them as one byte, latin-1 — and a tab or a space
		// inside a value is presented and matched like any other character. A
		// rule that refused everything outside ASCII would be refusing tokens
		// that work, which is the same defect as accepting ones that do not.
		for (const value of ['é-token', 'ÿ-token', 'with space', 'tab\tinside']) {
			const { outcome } = await startWorker({ NAMZU_SANDBOX_TOKEN: value })

			expect(outcome.bound, JSON.stringify(value)).toBe(true)
			expect(bindLine(outcome)).toContain('auth=bearer')
		}
	})

	it('starts unauthenticated on a routable address when the escape is set', async () => {
		// The named escape. It gives up the credential rather than deferring
		// it, which is why it is asserted to still be reachable — an escape
		// nobody can find is a break dressed as a policy.
		const { outcome } = await startWorker({ NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED: '1' })

		expect(outcome.bound).toBe(true)
		expect(bindLine(outcome)).toContain('listening on 0.0.0.0:')
	})

	it('reads an unrecognised escape value as NOT set, so a flag cannot turn itself on', async () => {
		// `= false` and `= 0` mean off. A worker that read either as "on"
		// would be one edit away from serving unauthenticated because someone
		// wrote a number. A padded value is unrecognised too, and for the
		// reason the docs give: this is a security escape, and the shape a
		// value takes in someone's editor is not a spelling it should accept.
		for (const value of ['0', 'false', 'no', 'off', '', ' yes ', 'yes ', ' on', 'TRUE ']) {
			const { outcome } = await startWorker({ NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED: value })

			expectRefusal(outcome, `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=${JSON.stringify(value)}`)
		}
	})

	it('accepts the escape in any case, and only in the four spellings', async () => {
		for (const value of ['1', 'true', 'TRUE', 'yes', 'Yes', 'ON']) {
			const { outcome } = await startWorker({ NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED: value })

			expect(outcome.bound, `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=${value}`).toBe(true)
			expect(bindLine(outcome)).toContain('auth=none')
		}
	})

	it('lets a configured token win over the escape, which can only mean "serve without one"', async () => {
		const { outcome } = await startWorker({
			NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED: '1',
			NAMZU_SANDBOX_TOKEN: TOKEN,
		})

		expect(outcome.bound).toBe(true)
		expect(bindLine(outcome)).toContain('auth=bearer')
	})

	it('exits non-zero when it cannot bind, rather than looking like a clean shutdown', async () => {
		// The port is held for the worker's whole life, so its `listen` fails.
		// Without a handler for that error the process logs it, has nothing
		// keeping its event loop alive, and exits 0 — a container that served
		// nothing and reported success. The harness's refusal flag is what
		// makes that distinguishable from the startup refusal this file is
		// about.
		const occupied = net.createServer()
		await new Promise((resolve, reject) => {
			occupied.once('error', reject)
			occupied.listen(0, '127.0.0.1', resolve)
		})
		const port = occupied.address().port

		try {
			const { outcome } = await startWorker({
				NAMZU_SANDBOX_PORT: String(port),
				NAMZU_SANDBOX_BIND: '127.0.0.1',
				NAMZU_SANDBOX_TOKEN: TOKEN,
			})

			expect(outcome.bound).toBe(false)
			expect(outcome.refused).toBe(false)
			expect(outcome.code).toBe(1)
			expect(outcome.stderr).toContain('could not listen on')
		} finally {
			await new Promise((resolve) => occupied.close(resolve))
		}
	})
})
