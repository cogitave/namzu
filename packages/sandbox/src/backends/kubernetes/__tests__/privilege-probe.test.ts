/**
 * The acquire-time privilege probe: the parser, the admission rule, and the
 * refusal path through `create()`.
 *
 * The parser cases are the load-bearing ones. The mistake this module exists
 * to prevent is checking `CapEff` alone — an ordinary unprivileged process
 * shows `CapEff: 0000000000000000` whether or not its bounding set was ever
 * dropped, so a probe that looked only there would pass a container running
 * as uid 0 with every capability still available. Each mask therefore gets
 * its own case, and so does a `NoNewPrivs` that is present but zero.
 *
 * The three ways the probe can fail to ANSWER — the command not running, a
 * non-zero exit, output that does not parse — are all refusals here, and each
 * asserts the error says so in words a reader can act on: a distroless image
 * with no `cat` must be diagnosable as exactly that and not read as a
 * hardening failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildKubernetesBackend } from '../index.js'
import {
	KubernetesPrivilegeProbeError,
	PRIVILEGE_PROBE_ARGS,
	PRIVILEGE_PROBE_COMMAND,
	parseProcStatus,
	runPrivilegeProbe,
} from '../privilege-probe.js'
import {
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import {
	DEPRIVILEGED_PROC_STATUS,
	PRIVILEGED_PROC_STATUS,
	type ScriptedAgent,
	startScriptedAgent,
} from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const SANDBOX_NAME = 'namzu-task-pool-sandbox-91ac3'
const POD_UID = '2b8f0f5a-1c33-4a91-9a07-1c7ed3e2f0aa'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined

afterEach(async () => {
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function status(overrides: Record<string, string>): string {
	const base: Record<string, string> = {
		CapInh: '0000000000000000',
		CapPrm: '0000000000000000',
		CapEff: '0000000000000000',
		CapBnd: '0000000000000000',
		NoNewPrivs: '1',
	}
	return Object.entries({ ...base, ...overrides })
		.map(([key, value]) => `${key}:\t${value}`)
		.join('\n')
}

function execResult(stdout: string, exitCode = 0, stderr = '') {
	return {
		exitCode,
		stdout,
		stderr,
		timedOut: false,
		durationMs: 1,
	}
}

async function probe(stdout: string, exitCode = 0, stderr = ''): Promise<unknown> {
	return await runPrivilegeProbe(async () => execResult(stdout, exitCode, stderr), SANDBOX_NAME)
}

describe('parseProcStatus', () => {
	it('reads all four masks and NoNewPrivs out of a real-shaped status file', () => {
		const parsed = parseProcStatus(DEPRIVILEGED_PROC_STATUS)
		expect(parsed).toEqual({
			capInh: 0n,
			capPrm: 0n,
			capEff: 0n,
			capBnd: 0n,
			noNewPrivs: 1,
		})
	})

	it('parses a wide mask exactly, without going through Number', () => {
		// 0xffffffffffffffff is larger than Number.MAX_SAFE_INTEGER; a parser
		// that routed through `Number` would round it and could round a
		// nonzero mask to something that compares equal to another nonzero
		// one. bigint is exact.
		const parsed = parseProcStatus(status({ CapBnd: 'ffffffffffffffff' }))
		expect(parsed.capBnd).toBe(18_446_744_073_709_551_615n)
	})

	it('refuses a status file missing the NoNewPrivs line', () => {
		const text = DEPRIVILEGED_PROC_STATUS.split('\n')
			.filter((line) => !line.startsWith('NoNewPrivs:'))
			.join('\n')
		expect(() => parseProcStatus(text)).toThrowError(
			expect.objectContaining({
				name: 'KubernetesPrivilegeProbeError',
				reason: 'unreadable-output',
			}),
		)
		expect(() => parseProcStatus(text)).toThrow(/carries no NoNewPrivs line/)
	})

	it('refuses a status file missing a capability line', () => {
		const text = DEPRIVILEGED_PROC_STATUS.split('\n')
			.filter((line) => !line.startsWith('CapBnd:'))
			.join('\n')
		expect(() => parseProcStatus(text)).toThrow(/carries no CapBnd line/)
	})

	it('refuses an unparsable capability mask rather than defaulting it to zero', () => {
		expect(() => parseProcStatus(status({ CapBnd: 'not-a-mask' }))).toThrowError(
			expect.objectContaining({ reason: 'unreadable-output' }),
		)
		// A `0x` prefix is not what the kernel prints, and accepting it would
		// mean accepting whatever else a lookalike file carried.
		expect(() => parseProcStatus(status({ CapBnd: '0x0000000000000000' }))).toThrow(
			/bare hexadecimal capability mask/,
		)
	})

	it('refuses a non-integer NoNewPrivs', () => {
		expect(() => parseProcStatus(status({ NoNewPrivs: 'yes' }))).toThrow(/NoNewPrivs is "yes"/)
	})

	it('refuses empty input', () => {
		expect(() => parseProcStatus('')).toThrowError(
			expect.objectContaining({ reason: 'unreadable-output' }),
		)
	})
})

describe('the admission rule', () => {
	it('admits an all-zero capability set with no_new_privs set', async () => {
		await expect(probe(DEPRIVILEGED_PROC_STATUS)).resolves.toMatchObject({ noNewPrivs: 1 })
	})

	// The whole point of the probe. CapEff is zero in every one of these.
	it('refuses a non-zero CapBnd even though CapEff is zero', async () => {
		await expect(probe(status({ CapBnd: '000001ffffffffff' }))).rejects.toThrowError(
			expect.objectContaining({ reason: 'privileged' }),
		)
		await expect(probe(status({ CapBnd: '000001ffffffffff' }))).rejects.toThrow(
			/CapBnd=1ffffffffff/,
		)
	})

	it('refuses a non-zero CapInh even though CapEff is zero', async () => {
		await expect(probe(status({ CapInh: '0000000000000400' }))).rejects.toThrow(/CapInh=400/)
	})

	it('refuses a non-zero CapPrm even though CapEff is zero', async () => {
		await expect(probe(status({ CapPrm: '0000000000000001' }))).rejects.toThrow(/CapPrm=1/)
	})

	it('refuses a non-zero CapEff', async () => {
		await expect(probe(status({ CapEff: '0000000000000002' }))).rejects.toThrow(/CapEff=2/)
	})

	it('refuses NoNewPrivs: 0 even with every mask already dropped', async () => {
		await expect(probe(status({ NoNewPrivs: '0' }))).rejects.toThrow(/NoNewPrivs=0/)
	})

	it('names every offending field at once rather than only the first', async () => {
		const message = await probe(PRIVILEGED_PROC_STATUS).catch((error: unknown) =>
			error instanceof Error ? error.message : String(error),
		)
		expect(message).toContain('CapPrm=1ffffffffff')
		expect(message).toContain('CapEff=1ffffffffff')
		expect(message).toContain('CapBnd=1ffffffffff')
		expect(message).toContain('NoNewPrivs=0')
	})
})

describe('a probe that could not run is not a privilege failure', () => {
	it('distinguishes a non-zero exit from a privileged process, in words', async () => {
		const failure = await probe('', 127, 'cat: not found').catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesPrivilegeProbeError)
		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('probe-failed')
		expect((failure as Error).message).toMatch(/could not run/)
		expect((failure as Error).message).toMatch(/exited 127/)
		expect((failure as Error).message).toMatch(/diagnostic failure, not a privilege failure/)
		// And it never claims the guest is privileged.
		expect((failure as Error).message).not.toMatch(/is PRIVILEGED/)
	})

	it('reports an exec that threw as "could not run", naming the probe command', async () => {
		const failure = await runPrivilegeProbe(async () => {
			throw new Error('spawn cat ENOENT')
		}, SANDBOX_NAME).catch((error: unknown) => error)
		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('probe-failed')
		expect((failure as Error).message).toMatch(/could not run/)
		expect((failure as Error).message).toContain('spawn cat ENOENT')
		expect((failure as Error).message).toContain(
			`${PRIVILEGE_PROBE_COMMAND} ${PRIVILEGE_PROBE_ARGS.join(' ')}`,
		)
	})

	it('reports unreadable output as unreadable, not as privileged', async () => {
		const failure = await probe('this is not /proc/self/status').catch((error: unknown) => error)
		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('unreadable-output')
		expect((failure as Error).message).not.toMatch(/is PRIVILEGED/)
	})
})

// ---------------------------------------------------------------------------
// Through `create()`: the probe is a gate, not a report.
// ---------------------------------------------------------------------------

function poolApiServer(): Promise<FakeApiServer> {
	return startFakeApiServer((req) => {
		if (req.method === 'POST') return { status: 201, body: {} }
		if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
			return {
				status: 200,
				body: {
					status: {
						conditions: [readyCondition()],
						// A literal loopback address: the guest this create()
						// reaches is the scripted agent below.
						sandbox: { name: SANDBOX_NAME, serviceFQDN: '127.0.0.1' },
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			return { status: 200, body: { metadata: { uid: POD_UID } } }
		}
		if (req.method === 'PATCH') return { status: 200, body: {} }
		if (req.method === 'DELETE') return { status: 200, body: {} }
		return { status: 404, body: {} }
	})
}

/**
 * `readyTimeoutMs` is also the probe's budget (capped) — the acquire budget
 * the caller chose, spent once more on proving the guest is deprivileged —
 * so the hang case below shortens it rather than reaching for a knob that
 * deliberately does not exist.
 */
function backend(readyTimeoutMs = 2_000) {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		agentPort: agent.port,
		readyTimeoutMs,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
	})
}

describe('create() gates on the probe', () => {
	it('runs the probe over the agent before it resolves, with the documented command', async () => {
		server = await poolApiServer()
		agent = await startScriptedAgent({ token: POD_UID })

		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		const executes = agent.requests.filter((r) => r.op === 'execute')
		expect(executes).toHaveLength(1)
		expect(executes[0]?.body).toMatchObject({
			command: PRIVILEGE_PROBE_COMMAND,
			args: [...PRIVILEGE_PROBE_ARGS],
		})
		// Through the sandbox's own exec, so the probe traverses the same
		// reserve-then-execute admission every later call does.
		expect(agent.requests.filter((r) => r.op === 'reserve-execution')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('destroys the instance and rejects when the guest is privileged — no handle escapes', async () => {
		server = await poolApiServer()
		agent = await startScriptedAgent({ token: POD_UID, stdout: PRIVILEGED_PROC_STATUS })

		const failure = await backend()
			.create({ workingDirectory: '/workspace' })
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(KubernetesPrivilegeProbeError)
		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('privileged')
		expect((failure as Error).message).toContain(SANDBOX_NAME)
		// The claim this backend created is deleted before the rejection —
		// a refused sandbox must not be left running on the cluster.
		const deletes = server.requests.filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toContain('/sandboxclaims/')
	})

	it("rejects with the caller's own reason when create is cancelled during the probe", async () => {
		server = await poolApiServer()
		// Held open long enough for the abort to land on a probe genuinely in
		// flight, rather than on one that has already answered.
		agent = await startScriptedAgent({ token: POD_UID, executeDelayMs: 5_000 })
		const caller = new AbortController()
		const reason = new Error('operator stopped the acquire')

		const pending = backend().create({ workingDirectory: '/workspace', signal: caller.signal })
		await vi.waitFor(() => expect(agent?.requests.some((r) => r.op === 'execute')).toBe(true))
		caller.abort(reason)

		// Not the probe's account of a command cancelled out from under it.
		await expect(pending).rejects.toBe(reason)
		// Still cleaned up: a cancelled acquire leaves nothing on the cluster.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('refuses a guest that answers the dial and then never answers the probe', async () => {
		server = await poolApiServer()
		// The connection is accepted, the `execute` frame is read, and nothing
		// ever comes back: a wedged agent — out of memory, an event loop the
		// workload blocked — looks exactly like this from the host.
		agent = await startScriptedAgent({ token: POD_UID, executeDelayMs: 60_000 })

		const startedAt = Date.now()
		const failure = await backend(1_000)
			.create({ workingDirectory: '/workspace' })
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(KubernetesPrivilegeProbeError)
		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('probe-failed')
		// Named as the hang it is. A reader told `cat` could not run goes
		// looking for a binary that is not missing.
		expect((failure as Error).message).toMatch(/did not answer/)
		expect((failure as Error).message).not.toMatch(/is PRIVILEGED/)
		// The whole point: bounded by the acquire budget rather than by the
		// execution controller's generic defaults. Unbounded, this create()
		// stays pending for ~5 min 12 s (a 5-minute execution observation,
		// then cancel-confirm and drain) and the case dies on vitest's own
		// timeout instead of failing this assertion.
		expect(Date.now() - startedAt).toBeLessThan(4_000)
		// And it is a refusal like any other: nothing is left on the cluster.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('destroys the instance and rejects when the probe could not run', async () => {
		server = await poolApiServer()
		agent = await startScriptedAgent({
			token: POD_UID,
			stdout: '',
			exitCode: 127,
			stderr: 'cat: not found',
		})

		const failure = await backend()
			.create({ workingDirectory: '/workspace' })
			.catch((error: unknown) => error)

		expect((failure as KubernetesPrivilegeProbeError).reason).toBe('probe-failed')
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('the optional methods this backend does not offer', () => {
	it('omits setNetworkPolicy and spawnDetached rather than accepting and ignoring them', async () => {
		server = await poolApiServer()
		agent = await startScriptedAgent({ token: POD_UID })

		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		// Asserted, so neither can be added later without a deliberate change
		// here. `setNetworkPolicy` cannot be honoured — egress is a
		// NetworkPolicy on the pool's SandboxTemplate, not a per-pod knob —
		// and the SDK's contract says a backend that cannot enforce one must
		// omit it rather than accept it and quietly not apply it.
		expect(sandbox.setNetworkPolicy).toBeUndefined()
		expect(sandbox.spawnDetached).toBeUndefined()
		// The ones it does offer are present.
		expect(typeof sandbox.openTerminal).toBe('function')
		expect(typeof sandbox.openTcpConnection).toBe('function')
		await sandbox.destroy()
	})
})
