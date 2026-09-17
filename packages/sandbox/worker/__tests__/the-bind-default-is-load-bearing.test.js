import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * This worker binds every interface by default, and that is deliberate.
 *
 * It reads as a mistake — a control API listening everywhere — and it has
 * already been proposed as one. Measuring it settled the question: a
 * published container port translates to the container's bridge address,
 * so a worker bound to the container's own loopback is unreachable through
 * that port. Both of the container backend's reachability modes need a
 * non-loopback bind, so narrowing this default does not harden the
 * container tier, it disables it.
 *
 * So this test exists to fail on a well-meaning narrowing, and to make
 * whoever proposes it read the reason first. It pins the default, not
 * the ability to change it: `NAMZU_SANDBOX_BIND` still overrides.
 *
 * What changed is what makes the default defensible. The file used to
 * justify it by network placement alone, and the worker authenticated
 * nothing; a routable listener now requires a credential, so these cases
 * configure a token the way the container backend does — `docker run
 * --env NAMZU_SANDBOX_TOKEN=…` — and a worker without one refuses this
 * default outright. That refusal has its own suite. The subject here is
 * unchanged: the address the worker reports having bound.
 */

const workers = []

/**
 * The credential these cases start the worker with.
 *
 * Not incidental: without it the worker refuses every routable bind, and a
 * suite that reached for `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED` here would
 * be asserting the bound address of the escape path rather than of the
 * deployment the container backend actually creates.
 */
const TOKEN = 'a-per-instance-token-for-this-worker'

afterEach(async () => {
	while (workers.length > 0) {
		const w = workers.pop()
		w.child.kill('SIGKILL')
		await rm(w.workspace, { recursive: true, force: true })
	}
})

function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address()
			srv.close(() => resolve(port))
		})
	})
}

/** Start the real file and return the line it logs when it binds. */
async function startAndReadBindLine(env) {
	const port = await getFreePort()
	const workspace = await mkdtemp(path.join(os.tmpdir(), 'namzu-worker-bind-'))
	const source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	const entry = path.join(workspace, 'server.cjs')
	await writeFile(entry, source)

	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: String(port),
			NAMZU_SANDBOX_WORKSPACE: workspace,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			// The credential the container backend injects at `docker run`
			// time, so an unset bind is the only omission under test.
			NAMZU_SANDBOX_TOKEN: TOKEN,
			// Deliberately NOT setting NAMZU_SANDBOX_BIND unless a case asks
			// for it — the unset case is the whole subject here. The sibling
			// suite sets it, which is why it cannot observe this.
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	workers.push({ child, workspace })

	return await new Promise((resolve, reject) => {
		let out = ''
		const timer = setTimeout(() => reject(new Error(`worker never logged a bind: ${out}`)), 15_000)
		child.stdout.on('data', (chunk) => {
			out += chunk.toString('utf8')
			const line = out.split('\n').find((l) => l.includes('listening on'))
			if (line) {
				clearTimeout(timer)
				resolve(line)
			}
		})
		child.once('error', (err) => {
			clearTimeout(timer)
			reject(err)
		})
	})
}

describe('the worker bind address', () => {
	it('binds every interface when nothing says otherwise', async () => {
		const line = await startAndReadBindLine({})

		// Asserted on the address the worker reports having bound, rather
		// than on the source of the default. A test reading the constant
		// passes if the constant is right and the `listen` call ignores it.
		expect(line).toContain('listening on 0.0.0.0:')
	})

	it('still honours an explicit override, so the default is a default', async () => {
		const line = await startAndReadBindLine({ NAMZU_SANDBOX_BIND: '127.0.0.1' })

		expect(line).toContain('listening on 127.0.0.1:')
	})
})
