import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineEgressProfile } from '../../../egress/profile.js'
import { REMOTE_EXECUTION_PROTOCOL_VERSION } from '../../remote-execution-controller.js'
import { buildDockerBackend, resolveLayout } from '../index.js'
import type { DockerBackendInternalConfig } from '../index.js'

/**
 * `setNetworkPolicy` on the docker backend, against a daemon that keeps state.
 *
 * `egress-topology.test.ts` drives the backend through a shim that scripts its
 * replies by call index, which cannot express the defect this file pins: two
 * overlapping policy swaps on one sandbox work against ONE container name, and
 * what goes wrong depends on what the daemon does when a name is already taken
 * or already gone. So this shim is stateful the way a daemon is:
 *
 *  - container names are unique, and a second `run` under a live name fails
 *    with a conflict and commits nothing;
 *  - `network connect`, `inspect` and `rm -f` address a container by name,
 *    and the first two fail when the name is not live;
 *  - each container records the proxy configuration it was started with, so a
 *    test can ask which policy is in force, not only which calls were typed;
 *  - the Nth `run` can be held for a second before it commits, which is how a
 *    test places a second call inside the first one's swap on purpose.
 *
 * Against the unqueued swap, the overlap probe below fails: the first call's
 * `run` meets the second call's container, its failure path removes that
 * container by name after the second call has resolved, and the sandbox is
 * left with no proxy while its caller was told the second policy was in force.
 */

const CONTAINER_NETWORK = 'namzu-tasks'
const INITIAL = { kind: 'static', allowedHosts: ['api.example.com'] } as const

describe('docker setNetworkPolicy — one swap at a time, each verifying its own policy', () => {
	const realFetch = globalThis.fetch
	let workDir: string
	let dockerShim: string
	let dockerLog: string
	let state: string
	let marker: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-policy-queue-'))
		dockerShim = join(workDir, 'docker-shim')
		dockerLog = join(workDir, 'docker.log')
		marker = join(workDir, 'marker.log')
		state = join(workDir, 'containers')
		mkdirSync(state, { recursive: true })
		writeFileSync(dockerLog, '')
		writeFileSync(marker, '')
		process.env.NAMZU_Q_LOG = dockerLog
		process.env.NAMZU_Q_STATE = state
		process.env.NAMZU_Q_MARKER = marker
		process.env.NAMZU_Q_RUN_COUNT = join(workDir, 'run-count')
		process.env.NAMZU_Q_SLOW_RUN = undefined
		process.env.NAMZU_Q_FAIL_RUN = undefined
		writeFileSync(
			dockerShim,
			[
				'#!/bin/sh',
				'for a in "$@"; do printf "%s\\037" "$a"; done >> "${NAMZU_Q_LOG:?}"',
				'printf "\\n" >> "${NAMZU_Q_LOG:?}"',
				'last=""',
				'for a in "$@"; do last="$a"; done',
				'case "$1" in',
				'  network)',
				'    if [ "$2" = "inspect" ]; then printf "true\\n"; exit 0; fi',
				'    if [ "$2" = "connect" ]; then [ -f "${NAMZU_Q_STATE:?}/$last" ] || { echo "No such container: $last" >&2; exit 1; }; fi ;;',
				'  run)',
				'    count=$(cat "${NAMZU_Q_RUN_COUNT:?}" 2>/dev/null || echo 0)',
				'    count=$((count + 1))',
				'    printf "%s" "$count" > "${NAMZU_Q_RUN_COUNT:?}"',
				'    name=""',
				'    previous=""',
				'    for a in "$@"; do if [ "$previous" = "--name" ]; then name="$a"; fi; previous="$a"; done',
				'    if [ "${NAMZU_Q_SLOW_RUN:-}" = "$count" ]; then printf "slow-run\\n" >> "${NAMZU_Q_MARKER:?}"; sleep 1; fi',
				'    if [ -f "${NAMZU_Q_STATE:?}/$name" ]; then echo "Conflict. The container name \\"/$name\\" is already in use." >&2; exit 125; fi',
				'    printf "%s" "${NAMZU_EGRESS_PROXY_CONFIG:-sandbox}" > "${NAMZU_Q_STATE:?}/$name"',
				'    if [ "${NAMZU_Q_FAIL_RUN:-}" = "$count" ]; then exit 5; fi',
				'    printf "container-id\\n" ;;',
				'  inspect) [ -f "${NAMZU_Q_STATE:?}/$last" ] || { echo "No such object: $last" >&2; exit 1; }; printf "true\\n" ;;',
				'  rm) rm -f "${NAMZU_Q_STATE:?}/$3" ;;',
				'  *) exit 2 ;;',
				'esac',
			].join('\n'),
			{ mode: 0o755 },
		)
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
		process.env.NAMZU_Q_LOG = undefined
		process.env.NAMZU_Q_STATE = undefined
		process.env.NAMZU_Q_MARKER = undefined
		process.env.NAMZU_Q_RUN_COUNT = undefined
		process.env.NAMZU_Q_SLOW_RUN = undefined
		process.env.NAMZU_Q_FAIL_RUN = undefined
		rmSync(workDir, { recursive: true, force: true })
	})

	function backend(overrides: Partial<DockerBackendInternalConfig> = {}) {
		return buildDockerBackend({
			image: 'namzu-sandbox:latest',
			egressProxyImage: 'namzu-egress-proxy:latest',
			layout: resolveLayout({ outputs: { source: { type: 'hostDir', hostPath: '/h/out' } } }),
			network: CONTAINER_NETWORK,
			hostReachability: 'container-network',
			dockerBinary: dockerShim,
			readyTimeoutMs: 200,
			readyPollIntervalMs: 5,
			...overrides,
		})
	}

	function dockerCalls(): string[][] {
		return readFileSync(dockerLog, 'utf8')
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => line.split('\u001f').slice(0, -1))
	}

	function countCalls(verb: string): number {
		return dockerCalls().filter((argv) => argv[0] === verb).length
	}

	/** The allowlist of every live proxy container, read off the daemon's state. */
	function proxiesInForce(): string[][] {
		return readdirSync(state)
			.filter((name) => name.startsWith('namzu-egress-'))
			.map(
				(name) =>
					(JSON.parse(readFileSync(join(state, name), 'utf8')) as { allowedHosts: string[] })
						.allowedHosts,
			)
	}

	async function waitForMarker(token: string): Promise<void> {
		const deadline = Date.now() + 10_000
		while (Date.now() < deadline) {
			if (readFileSync(marker, 'utf8').includes(token)) return
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		throw new Error(`the docker shim never reached ${token}`)
	}

	type Settled =
		| { readonly ok: true; readonly inForce: string[][] }
		| { readonly ok: false; readonly error: unknown }

	/**
	 * Settle a call and record what the daemon had in force at the moment it
	 * resolved: synchronously, in the continuation, before anything queued
	 * behind it has had a chance to spawn a process.
	 */
	function observe(call: Promise<void> | undefined): Promise<Settled> {
		if (call === undefined) throw new Error('the docker sandbox has no setNetworkPolicy')
		return call.then(
			() => ({ ok: true as const, inForce: proxiesInForce() }),
			(error: unknown) => ({ ok: false as const, error }),
		)
	}

	it('leaves the second policy in force after two overlapping calls, each resolving on its own', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		try {
			// The create ran the proxy (#1) and the sandbox (#2); the first swap's
			// `run` is #3, held so the second call lands inside it.
			process.env.NAMZU_Q_SLOW_RUN = '3'
			const first = observe(sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] }))
			await waitForMarker('slow-run')
			const second = observe(sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] }))

			const [a, b] = await Promise.all([first, second])
			// What the sandbox is left with, first: the unqueued swap left no
			// proxy at all here, after the second call had already resolved.
			expect(proxiesInForce()).toEqual([['b.example.com']])
			// And each call resolved while its own policy was the one in force.
			expect(b).toEqual({ ok: true, inForce: [['b.example.com']] })
			expect(a).toEqual({ ok: true, inForce: [['a.example.com']] })
		} finally {
			await sandbox.destroy()
		}
	})

	it('issues no docker call for a policy equal to the one in force', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		try {
			const runsAfterCreate = countCalls('run')
			const removesAfterCreate = countCalls('rm')
			// The create-time allowlist, repeated.
			await sandbox.setNetworkPolicy?.({ allowedHosts: ['api.example.com'] })
			expect(countCalls('run')).toBe(runsAfterCreate)
			expect(countCalls('rm')).toBe(removesAfterCreate)

			await sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })
			expect(countCalls('run')).toBe(runsAfterCreate + 1)
			const removesAfterSwap = countCalls('rm')
			await sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })
			expect(countCalls('run')).toBe(runsAfterCreate + 1)
			expect(countCalls('rm')).toBe(removesAfterSwap)
			expect(proxiesInForce()).toEqual([['b.example.com']])
		} finally {
			await sandbox.destroy()
		}
	})

	it('treats a reordered list as a different policy', async () => {
		const sandbox = await backend().create({
			workingDirectory: workDir,
			egress: { kind: 'static', allowedHosts: ['a.example.com', 'b.example.com'] },
		})
		try {
			const runsAfterCreate = countCalls('run')
			await sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com', 'a.example.com'] })
			expect(countCalls('run')).toBe(runsAfterCreate + 1)
		} finally {
			await sandbox.destroy()
		}
	})

	it('swaps again after a failed swap, even for the same policy', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		try {
			process.env.NAMZU_Q_FAIL_RUN = '3'
			await expect(sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })).rejects.toThrow(
				/Could not start the egress proxy container/,
			)
			expect(proxiesInForce()).toEqual([])

			// The failed call does not poison the queue, and the state it left is
			// unknown, so the same policy is applied rather than skipped.
			await sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })
			expect(countCalls('run')).toBe(4)
			expect(proxiesInForce()).toEqual([['b.example.com']])
		} finally {
			await sandbox.destroy()
		}
	})

	it('copies the requested list, so mutating it while queued changes nothing', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		try {
			process.env.NAMZU_Q_SLOW_RUN = '3'
			const first = sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] })
			await waitForMarker('slow-run')
			const hosts = ['b.example.com']
			const second = sandbox.setNetworkPolicy?.({ allowedHosts: hosts })
			hosts[0] = 'wider.example.com'
			await Promise.all([first, second])
			expect(proxiesInForce()).toEqual([['b.example.com']])
		} finally {
			await sandbox.destroy()
		}
	})

	it('rejects every queued call and leaves no proxy when the sandbox is destroyed', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		process.env.NAMZU_Q_SLOW_RUN = '3'
		const inFlight = observe(sandbox.setNetworkPolicy?.({ allowedHosts: ['a.example.com'] }))
		await waitForMarker('slow-run')
		const queuedB = observe(sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] }))
		const queuedC = observe(sandbox.setNetworkPolicy?.({ allowedHosts: ['c.example.com'] }))

		await sandbox.destroy()
		const settled = await Promise.all([inFlight, queuedB, queuedC])
		for (const outcome of settled) {
			expect(outcome.ok).toBe(false)
			if (!outcome.ok) {
				expect(String(outcome.error)).toMatch(/no new worker operation can be admitted/)
			}
		}
		// The in-flight swap's container was committed after the teardown's
		// removal, and is removed by the swap itself; the queued calls never
		// started one.
		expect(readdirSync(state)).toEqual([])
		expect(countCalls('run')).toBe(3)
	})

	it('under an egress profile, narrows within it and refuses a host outside it', async () => {
		const egressProfile = defineEgressProfile({
			name: 'p',
			hosts: [{ host: 'api.example.com' }, { host: '.example.org' }],
		})
		const sandbox = await backend({ egressProfile }).create({
			workingDirectory: workDir,
			egress: { kind: 'static', allowedHosts: ['api.example.com', '.example.org'] },
		})
		try {
			const runsAfterCreate = countCalls('run')
			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: ['api.example.com', 'wider.example.net'] }),
			).rejects.toMatchObject({
				name: 'SandboxEgressProfileError',
				code: 'invalid-host',
				path: 'allowedHosts[1]',
			})
			// A domain entry is refused unless a domain rule covers all of it.
			await expect(
				sandbox.setNetworkPolicy?.({ allowedHosts: ['.api.example.com'] }),
			).rejects.toMatchObject({ code: 'invalid-host', path: 'allowedHosts[0]' })
			expect(countCalls('run')).toBe(runsAfterCreate)

			await sandbox.setNetworkPolicy?.({ allowedHosts: ['docs.example.org'] })
			expect(proxiesInForce()).toEqual([['docs.example.org']])
		} finally {
			await sandbox.destroy()
		}
	})

	it('refuses a call made after destroy without queueing it', async () => {
		const sandbox = await backend().create({ workingDirectory: workDir, egress: INITIAL })
		await sandbox.destroy()
		const before = dockerCalls().length
		await expect(sandbox.setNetworkPolicy?.({ allowedHosts: ['b.example.com'] })).rejects.toThrow(
			/no new worker operation can be admitted/,
		)
		expect(dockerCalls().length).toBe(before)
	})
})
