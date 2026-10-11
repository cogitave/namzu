import { createHash } from 'node:crypto'
import type { PalDefinition } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalComputerCommandRunner } from '../engine.js'
import { createLocalVirtualComputerProvider } from '../index.js'
import * as podman from '../podman-machine.js'

// These argument lists were recorded from the provider before the wslc engine
// existed. Docker and Podman must keep producing exactly these bytes.

const pal: PalDefinition = {
	v: 1,
	kind: 'pal',
	id: 'pal-golden',
	name: 'Golden',
	purpose: '',
	workspace: '/host/control/private',
	model: null,
	paused: false,
	revision: 1,
	createdAt: '2026-10-02',
	updatedAt: '2026-10-02',
}
const owner = createHash('sha256').update(pal.id).digest('hex')
const containerId = 'a'.repeat(64)

function recorder(options: { badPorts?: boolean } = {}) {
	const calls: { binary: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
	let allocated = false
	const runner: LocalComputerCommandRunner = {
		async run(binary, args, call) {
			calls.push({ binary, args: [...args], env: call?.env })
			if (args[0] === 'context') {
				if (args[1] === 'show') return 'fixture-local'
				return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }])
			}
			const op = args.slice(2)
			if (op[0] === 'info') return JSON.stringify({ OSType: 'linux' })
			if (op[0] === 'image')
				return JSON.stringify([
					{
						Os: 'linux',
						Config: { User: '1001:1001', Labels: { 'org.namzu.local-computer.protocol': '1' } },
					},
				])
			if (op[0] === 'ps') return allocated ? containerId : ''
			if (op[0] === 'volume') {
				if (op[1] === 'create') return String(op.at(-1))
				return JSON.stringify([{ Labels: { 'org.namzu.pal.owner': owner } }])
			}
			if (op[0] === 'run') {
				allocated = true
				return containerId
			}
			if (op[0] === 'inspect')
				return options.badPorts
					? 'null'
					: JSON.stringify({
							'2024/tcp': [{ HostIp: '127.0.0.1', HostPort: '41124' }],
							'2025/tcp': [{ HostIp: '127.0.0.1', HostPort: '41125' }],
						})
			if (op[0] === 'rm') {
				allocated = false
				return containerId
			}
			if (op[0] === 'stop') return containerId
			throw new Error(`Unexpected fixture operation ${op[0]}`)
		},
	}
	return { runner, calls }
}

function stubReadiness() {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async (url: string) =>
				new Response(
					JSON.stringify(
						url.endsWith('/readyz')
							? { protocol: 1, width: 1280, height: 800, browserReady: true }
							: { protocolVersion: 2 },
					),
					{ status: 200 },
				),
		),
	)
}

/** Replace the two per-attempt values so the lists compare byte for byte. */
function normalize(args: readonly string[]): string[] {
	return args.map((arg) =>
		arg
			.replace(/^org\.namzu\.pal\.generation=\d+$/, 'org.namzu.pal.generation=<generation>')
			.replace(
				/^(label=)?org\.namzu\.pal\.allocation=[0-9a-f-]{36}$/,
				'$1org.namzu.pal.allocation=<id>',
			),
	)
}

const name = `namzu-pal-${owner.slice(0, 24)}`
const volume = `namzu-pal-data-${owner}`

function runArgs(extra: readonly string[]): string[] {
	return [
		'run',
		'--detach',
		'--pull=never',
		...extra,
		'--name',
		name,
		'--label',
		`org.namzu.pal.owner=${owner}`,
		'--label',
		'org.namzu.pal.generation=<generation>',
		'--label',
		'org.namzu.pal.allocation=<id>',
		'--user',
		'1001:1001',
		'--cap-drop=ALL',
		'--security-opt=no-new-privileges',
		'--read-only',
		'--ipc=private',
		'--network=bridge',
		'--shm-size=256m',
		'--tmpfs',
		'/tmp:rw,nosuid,nodev,size=512m,mode=1777',
		'--tmpfs',
		'/run:rw,nosuid,nodev,size=16m,mode=1777',
		'--mount',
		`type=volume,source=${volume},target=/home/namzu`,
		'--publish',
		'127.0.0.1::2024',
		'--publish',
		'127.0.0.1::2025',
		'--env',
		'NAMZU_SANDBOX_SCREEN_WIDTH=1280',
		'--env',
		'NAMZU_SANDBOX_SCREEN_HEIGHT=800',
		'--env',
		'NAMZU_SANDBOX_TOKEN',
		'namzu-local-computer:1',
	]
}

function lifecycle(volumeCreateFlags: readonly string[]): string[][] {
	return [
		['info', '--format', '{{json .}}'],
		['image', 'inspect', 'namzu-local-computer:1'],
		['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
		['volume', 'create', ...volumeCreateFlags, '--label', `org.namzu.pal.owner=${owner}`, volume],
		['volume', 'inspect', volume],
		runArgs(volumeCreateFlags.length ? ['--cgroups=disabled'] : []),
		['inspect', '--format', '{{json .NetworkSettings.Ports}}', name],
		['stop', '--time', '10', containerId],
		['rm', '-f', containerId],
	]
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('engine command lines recorded before wslc', () => {
	it('docker keeps its exact lifecycle argv', async () => {
		stubReadiness()
		const { runner, calls } = recorder()
		const lease = await createLocalVirtualComputerProvider({ runner }).acquire({
			pal,
			conversationId: 'golden',
		})
		await lease.release()
		expect(calls[0]?.args).toEqual(['context', 'show'])
		expect(calls[1]?.args).toEqual(['context', 'inspect', 'fixture-local'])
		const rest = calls.slice(2)
		expect(rest.every((call) => call.binary === 'docker')).toBe(true)
		expect(
			rest.map((call) => {
				expect(call.args.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock'])
				return normalize(call.args.slice(2))
			}),
		).toEqual(lifecycle([]))
	})
	it('podman keeps its exact lifecycle argv', async () => {
		stubReadiness()
		const { runner, calls } = recorder()
		vi.spyOn(podman, 'resolveLocalPodmanEngine').mockResolvedValue({
			endpoint: 'npipe:////./pipe/local-machine',
			run: (args, options) => runner.run('podman', ['--host', 'local-fixture', ...args], options),
		})
		const lease = await createLocalVirtualComputerProvider({ engine: 'podman' }).acquire({
			pal,
			conversationId: 'golden',
		})
		await lease.release()
		expect(calls.map((call) => normalize(call.args.slice(2)))).toEqual(
			lifecycle(['--ignore']).slice(1),
		)
	})

	// A start that fails after `run` is reconciled by its allocation label.
	const failedStart = (volumeCreateFlags: readonly string[]) => [
		...lifecycle(volumeCreateFlags).slice(0, 6),
		['inspect', '--format', '{{json .NetworkSettings.Ports}}', name],
		[
			'ps',
			'--all',
			'--filter',
			'label=org.namzu.pal.allocation=<id>',
			'--no-trunc',
			'--format',
			'{{.ID}}',
		],
		['rm', '-f', containerId],
	]
	it('docker keeps its exact failed-start cleanup argv', async () => {
		stubReadiness()
		const { runner, calls } = recorder({ badPorts: true })
		await expect(
			createLocalVirtualComputerProvider({ runner }).acquire({ pal, conversationId: 'golden' }),
		).rejects.toThrow()
		expect(calls.slice(2).map((call) => normalize(call.args.slice(2)))).toEqual(failedStart([]))
	})
	it('podman keeps its exact failed-start cleanup argv', async () => {
		stubReadiness()
		const { runner, calls } = recorder({ badPorts: true })
		vi.spyOn(podman, 'resolveLocalPodmanEngine').mockResolvedValue({
			endpoint: 'npipe:////./pipe/local-machine',
			run: (args, options) => runner.run('podman', ['--host', 'local-fixture', ...args], options),
		})
		await expect(
			createLocalVirtualComputerProvider({ engine: 'podman' }).acquire({
				pal,
				conversationId: 'golden',
			}),
		).rejects.toThrow()
		expect(calls.map((call) => normalize(call.args.slice(2)))).toEqual(
			failedStart(['--ignore']).slice(1),
		)
	})
})

describe('readiness attempts', () => {
	it('abandons a probe that the port relay accepted but never answers, then retries', async () => {
		vi.useFakeTimers()
		try {
			let calls = 0
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
					calls += 1
					// The first attempt hangs until its own signal fires.
					if (calls === 1)
						return await new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
						})
					return new Response(
						JSON.stringify(
							url.endsWith('/readyz')
								? { protocol: 1, width: 1280, height: 800, browserReady: true }
								: { protocolVersion: 2 },
						),
						{ status: 200 },
					)
				}),
			)
			const { runner } = recorder()
			const pending = createLocalVirtualComputerProvider({ runner }).acquire({
				pal,
				conversationId: 'golden',
			})
			const settled = pending.then(
				(lease) => lease,
				(error) => {
					throw error
				},
			)
			await vi.advanceTimersByTimeAsync(3000)
			await vi.advanceTimersByTimeAsync(400)
			const lease = await settled
			expect(calls).toBe(3)
			await lease.release()
		} finally {
			vi.useRealTimers()
		}
	})
})
