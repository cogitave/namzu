import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REMOTE_EXECUTION_PROTOCOL_VERSION } from '../../remote-execution-controller.js'
import { buildDockerBackend, resolveLayout } from '../index.js'
import type { DockerBackendInternalConfig } from '../index.js'
import {
	assertNetworkCarriesThePolicy,
	renderEgressProxyAttachArgs,
	renderEgressProxyRunArgs,
} from '../index.js'

/**
 * The container tier's egress topology, pinned as argv and as docker calls.
 *
 * #398: the allowlist was enforced by `HTTP_PROXY` and nothing else. The
 * proxy ran in the host process on loopback, the sandbox kept ordinary bridge
 * networking with full outbound reachability, and `--add-host
 * namzu-egress:host-gateway` was the only thing pointing traffic at the
 * boundary. Anything inside the container that opened a socket directly — a Go
 * or Rust binary that does not read proxy env, `curl --noproxy '*'`, a raw
 * `net.Socket` — reached the network with the allowlist unconsulted.
 *
 * The fix is the shape asserted here: the proxy is a container of its own,
 * `docker run` on an ordinary network for its route out and `docker network
 * connect`ed to the internal network the sandbox is on, where its alias is the
 * name the sandbox's proxy environment resolves. The sandbox joins the
 * internal network alone, which has no route off it, so the only way its
 * traffic reaches the internet is through that container — a route it cannot
 * put back, because `--cap-drop=ALL` took `NET_ADMIN` away. The proxy is not
 * its only reachable destination, and nothing here claims it is: the internal
 * network is a subnet, so a second sandbox on it, and that sandbox's proxy,
 * are reachable too. `docs/sdk/sandbox-egress.md` states that reach in full.
 *
 * NOT MEASURED HERE. No test in this repository starts a container: there is
 * no docker daemon in the test environment (see `hardening.test.ts`'s own note;
 * `sandbox-smoke.yml` is where a daemon exists, and it builds the proxy image).
 * What an argv comparison proves is what this backend ASKS for — that the
 * sandbox is handed no alias file and an internal network, that the proxy is
 * given both legs in the order that works, and that both containers are
 * accounted for at teardown. What it cannot prove is that a daemon honours it,
 * and that is stated in `docs/sdk/sandbox-egress.md` rather than implied by a
 * green suite.
 */

const CONTAINER_NETWORK = 'namzu-tasks'
const STATIC_ALLOWLIST = { kind: 'static', allowedHosts: ['api.example.com'] } as const

describe('assertNetworkCarriesThePolicy — an allowlist needs a boundary too', () => {
	it('is satisfied by an internal network reached by container name', () => {
		expect(() =>
			assertNetworkCarriesThePolicy(
				CONTAINER_NETWORK,
				'container-network',
				STATIC_ALLOWLIST,
				'true',
			),
		).not.toThrow()
	})

	it('is refused on a network the sandbox can still reach the world from', () => {
		// Which is what it was until this change: the allowlist answered the
		// configured network, and the only thing making traffic cross the
		// boundary was an environment variable.
		expect(() =>
			assertNetworkCarriesThePolicy(
				CONTAINER_NETWORK,
				'container-network',
				STATIC_ALLOWLIST,
				'false',
			),
		).toThrow(/is not internal/)
	})

	it('refuses a resolver policy the same way, because it needs the same boundary', () => {
		expect(() =>
			assertNetworkCarriesThePolicy(
				CONTAINER_NETWORK,
				'container-network',
				{ kind: 'resolver', resolve: async () => [] },
				'false',
			),
		).toThrow(/is not internal/)
	})

	it('names the network and the command that fixes it, so the refusal is actionable', () => {
		const refuse = () =>
			assertNetworkCarriesThePolicy('shared-bridge', 'container-network', STATIC_ALLOWLIST, 'false')
		expect(refuse).toThrow(/shared-bridge/)
		expect(refuse).toThrow(/docker network create --internal/)
		expect(refuse).toThrow(/container-network/)
	})

	it('leaves `deny-all` and `allow-all` alone', () => {
		// `deny-all` has its own rule and its own file. `allow-all` asks for
		// reach, so a network that has it is the answer rather than a defect —
		// and neither of them runs a proxy to reach.
		expect(() =>
			assertNetworkCarriesThePolicy(
				CONTAINER_NETWORK,
				'container-network',
				{ kind: 'allow-all' },
				'false',
			),
		).not.toThrow()
		expect(() =>
			assertNetworkCarriesThePolicy(CONTAINER_NETWORK, 'container-network', undefined, 'false'),
		).not.toThrow()
	})

	it('still refuses an allowlist over a published host port, from the publish rule', () => {
		// Two requirements that are exact opposites: a published port needs a
		// route out and an internal network has none. The refusal that fires is
		// the publish one, which already names the way forward.
		expect(() =>
			assertNetworkCarriesThePolicy(CONTAINER_NETWORK, 'host-port', STATIC_ALLOWLIST, 'true'),
		).toThrow(/cannot publish the worker's port/)
	})
})

const layout = resolveLayout({
	outputs: { source: { type: 'hostDir', hostPath: '/h/out' } },
})

function backendConfig(
	overrides: Partial<DockerBackendInternalConfig> = {},
): DockerBackendInternalConfig {
	return {
		image: 'namzu-sandbox:latest',
		egressProxyImage: 'namzu-egress-proxy:latest',
		layout,
		...overrides,
	}
}

function proxyArgvInput(overrides: Partial<Parameters<typeof renderEgressProxyRunArgs>[0]> = {}) {
	return {
		config: backendConfig(),
		containerName: 'namzu-egress-abc',
		upstreamNetwork: 'bridge',
		internalNetwork: CONTAINER_NETWORK,
		...overrides,
	}
}

describe('renderEgressProxyRunArgs', () => {
	it('pins the whole argv, so a leg of the topology cannot go missing quietly', () => {
		expect(renderEgressProxyRunArgs(proxyArgvInput())).toEqual([
			'run',
			'--detach',
			'--rm',
			'--name',
			'namzu-egress-abc',
			'--hostname',
			'namzu-egress',
			'--network',
			'bridge',
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--ipc',
			'private',
			'--read-only',
			'--tmpfs',
			'/tmp:nosuid,nodev,exec,mode=1777',
			'--env',
			'NAMZU_EGRESS_PROXY_CONFIG',
			'namzu-egress-proxy:latest',
		])
	})

	it('names the configuration variable without carrying its value', () => {
		// `docker run --env NAME` takes the value from the environment of the
		// `docker` CLI process, which is where the caller puts it. The value is
		// the whole policy, credential values included, and an argv is
		// world-readable on Linux (`/proc/<pid>/cmdline`) where a process
		// environment is readable only by its owner — so `NAME=VALUE` in this
		// argv published brokered credentials to every local user on the docker
		// host for as long as the client ran. Asserted on the token AFTER
		// `--env` rather than on the absence of a substring, so a future edit
		// that reintroduced the value would have to change this pin.
		const rendered = renderEgressProxyRunArgs(proxyArgvInput())
		expect(rendered[rendered.indexOf('--env') + 1]).toBe('NAMZU_EGRESS_PROXY_CONFIG')
		expect(rendered.join(' ')).not.toContain('api.example.com')
	})

	it('refuses an upstream network that would give the proxy no route out', () => {
		// Both are the same failure by different spelling, and both come up as a
		// proxy that cannot reach the internet — a boundary in front of nothing,
		// with the only way the sandbox's traffic reaches the internet pointing
		// at it. Refused here because this is the last function both values pass
		// through before the argv.
		expect(() => renderEgressProxyRunArgs(proxyArgvInput({ upstreamNetwork: 'none' }))).toThrow(
			/no interface and no route/,
		)
		expect(() =>
			renderEgressProxyRunArgs(proxyArgvInput({ upstreamNetwork: CONTAINER_NETWORK })),
		).toThrow(/the same network the sandbox is on/)
	})

	it('gives the proxy its route out first, because the internal leg has none', () => {
		// The order is the topology. A container created on the internal network
		// comes up with no default route and never acquires one, so the leg that
		// reaches the internet has to be the one `docker run` is given; the
		// internal leg is `docker network connect`ed afterwards.
		const rendered = renderEgressProxyRunArgs(
			proxyArgvInput({ upstreamNetwork: 'namzu-egress-upstream' }),
		)
		expect(rendered[rendered.indexOf('--network') + 1]).toBe('namzu-egress-upstream')
		expect(rendered).not.toContain(CONTAINER_NETWORK)
	})

	it('applies the sandbox hardening baseline to the proxy container', () => {
		// This container stands between untrusted code and the internet, so it is
		// the last one in the deployment that should be holding a capability. The
		// flags come from the same constants the sandbox's do, which is why this
		// asserts the shared baseline rather than a second copy of it.
		const rendered = renderEgressProxyRunArgs(proxyArgvInput())
		for (const flag of ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only']) {
			expect(rendered).toContain(flag)
		}
		expect(rendered[rendered.indexOf('--ipc') + 1]).toBe('private')
	})

	it('keeps the image last, so nothing after it is read as a flag', () => {
		const rendered = renderEgressProxyRunArgs(proxyArgvInput())
		expect(rendered[rendered.length - 1]).toBe('namzu-egress-proxy:latest')
	})

	it('refuses to render without an image rather than starting a nameless container', () => {
		expect(() =>
			renderEgressProxyRunArgs(
				proxyArgvInput({ config: backendConfig({ egressProxyImage: undefined }) }),
			),
		).toThrow(/without config.egressProxyImage/)
	})
})

describe('renderEgressProxyAttachArgs — the second leg', () => {
	it('pins the alias, the network and the container', () => {
		// Three values, each load-bearing: the alias is the name the sandbox's
		// HTTP_PROXY resolves, the network is the one the sandbox is on, and the
		// container is the one just started. Getting any of them wrong produces a
		// sandbox whose proxy URL resolves to nothing.
		expect(renderEgressProxyAttachArgs(proxyArgvInput())).toEqual([
			'network',
			'connect',
			'--alias',
			'namzu-egress',
			CONTAINER_NETWORK,
			'namzu-egress-abc',
		])
	})

	it('attaches to the internal network the sandbox is on, and no other', () => {
		expect(renderEgressProxyAttachArgs(proxyArgvInput())[4]).toBe(CONTAINER_NETWORK)
	})
})

/**
 * The whole thing, driven through a fake `docker` binary.
 *
 * `readiness-deadline.test.ts` established this shape: a shell script stands in
 * for the CLI, records every argv it is handed, and answers the four
 * subcommands this backend reads back from. It is the only way to reach
 * `create()` without a daemon, and it proves the part a daemon's presence would
 * not change — which containers this backend asks for, in what order, and
 * whether it removes them.
 */
describe('spawnDockerSandbox — the proxy as a sibling container', () => {
	const realFetch = globalThis.fetch
	let workDir: string
	let dockerShim: string
	let dockerLog: string
	let dockerEnvLog: string
	let marker: string
	let containers: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-egress-'))
		dockerShim = join(workDir, 'docker-shim')
		dockerLog = join(workDir, 'docker.log')
		dockerEnvLog = join(workDir, 'docker-env.log')
		marker = join(workDir, 'marker.log')
		containers = join(workDir, 'containers')
		mkdirSync(containers, { recursive: true })
		writeFileSync(dockerLog, '')
		writeFileSync(dockerEnvLog, '')
		writeFileSync(marker, '')
		process.env.NAMZU_TEST_DOCKER_LOG = dockerLog
		process.env.NAMZU_TEST_DOCKER_ENV_LOG = dockerEnvLog
		process.env.NAMZU_TEST_MARKER = marker
		process.env.NAMZU_TEST_CONTAINER_DIR = containers
		process.env.NAMZU_TEST_NETWORK_INTERNAL = 'true'
		// `= undefined` stores the string "undefined", which is what this file
		// already does and what biome's `noDelete` asks for. It is safe for
		// these because every one of them is compared against a literal the
		// shim was given, never tested for emptiness.
		process.env.NAMZU_TEST_HOLD = undefined
		process.env.NAMZU_TEST_RUN_COUNT = join(workDir, 'run-count')
		process.env.NAMZU_TEST_FAIL_RUN = undefined
		process.env.NAMZU_TEST_FAIL_CONNECT = undefined
		writeFileSync(
			dockerShim,
			[
				'#!/bin/sh',
				// One invocation per line, arguments separated by US (0x1f) so
				// an argument containing a space survives the round trip.
				'for a in "$@"; do printf "%s\\037" "$a"; done >> "${NAMZU_TEST_DOCKER_LOG:?}"',
				'printf "\\n" >> "${NAMZU_TEST_DOCKER_LOG:?}"',
				// The value this process was handed, in its environment rather
				// than in its argv — logged separately so `dockerCalls()` stays
				// pure argv.
				'if [ -n "${NAMZU_EGRESS_PROXY_CONFIG:-}" ]; then printf "%s\\n" "$NAMZU_EGRESS_PROXY_CONFIG" >> "${NAMZU_TEST_DOCKER_ENV_LOG:?}"; fi',
				// A hold, so a caller can be aborted at a chosen point in the
				// sequence rather than whenever the machine happens to be slow.
				'hold() { if [ "${NAMZU_TEST_HOLD:-}" = "$1" ]; then printf "%s\\n" "$1" >> "${NAMZU_TEST_MARKER:?}"; sleep 1; fi; }',
				// The container the daemon committed, one file per name under
				// the state directory; `docker rm -f` deletes it. It is what
				// lets a test ask whether a container is STILL RUNNING rather
				// than whether an `rm` was typed, and the two differ exactly
				// when the removal is issued before the container exists —
				// which is the race the policy-swap probes exist for. The
				// commit lands after the hold, because that is the daemon's own
				// business: a client that is killed, times out or never hears
				// back does not stop it, which is why this backend reconciles
				// by name.
				'commit() { if [ -n "$1" ]; then : > "${NAMZU_TEST_CONTAINER_DIR:?}/$1"; fi; }',
				// A counted failure, so a test can fail the Nth start rather
				// than the first one the shim happens to see.
				'case "$1" in',
				'  network) if [ "$2" = "inspect" ]; then printf "%s\\n" "${NAMZU_TEST_NETWORK_INTERNAL:?}"; fi; if [ "$2" = "connect" ]; then hold connect; if [ "${NAMZU_TEST_FAIL_CONNECT:-}" = "1" ]; then exit 5; fi; fi ;;',
				'  run)',
				'    hold run',
				'    count=$(cat "${NAMZU_TEST_RUN_COUNT:?}" 2>/dev/null || echo 0)',
				'    count=$((count + 1))',
				'    printf "%s" "$count" > "${NAMZU_TEST_RUN_COUNT:?}"',
				'    name=""',
				'    previous=""',
				'    for a in "$@"; do if [ "$previous" = "--name" ]; then name="$a"; fi; previous="$a"; done',
				'    commit "$name"',
				'    if [ "${NAMZU_TEST_FAIL_RUN:-}" = "$count" ]; then exit 5; fi',
				'    printf "container-id\\n" ;;',
				'  inspect) hold inspect; printf "true\\n" ;;',
				'  rm) if [ "$2" = "-f" ]; then rm -f "${NAMZU_TEST_CONTAINER_DIR:?}/$3"; fi ;;',
				'  *) exit 2 ;;',
				'esac',
			].join('\n'),
			{ mode: 0o755 },
		)
		// The worker's own readiness probe, answered the way a healthy worker
		// answers it — protocol version included, because a `/healthz` that
		// omits it is refused as a version mismatch rather than read as ready.
		globalThis.fetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({ ok: true, protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}) as typeof fetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
		globalThis.fetch = realFetch
		process.env.NAMZU_TEST_DOCKER_LOG = undefined
		process.env.NAMZU_TEST_NETWORK_INTERNAL = undefined
		process.env.NAMZU_TEST_DOCKER_ENV_LOG = undefined
		process.env.NAMZU_TEST_MARKER = undefined
		process.env.NAMZU_TEST_CONTAINER_DIR = undefined
		process.env.NAMZU_TEST_HOLD = undefined
		process.env.NAMZU_TEST_RUN_COUNT = undefined
		process.env.NAMZU_TEST_FAIL_RUN = undefined
		process.env.NAMZU_TEST_FAIL_CONNECT = undefined
		rmSync(workDir, { recursive: true, force: true })
	})

	/** Every invocation the shim saw, as argv arrays. */
	function dockerCalls(): string[][] {
		return readFileSync(dockerLog, 'utf8')
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => line.split('\u001f').slice(0, -1))
	}

	function callsMatching(predicate: (argv: string[]) => boolean): string[][] {
		return dockerCalls().filter(predicate)
	}

	/** The container this run's proxy was named, or fails the calling test. */
	function proxyContainerName(): string {
		const named = callsMatching(
			(argv) =>
				argv[0] === 'run' && (argv[argv.indexOf('--name') + 1] ?? '').startsWith('namzu-egress-'),
		)
		expect(named).toHaveLength(1)
		return (named[0] as string[])[(named[0] as string[]).indexOf('--name') + 1] as string
	}

	function proxyRemoveCalls(): string[][] {
		return callsMatching(
			(argv) => argv[0] === 'rm' && argv[1] === '-f' && (argv[2] ?? '').startsWith('namzu-egress-'),
		)
	}

	/**
	 * What the daemon still has running, read off its own state.
	 *
	 * The distinction this exists for: a `docker rm -f` issued BEFORE the
	 * container it names was committed removes nothing, and an argv log cannot
	 * tell that from a removal that worked. A real daemon commits the container
	 * whether or not the client that asked for it is still listening, so
	 * "which `rm` was typed" and "what is still running" are different
	 * questions and only the second one is the invariant.
	 */
	function containersRunning(): string[] {
		return readdirSync(containers).sort()
	}

	/** Poll, because the removal runs on its own deadline rather than inside
	 * the promise `create()` rejected on. */
	async function waitForProxyRemove(): Promise<void> {
		const deadline = Date.now() + 10_000
		while (Date.now() < deadline) {
			if (proxyRemoveCalls().length > 0) return
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		throw new Error('no `docker rm -f` was issued for the proxy container')
	}

	async function waitForMarker(token: string): Promise<void> {
		const deadline = Date.now() + 10_000
		while (Date.now() < deadline) {
			if (readFileSync(marker, 'utf8').includes(token)) return
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		throw new Error(`the docker shim never reached ${token}`)
	}

	/**
	 * Abort a `create()` at a named point in the proxy's start sequence.
	 *
	 * `docker run --detach` against an image being pulled for the first time is
	 * a slow call, which is where this matters in production: the SDK's sandbox
	 * acquisition aborts `provider.create()` on a timeout
	 * (`packages/sdk/src/runtime/query/sandbox-lifecycle.ts`), and that window
	 * includes the proxy image's first pull.
	 */
	async function abortDuring(hold: string): Promise<void> {
		process.env.NAMZU_TEST_HOLD = hold
		const controller = new AbortController()
		const creating = backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
			signal: controller.signal,
		})
		await waitForMarker(hold)
		const reason = new Error(`aborted during ${hold}`)
		controller.abort(reason)
		// The caller's own reason, by identity — not a wrapper describing an
		// image that failed to start. An acquisition timeout that arrives
		// dressed as a configuration problem is the diagnosis shape the
		// backend refuses everywhere else, and this is the one catch on this
		// path where the distinction could quietly be lost.
		await expect(creating).rejects.toBe(reason)
		await waitForProxyRemove()
	}

	function backend(overrides: Partial<DockerBackendInternalConfig> = {}) {
		return buildDockerBackend({
			...backendConfig({ network: CONTAINER_NETWORK, hostReachability: 'container-network' }),
			dockerBinary: dockerShim,
			readyTimeoutMs: 200,
			readyPollIntervalMs: 5,
			...overrides,
		})
	}

	it('starts the proxy container, joins it to the internal network, then starts the sandbox', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		try {
			const calls = dockerCalls()
			const runIndexes = calls
				.map((argv, index) => (argv[0] === 'run' ? index : -1))
				.filter((index) => index >= 0)
			expect(runIndexes).toHaveLength(2)
			const [proxyIndex, sandboxIndex] = runIndexes as [number, number]

			// The proxy first: its alias has to be in the network's DNS before
			// the sandbox's proxy environment tries to resolve it.
			const proxyRun = calls[proxyIndex] as string[]
			expect(proxyRun[proxyRun.indexOf('--name') + 1]).toMatch(/^namzu-egress-/)
			expect(proxyRun[proxyRun.indexOf('--network') + 1]).toBe('bridge')
			expect(proxyRun).not.toContain(CONTAINER_NETWORK)
			expect(proxyRun[proxyRun.length - 1]).toBe('namzu-egress-proxy:latest')

			// Then the second leg, by alias, on the network the sandbox is on.
			const connectIndex = calls.findIndex((argv) => argv[0] === 'network' && argv[1] === 'connect')
			expect(connectIndex).toBeGreaterThan(-1)
			expect(calls[connectIndex]).toEqual([
				'network',
				'connect',
				'--alias',
				'namzu-egress',
				CONTAINER_NETWORK,
				proxyRun[proxyRun.indexOf('--name') + 1],
			])

			// Then the sandbox, on the internal network only.
			const sandboxRun = calls[sandboxIndex] as string[]
			expect(sandboxRun[sandboxRun.indexOf('--network') + 1]).toBe(CONTAINER_NETWORK)
			expect(sandboxRun[sandboxRun.indexOf('--name') + 1]).toBe(`namzu-sandbox-${sandbox.id}`)
			expect(sandboxRun.join(' ')).not.toContain('host-gateway')
			expect(sandboxRun).not.toContain('--add-host')
			expect(sandboxRun).toContain('HTTP_PROXY=http://namzu-egress:2025')
			expect(sandboxRun).toContain('http_proxy=http://namzu-egress:2025')
			expect(sandboxRun).toContain('HTTPS_PROXY=http://namzu-egress:2025')
			expect(sandboxRun).toContain('https_proxy=http://namzu-egress:2025')

			// And in that order, which is the part a daemon would not correct:
			// the proxy is running before the alias is set, and the alias is set
			// before the sandbox starts and resolves it.
			expect(proxyIndex).toBeLessThan(connectIndex)
			expect(connectIndex).toBeLessThan(sandboxIndex)
		} finally {
			await sandbox.destroy()
		}
	})

	it('hands the proxy the allowlist and the credentials, and the sandbox neither', async () => {
		const credential = { host: 'api.example.com', header: 'authorization', value: 'real-token' }
		const sandbox = await backend({ brokeredCredentials: [credential] }).create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		try {
			// The value the `docker` CLI process was handed, read back out of
			// its environment — which is where `--env NAMZU_EGRESS_PROXY_CONFIG`
			// (the name, with no `=`) takes it from.
			const handed = readFileSync(dockerEnvLog, 'utf8').trim().split('\n')
			expect(handed).toHaveLength(1)
			const parsed = JSON.parse(handed[0] as string) as {
				allowedHosts: string[]
				credentials: unknown[]
				port: number
			}
			expect(parsed.allowedHosts).toEqual(['api.example.com'])
			expect(parsed.credentials).toEqual([credential])
			expect(parsed.port).toBe(2025)

			// And the point of the whole arrangement: the token is in the
			// proxy's configuration and in NEITHER container's argv — not the
			// proxy's, where it would be world-readable in `/proc/<pid>/cmdline`
			// on the docker host, and not the sandbox's, which is the line the
			// threat model draws.
			const runs = callsMatching((argv) => argv[0] === 'run')
			expect(runs).toHaveLength(2)
			for (const argv of runs) {
				expect(argv.join(' ')).not.toContain('real-token')
				expect(argv.join(' ')).not.toContain('api.example.com')
			}
		} finally {
			await sandbox.destroy()
		}
	})

	it('removes both containers on destroy, the proxy included', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		await sandbox.destroy()

		const removed = callsMatching((argv) => argv[0] === 'rm' && argv[1] === '-f').map(
			(argv) => argv[2],
		)
		expect(removed).toContain(`namzu-sandbox-${sandbox.id}`)
		expect(removed).toContain(proxyContainerName())
		expect(removed).toHaveLength(2)
	})

	/**
	 * An aborted `create()` must not leave the proxy behind.
	 *
	 * The first cut of this change did, on all three of these. The block that
	 * starts the proxy sat outside the `try` that owns `cleanupOnFailure`, so an
	 * abort at its `throwIfAborted()` rethrew past every removal; the `docker
	 * run` catch rethrew without removing at all; and the one removal that WAS
	 * attempted ran on the caller's already-aborted signal, whose abort listener
	 * kills the child before it reaches the daemon. The result was a container
	 * holding real credentials with a live route to the internet and nothing
	 * that would ever remove it — `destroy()` being unreachable, because
	 * `create()` never returned a handle. The pre-change code got this right
	 * with a local `close()` an aborted signal cannot defeat.
	 *
	 * Each probe holds the fake daemon at one point of the sequence and aborts
	 * there, so the window is chosen rather than raced.
	 */
	it('removes the proxy when the create is aborted during the proxy container start', async () => {
		await abortDuring('run')
	})

	it('removes the proxy when the create is aborted while it joins the internal network', async () => {
		await abortDuring('connect')
	})

	it('removes the proxy when the create is aborted after the proxy is up', async () => {
		// The microtask boundary between `startEgressProxyContainer` returning
		// and the sandbox's own `docker run` beginning, which is the check the
		// block used to rethrow from.
		await abortDuring('inspect')
	})

	it('removes the proxy when the sandbox it was started for never comes up', async () => {
		// The proxy starts first, so a create that fails after it would leave a
		// container holding real credentials with a route to the internet and no
		// sandbox it belongs to — and `destroy()` is unreachable, because
		// `create()` never returned a handle. The worker never answering is the
		// cheapest way to reach that path.
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as typeof fetch
		await expect(
			backend().create({ workingDirectory: workDir, egress: STATIC_ALLOWLIST }),
		).rejects.toThrow(/did not become ready/)

		const removed = callsMatching((argv) => argv[0] === 'rm' && argv[1] === '-f').map(
			(argv) => argv[2],
		)
		expect(removed.some((name) => name?.startsWith('namzu-egress-'))).toBe(true)
		expect(removed.some((name) => name?.startsWith('namzu-sandbox-'))).toBe(true)
	})

	it('replaces the proxy container when the policy changes on a live sandbox', async () => {
		// The policy is in the container's environment, which cannot be
		// rewritten from outside, so a live change is a new container: the old
		// one is removed and a new one started with the new allowlist. The
		// window between them fails closed, which is the property worth pinning
		// — the opposite ordering is what would leave a policy briefly wider
		// than the caller asked for.
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		try {
			await sandbox.setNetworkPolicy?.({ allowedHosts: ['other.example.com'] })

			const runs = callsMatching((argv) => argv[0] === 'run')
			expect(runs).toHaveLength(3)

			// The replacement's policy, read from the environment the `docker`
			// CLI process was handed: one entry per proxy start, so the last is
			// the one the live sandbox is now running under.
			const handed = readFileSync(dockerEnvLog, 'utf8').trim().split('\n')
			expect(handed).toHaveLength(2)
			const replacement = JSON.parse(handed[1] as string) as { allowedHosts: string[] }
			expect(replacement.allowedHosts).toEqual(['other.example.com'])

			const connects = callsMatching((argv) => argv[0] === 'network' && argv[1] === 'connect')
			expect(connects).toHaveLength(2)
			expect(connects[1]?.[4]).toBe(CONTAINER_NETWORK)

			const removedBeforeRestart = callsMatching((argv) => argv[0] === 'rm' && argv[1] === '-f')
			expect(removedBeforeRestart).toHaveLength(1)
		} finally {
			await sandbox.destroy()
		}
	})

	/**
	 * The two catches inside `startEgressProxyContainer` are only load-bearing
	 * where `cleanupOnFailure` is unreachable, which is exactly here: a live
	 * policy swap happens on a sandbox that already exists, so nothing else is
	 * watching for a proxy container that failed to come up. Both probes count
	 * `rm -f` calls for the proxy's name — one from the replacement's own
	 * pre-start removal, and the second the rollback this asserts — and both
	 * assert what the daemon has left running afterwards.
	 *
	 * The first is mutation-distinguishable: take the `docker run` catch's
	 * removal away and the replacement stays up. The second is NOT, and it is
	 * kept as a regression pin rather than claimed as a probe — recorded in
	 * `docs/sdk/sandbox-egress.md` and in this commit's message. The reason is
	 * the shape of the swap: `restartEgressProxyContainer` hands
	 * `startEgressProxyContainer` no signal, so the pre-change spelling for
	 * that catch (`runOnceQuiet` on `signal`) behaved identically here — there
	 * was no aborted signal for it to be defeated by. What that spelling loses
	 * on the paths where a signal exists is asserted where it exists, by the
	 * three abort probes and `cleanupOnFailure`'s own.
	 */
	it('removes the replacement proxy when its container fails to start', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		try {
			// The third `run` of the sequence: proxy, sandbox, replacement.
			process.env.NAMZU_TEST_FAIL_RUN = '3'
			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: ['other.example.com'] }),
			).rejects.toThrow(/Could not start the egress proxy container/)
			expect(proxyRemoveCalls()).toHaveLength(2)
			expect(containersRunning()).toEqual([`namzu-sandbox-${sandbox.id}`])
		} finally {
			await sandbox.destroy()
		}
	})

	it('removes the replacement proxy when it cannot join the internal network', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		try {
			// The container starts and then cannot be attached, which is the
			// case the second catch owns: a proxy that exists, is reachable by
			// nothing, and would otherwise be left holding credentials.
			process.env.NAMZU_TEST_FAIL_CONNECT = '1'
			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: ['other.example.com'] }),
			).rejects.toThrow()
			expect(proxyRemoveCalls()).toHaveLength(2)
			expect(containersRunning()).toEqual([`namzu-sandbox-${sandbox.id}`])
		} finally {
			await sandbox.destroy()
		}
	})

	/**
	 * A teardown that lands while the REPLACEMENT is starting must not leave the
	 * replacement behind.
	 *
	 * `setNetworkPolicy` checks its lifecycle before its first `await`, and a
	 * teardown — `destroy()`, or the `retire()` an in-flight `exec` triggers on
	 * a worker whose cancellation outcome is unknown — sets `lifecycle` and
	 * removes both containers while the swap is suspended inside
	 * `restartEgressProxyContainer`. The swap then goes on to start a NEW
	 * `namzu-egress-<id>` container after those removals have run, and nothing
	 * removes that one: `egressProxyContainer` is only removed from
	 * `teardownSandbox` and `cleanupOnFailure`, and both have already run.
	 *
	 * The holder is inside the replacement's `docker run`, so the container is
	 * committed AFTER the teardown's `rm -f` was issued — that ordering is the
	 * whole race, and it is why the assertion is on what the daemon has left
	 * running rather than on which `rm` was typed. Counting removals cannot see
	 * this: the removal was issued, before the container existed.
	 */
	it('leaves no proxy container when the sandbox is torn down while the replacement starts', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: STATIC_ALLOWLIST,
		})
		// Set AFTER the create, so the `docker run` this catches is the
		// replacement's — the third of the sequence.
		process.env.NAMZU_TEST_HOLD = 'run'
		const swapping = sandbox.setNetworkPolicy?.({ allowedHosts: ['other.example.com'] })
		await waitForMarker('run')

		await sandbox.destroy()
		// The swap neither reports a policy change on a sandbox that is gone
		// nor leaves its replacement running.
		await expect(swapping).rejects.toThrow(/no new worker operation can be admitted/)
		expect(containersRunning()).toEqual([])
	})

	it('refuses a live policy change on a sandbox that has no proxy to change', async () => {
		// Unchanged behaviour, pinned here because the refusal's condition moved
		// from an object to a container name: a sandbox created under `deny-all`
		// has no boundary to narrow, and accepting the policy would leave the
		// caller believing it had been confined.
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: { kind: 'deny-all' },
		})
		try {
			await expect(sandbox.setNetworkPolicy?.({ allowedHosts: ['x.example.com'] })).rejects.toThrow(
				/cannot change its network policy/,
			)
		} finally {
			await sandbox.destroy()
		}
	})

	it('refuses to start anything when the network is not internal', async () => {
		// The refusal is the change's whole point: an allowlist on a network the
		// sandbox can route around is a policy that would be reported as
		// enforced and would not be. It has to arrive as a wiring mistake, before
		// a container exists, rather than as a sandbox whose traffic is silently
		// unproxied.
		process.env.NAMZU_TEST_NETWORK_INTERNAL = 'false'
		await expect(
			backend().create({ workingDirectory: workDir, egress: STATIC_ALLOWLIST }),
		).rejects.toThrow(/is not internal/)
		expect(callsMatching((argv) => argv[0] === 'run')).toHaveLength(0)
	})

	it('refuses an allowlist with no proxy image, naming the image to build', async () => {
		// Without an image there is no boundary to run, and the honest answer is
		// a refusal rather than a sandbox under a policy nothing enforces.
		const provider = backend({ egressProxyImage: undefined })
		await expect(
			provider.create({ workingDirectory: workDir, egress: STATIC_ALLOWLIST }),
		).rejects.toThrow(/egressProxyImage/)
		expect(callsMatching((argv) => argv[0] === 'run')).toHaveLength(0)
	})

	it('runs no proxy at all for a policy that does not need one', async () => {
		// `deny-all` is enforced by the network rather than by a proxy, so
		// nothing here should start a container that is not asked for — and the
		// sandbox should carry no proxy environment.
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: { kind: 'deny-all' },
		})
		try {
			expect(callsMatching((argv) => argv[0] === 'run')).toHaveLength(1)
			const sandboxRun = callsMatching((argv) => argv[0] === 'run')[0] as string[]
			expect(sandboxRun.join(' ')).not.toContain('HTTP_PROXY')
			expect(sandboxRun).not.toContain('--add-host')
		} finally {
			await sandbox.destroy()
		}
	})
})
