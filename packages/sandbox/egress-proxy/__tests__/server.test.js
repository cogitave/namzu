import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The egress proxy container's entrypoint, run as the container runs it.
 *
 * It is started as a SUBPROCESS rather than imported, for the same reason
 * `worker/__tests__/the-worker-does-not-hand-over-its-own-config.test.js`
 * starts the worker that way: what this file has to prove is not that a
 * function returns the right value, it is that a process handed a
 * configuration either comes up as the boundary or refuses to — and refusing
 * means exiting non-zero, which a process cannot do to itself inside a test
 * runner.
 *
 * The layout the image builds is reproduced rather than mocked: the entrypoint
 * is copied to a temporary directory and a stub `egress/index.js` is written
 * beside it, which is where `DEFAULT_PROXY_MODULE` resolves relative to. That
 * makes the relative path itself part of what is under test — the image copies
 * `dist/egress` to `/opt/namzu-egress/egress` and this file to
 * `/opt/namzu-egress/server.mjs`, and a resolution that only worked in the
 * repository would fail there.
 *
 * NOT MEASURED HERE. That a container built from `Dockerfile` behaves this way.
 * No test in this repository starts a container; see `Dockerfile` and
 * `src/backends/docker/__tests__/egress-topology.test.ts`.
 */

const ENTRYPOINT = path.join(import.meta.dirname, '..', 'server.mjs')
const CONFIG_ENV = 'NAMZU_EGRESS_PROXY_CONFIG'

/**
 * A stand-in for the compiled boundary.
 *
 * It records the options it was constructed with instead of proxying, so the
 * assertions are about what the entrypoint derived — the bind address, the
 * self names, the credentials — rather than about `EgressProxy`, which has its
 * own suite. It holds the event loop open with a timer rather than a socket,
 * which is what a real listener would do: a process with nothing left to do
 * exits on its own, and then the signal this file is testing would arrive
 * after Node had already stopped watching for it.
 */
const STUB_MODULE = `import { writeFileSync } from 'node:fs'
export class EgressProxy {
	constructor(options) {
		this.options = options
	}
	async listen(port) {
		// Written here rather than in the constructor because the allowlist
		// arrives as a callback, and CALLING it is part of what is under test:
		// the entrypoint closes over the configuration it parsed, and a
		// closure that resolved to something else would be a boundary
		// enforcing a policy nobody wrote.
		const { allowedHosts, ...rest } = this.options
		writeFileSync(
			process.env.NAMZU_TEST_PROXY_OPTIONS_FILE,
			JSON.stringify({ ...rest, allowedHosts: await allowedHosts() }),
		)
		this.timer = setInterval(() => {}, 1000)
		return {
			port,
			url: 'http://0.0.0.0:' + port,
			setAllowedHosts: () => {},
			close: async () => {
				clearInterval(this.timer)
			},
		}
	}
}
`

let workDir

async function makeProxyHome() {
	workDir = await mkdtemp(path.join(tmpdir(), 'namzu-egress-proxy-'))
	const entry = path.join(workDir, 'server.mjs')
	await writeFile(entry, await readFile(ENTRYPOINT, 'utf8'))
	await writeFile(path.join(workDir, 'package.json'), '{"type":"module"}\n')
	const egressDir = path.join(workDir, 'egress')
	await mkdir(egressDir, { recursive: true })
	await writeFile(path.join(egressDir, 'index.js'), STUB_MODULE)
	return { entry, optionsFile: path.join(workDir, 'options.json') }
}

/** Run the entrypoint and settle once it exits, or once it says it is up. */
function runEntrypoint(entry, env, { stopAfterReady = true } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entry], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (result) => {
			if (settled) return
			settled = true
			resolve(result)
		}
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf8')
			// The container's own readiness signal, which is also what
			// `docker logs` shows an operator.
			if (stopAfterReady && stdout.includes('listening on') && child.exitCode === null) {
				child.kill('SIGTERM')
			}
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf8')
		})
		child.on('error', reject)
		child.on('close', (code) => finish({ code, stdout, stderr }))
		setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
	})
}

afterEach(async () => {
	if (workDir) await rm(workDir, { recursive: true, force: true })
	workDir = undefined
})

const GOOD_CONFIG = {
	port: 2025,
	allowedHosts: ['api.example.com'],
	credentials: [{ host: 'api.example.com', header: 'authorization', value: 'real' }],
	allowInwardFor: ['inside.example'],
	selfNames: ['namzu-egress'],
}

describe('the entrypoint starts the boundary it was configured with', () => {
	it('reads the policy out of the environment and listens on the port it names', async () => {
		const { entry, optionsFile } = await makeProxyHome()
		const result = await runEntrypoint(entry, {
			[CONFIG_ENV]: JSON.stringify(GOOD_CONFIG),
			NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile,
		})

		expect(result.code).toBe(0)
		expect(result.stdout).toContain('listening on 0.0.0.0:2025')
		// The counts, and not the values: a log line is not a place to spill
		// what the boundary is holding.
		expect(result.stdout).toContain('1 allowed host(s)')
		expect(result.stdout).toContain('1 brokered credential(s)')
		expect(result.stdout).not.toContain('real')

		const options = JSON.parse(await readFile(optionsFile, 'utf8'))
		expect(options.allowedHosts).toEqual(['api.example.com'])
		expect(options.credentials).toEqual([GOOD_CONFIG.credentials[0]])
		expect(options.allowInwardFor).toEqual(['inside.example'])
	})

	it('binds every interface, because inside the container the container IS the boundary', async () => {
		// The same class binds loopback by default for the host-side
		// deployment; here the sandbox dials this container over a network and
		// a loopback listener would be unreachable from it.
		const { entry, optionsFile } = await makeProxyHome()
		await runEntrypoint(entry, {
			[CONFIG_ENV]: JSON.stringify(GOOD_CONFIG),
			NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile,
		})
		const options = JSON.parse(await readFile(optionsFile, 'utf8'))
		expect(options.bindHost).toBe('0.0.0.0')
	})

	it('knows its own names, so the loop guard is not open', async () => {
		// Bound to 0.0.0.0, `isSelf` cannot close over loopback spellings alone:
		// a request whose target is this container's network alias would be
		// forwarded back to itself until the process ran out of sockets.
		const { entry, optionsFile } = await makeProxyHome()
		await runEntrypoint(entry, {
			[CONFIG_ENV]: JSON.stringify(GOOD_CONFIG),
			NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile,
		})
		const options = JSON.parse(await readFile(optionsFile, 'utf8'))
		expect(options.selfNames).toContain('namzu-egress')
		// The container's hostname is the alias too (`--hostname` in the argv),
		// and it is read from the process rather than passed beside it.
		expect(options.selfNames).toContain(os.hostname())
	})

	it('stops cleanly on the signal `docker rm -f` sends first', async () => {
		// A process that ignored SIGTERM would be SIGKILLed, which is fine, but
		// the exit code the test above asserts is only meaningful if the stop is
		// the graceful one.
		const { entry, optionsFile } = await makeProxyHome()
		const result = await runEntrypoint(entry, {
			[CONFIG_ENV]: JSON.stringify(GOOD_CONFIG),
			NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile,
		})
		expect(result.code).toBe(0)
	})
})

describe('the entrypoint refuses a configuration it cannot enforce', () => {
	/** Every one of these must exit non-zero: the container is `--rm`, and a
	 * proxy that came up with a policy nobody wrote would be the sandbox's only
	 * route out while deciding nothing. */
	const cases = [
		['no configuration at all', undefined, /is not set/],
		['configuration that is not JSON', '{not json', /not valid JSON/],
		['a JSON array rather than an object', '["api.example.com"]', /must be a JSON object/],
		['a configuration with no allowlist', '{"port":2025}', /allowedHosts/],
		['an allowlist that is not a list', '{"allowedHosts":"api.example.com"}', /allowedHosts/],
		['an allowlist with an empty entry', '{"allowedHosts":[""]}', /allowedHosts\[0\]/],
		['a port outside the range', '{"allowedHosts":[],"port":70000}', /port must be an integer/],
		[
			'a credential missing a field',
			'{"allowedHosts":[],"credentials":[{"host":"a.example","header":"authorization"}]}',
			/credentials\[0\]\.value/,
		],
	]

	it.each(cases)('exits non-zero on %s', async (_name, config, expected) => {
		const { entry, optionsFile } = await makeProxyHome()
		const env = { NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile }
		if (config !== undefined) env[CONFIG_ENV] = config
		const result = await runEntrypoint(entry, env, { stopAfterReady: false })
		expect(result.code).not.toBe(0)
		expect(result.stderr).toMatch(expected)
	})

	it('says what it was configured with when it starts, and nothing when it refuses', async () => {
		// The two halves of the same fact: an operator reading `docker logs`
		// must be able to tell "the boundary is up" from "the boundary refused
		// to start", and a refusal must not look like a quiet success.
		const { entry, optionsFile } = await makeProxyHome()
		const refused = await runEntrypoint(
			entry,
			{ [CONFIG_ENV]: '{"port":2025}', NAMZU_TEST_PROXY_OPTIONS_FILE: optionsFile },
			{ stopAfterReady: false },
		)
		expect(refused.stdout).not.toContain('listening on')
		expect(refused.stderr).toContain('namzu-egress-proxy:')
	})
})
