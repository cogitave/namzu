import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REMOTE_EXECUTION_PROTOCOL_VERSION } from '../../remote-execution-controller.js'
import { buildDockerBackend, resolveLayout } from '../index.js'
import type { DockerBackendInternalConfig } from '../index.js'
import {
	assertNetworkCarriesThePolicy,
	egressProxyContainerConfig,
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
 * internal network alone, so its only reachable destination is the proxy — a
 * route it cannot put back, because `--cap-drop=ALL` took `NET_ADMIN` away.
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
		configJson: JSON.stringify(egressProxyContainerConfig({}, ['api.example.com'], 2025)),
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
			`NAMZU_EGRESS_PROXY_CONFIG=${JSON.stringify(
				egressProxyContainerConfig({}, ['api.example.com'], 2025),
			)}`,
			'namzu-egress-proxy:latest',
		])
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

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-egress-'))
		dockerShim = join(workDir, 'docker-shim')
		dockerLog = join(workDir, 'docker.log')
		writeFileSync(dockerLog, '')
		process.env.NAMZU_TEST_DOCKER_LOG = dockerLog
		process.env.NAMZU_TEST_NETWORK_INTERNAL = 'true'
		writeFileSync(
			dockerShim,
			[
				'#!/bin/sh',
				// One invocation per line, arguments separated by US (0x1f) so
				// an argument containing a space survives the round trip.
				'for a in "$@"; do printf "%s\\037" "$a"; done >> "${NAMZU_TEST_DOCKER_LOG:?}"',
				'printf "\\n" >> "${NAMZU_TEST_DOCKER_LOG:?}"',
				'case "$1" in',
				'  network) if [ "$2" = "inspect" ]; then printf "%s\\n" "${NAMZU_TEST_NETWORK_INTERNAL:?}"; fi ;;',
				'  run) printf "container-id\\n" ;;',
				'  inspect) printf "true\\n" ;;',
				'  rm) : ;;',
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
		rmSync(workDir, { recursive: true, force: true })
	})

	/** Every invocation the shim saw, as argv arrays. */
	function dockerCalls(): string[][] {
		return readFileSync(dockerLog, 'utf8')
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => line.split('').slice(0, -1))
	}

	function callsMatching(predicate: (argv: string[]) => boolean): string[][] {
		return dockerCalls().filter(predicate)
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
			const proxyRun = callsMatching((argv) => argv[0] === 'run')[0] as string[]
			const configArg = proxyRun[proxyRun.indexOf('--env') + 1] as string
			expect(configArg.startsWith('NAMZU_EGRESS_PROXY_CONFIG=')).toBe(true)
			const parsed = JSON.parse(configArg.slice('NAMZU_EGRESS_PROXY_CONFIG='.length)) as {
				allowedHosts: string[]
				credentials: unknown[]
				port: number
			}
			expect(parsed.allowedHosts).toEqual(['api.example.com'])
			expect(parsed.credentials).toEqual([credential])
			expect(parsed.port).toBe(2025)

			// And the point of the whole arrangement: the token is in the
			// proxy's environment and NOT in the sandbox's.
			const sandboxRun = callsMatching((argv) => argv[0] === 'run')[1] as string[]
			expect(sandboxRun.join(' ')).not.toContain('real-token')
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
		expect(removed.some((name) => name?.startsWith('namzu-egress-'))).toBe(true)
		expect(removed).toHaveLength(2)
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
			const replacement = runs[2] as string[]
			const configArg = replacement[replacement.indexOf('--env') + 1] as string
			expect(configArg).toContain('other.example.com')
			expect(configArg).not.toContain('api.example.com')

			const connects = callsMatching((argv) => argv[0] === 'network' && argv[1] === 'connect')
			expect(connects).toHaveLength(2)
			expect(connects[1]?.[4]).toBe(CONTAINER_NETWORK)

			const removedBeforeRestart = callsMatching((argv) => argv[0] === 'rm' && argv[1] === '-f')
			expect(removedBeforeRestart).toHaveLength(1)
		} finally {
			await sandbox.destroy()
		}
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
