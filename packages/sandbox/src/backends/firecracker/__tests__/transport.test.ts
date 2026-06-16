/**
 * Loopback transport round-trip tests for the Firecracker vsock path.
 *
 * These prove the NEW transport (host dialer ↔ in-VM agent) over a
 * **unix-socket stand-in** — the faithful local peer for AF_VSOCK,
 * because the production vsock path also terminates on a host
 * unix socket (see `transport.ts` docblock). The peer is the REAL
 * `agent/agent.cjs` connection handler (its spawn/jail + NDJSON shapes
 * verbatim), driven in-process over a temp unix socket; the client is
 * the REAL {@link VsockAgentTransport}. So one test exercises:
 *   - exec → streamed stdout/stderr/result NDJSON, accumulated;
 *   - writeFile / readFile → base64 round-trip through the jail;
 *   - a simulated resume (server torn down + re-listened) survived by
 *     the dialer's connect-retry budget — the FC #4713 invariant.
 *
 * No docker, no Azure, no AF_VSOCK kernel support required: pure
 * loopback, safe in CI.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer, connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TLSSocket, type Server as TlsServer, createServer as createTlsServer } from 'node:tls'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VsockAgentTransport } from '../transport.js'

// The agent is a CommonJS module that reads NAMZU_SANDBOX_WORKSPACE at
// require-time. Set the env, then require it through createRequire so
// each test file gets a fresh module bound to its own workspace dir.
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

interface AgentModule {
	handleConnection(socket: Socket): void
}

let workDir: string
let sockPath: string
let server: Server | undefined
let agent: AgentModule

function startAgentServer(connHandler: (s: Socket) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const s = createServer(connHandler)
		s.on('error', reject)
		s.listen(sockPath, () => resolve(s))
	})
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'fc-agent-test-'))
	sockPath = join(workDir, 'agent.sock')
	// Bind the agent's workspace jail to the temp dir BEFORE requiring it.
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	// The agent's root-normalization filters env on PRESENCE; `= undefined`
	// sets the literal string "undefined" and would widen READ/WRITE_ROOTS, so
	// these must be true deletes.
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	delete process.env.NAMZU_SANDBOX_READ_ROOTS
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	delete process.env.NAMZU_SANDBOX_WRITE_ROOTS
	// Fresh module each test so WORKSPACE_ROOT is rebound.
	delete require_.cache[require_.resolve('../../../../agent/agent.cjs')]
	agent = require_('../../../../agent/agent.cjs') as AgentModule
})

afterEach(async () => {
	if (server) {
		await new Promise<void>((r) => server?.close(() => r()))
		server = undefined
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe('VsockAgentTransport over a unix-socket loopback agent', () => {
	it('streams stdout/stderr/result NDJSON from an exec', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		const r = await transport.execute({
			command: '/bin/sh',
			args: ['-c', 'echo out-line; echo err-line 1>&2; exit 3'],
		})
		expect(r.stdout).toContain('out-line')
		expect(r.stderr).toContain('err-line')
		expect(r.exitCode).toBe(3)
		expect(r.timedOut).toBe(false)
		expect(r.durationMs).toBeGreaterThanOrEqual(0)
	})

	it('streams a large multi-chunk stdout intact (delta accumulation)', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		// 200 lines so the agent emits multiple stdout_delta frames the
		// FrameReader must reassemble across socket chunks.
		const r = await transport.execute({
			command: '/bin/sh',
			args: ['-c', 'for i in $(seq 1 200); do echo "line-$i"; done'],
		})
		expect(r.exitCode).toBe(0)
		const lines = r.stdout.trim().split('\n')
		expect(lines.length).toBe(200)
		expect(lines[0]).toBe('line-1')
		expect(lines[199]).toBe('line-200')
	})

	it('round-trips writeFile/readFile as base64 through the workspace jail', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })

		// Binary content (non-UTF8 bytes) proves base64 fidelity, not
		// just text.
		const payload = Buffer.from([0x00, 0xff, 0x10, 0x42, 0x00, 0x99, 0xfe])
		await transport.writeFile('sub/dir/blob.bin', payload)
		const read = await transport.readFile('sub/dir/blob.bin')
		expect(read.equals(payload)).toBe(true)
	})

	it('rejects a path that escapes the workspace jail', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		await expect(transport.readFile('../../../../etc/passwd')).rejects.toThrow(/escapes/)
	})

	it('healthz returns true against a live agent', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		expect(await transport.healthz()).toBe(true)
	})

	it('surfaces an exec error event as a thrown error', async () => {
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport({ kind: 'unix', path: sockPath })
		// Empty command name → agent emits { type: 'error' }.
		await expect(transport.execute({ command: '' })).rejects.toThrow()
	})

	it('survives a simulated resume: server torn down then re-listened, dialer reconnects', async () => {
		// 1. Agent is up; one exec succeeds.
		server = await startAgentServer(agent.handleConnection)
		const transport = new VsockAgentTransport(
			{ kind: 'unix', path: sockPath },
			// Tight retry budget so the test is fast but still proves retry.
			{ connectRetryBudgetMs: 5_000, connectRetryIntervalMs: 50, connectTimeoutMs: 1_000 },
		)
		const first = await transport.execute({ command: '/bin/sh', args: ['-c', 'echo before'] })
		expect(first.stdout).toContain('before')

		// 2. Simulate a resume: the FC vsock driver closes all connections
		//    and the listener is gone until the agent re-LISTENs. Tear the
		//    server down entirely.
		await new Promise<void>((r) => server?.close(() => r()))
		server = undefined

		// 3. Kick off an exec WHILE the agent is still down. The dialer's
		//    connect-retry budget must hold (ECONNREFUSED) until the agent
		//    re-listens — this is the FC #4713 / TRANSPORT_RESET-not-
		//    delivered mitigation: the host re-dials rather than hanging.
		const pending = transport.execute({ command: '/bin/sh', args: ['-c', 'echo after'] })

		// 4. After a beat, the agent re-establishes its listen on the SAME
		//    address (the resume re-listen invariant).
		await new Promise((r) => setTimeout(r, 300))
		server = await startAgentServer(agent.handleConnection)

		const after = await pending
		expect(after.stdout).toContain('after')
		expect(after.exitCode).toBe(0)
	})

	it('connect-retry budget gives up with a clear error when the agent never returns', async () => {
		// No server started at all. The dialer should exhaust its budget
		// and throw a descriptive error rather than hang forever.
		const transport = new VsockAgentTransport(
			{ kind: 'unix', path: sockPath },
			{ connectRetryBudgetMs: 400, connectRetryIntervalMs: 50, connectTimeoutMs: 200 },
		)
		await expect(transport.healthz()).resolves.toBe(false)
		await expect(transport.readFile('x')).rejects.toThrow(/could not connect to agent/)
	})
})

// ---------------------------------------------------------------------------
// Ring-0 mTLS arm — pure-local TLS loopback "relay" (no Azure, no FC host)
// ---------------------------------------------------------------------------
//
// Proves the ADDITIVE `kind:'mtls'` transport arm without a real fleet:
//   - a `tls.createServer` plays the per-FC-host RELAY (requestCert +
//     rejectUnauthorized), reads the `SANDBOX <id>` routing preamble,
//     then bridges verbatim to the SAME `agent.handleConnection` peer
//     the vsock/unix arms use — so the IDENTICAL framing round-trips.
//   - the dialer presents the fleet CLIENT cert and verifies the relay
//     server cert; a WRONG-CA client is rejected at the TLS layer.
//   - the `SANDBOX <id>` preamble is the FIRST bytes after the
//     handshake (the relay's routing key), and the caller never writes
//     a guest `CONNECT 1024` line (the relay issues that host-side).
//
// The cert material is a throwaway P-256 test PKI (CA + server leaf +
// client leaf + an unrelated rogue client) baked in as PEM constants —
// no openssl/forge at test time, keeping the package dependency-light.

// Test PKI. Minted offline with: openssl ec/x509 self-signed CA + leaves
// (server SAN = DNS:sandbox.fc.internal, IP:127.0.0.1). Far-future expiry.
// `ROGUE_*` chains to a DIFFERENT CA to prove rejectUnauthorized blocks it.
const CA_CRT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUGXUtG14KQr4spNGW7rpfjZGoBIIwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBwxGjAYBgNVBAMMEXZhbmRhbC1mYy10ZXN0LWNhMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5l+vjhjm/PX02D55n56EwelgvM1jrqQM
Z+ezzvMmrZEBGWInvBND3z3kc6nv7snu6fHT2HHOyhwUNoLqmrIg/qNTMFEwHQYD
VR0OBBYEFP0M8/KZY1ovxyGDci5iuoYXcmZgMB8GA1UdIwQYMBaAFP0M8/KZY1ov
xyGDci5iuoYXcmZgMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg
C0xtFDASnwsOYT0GiZwzYWTOBfgmjDWK7ANXQQFNTh4CICVLQwq5eLy3424drEHk
5Ol/FNKVZcGRjE96rB0mRUOp
-----END CERTIFICATE-----
`

const SERVER_CRT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVWgAwIBAgIUYkXroqlz9blXW8llis6e2OxOc1MwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBIxEDAOBgNVBAMMB2ZjLWhvc3QwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQodCSHY8Sz5Lh/4K6+SzekkrRCeKMBfmonVb7dUhM0ZWpo
ePCcRrMcJp5aNxLxEgkl2EMMMMwE3LlLSOX5LZz6o30wezAkBgNVHREEHTAbghNz
YW5kYm94LmZjLmludGVybmFshwR/AAABMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0G
A1UdDgQWBBRXHU1vlX7WvqzcbaNxRxV4f3gfDDAfBgNVHSMEGDAWgBT9DPPymWNa
L8chg3IuYrqGF3JmYDAKBggqhkjOPQQDAgNJADBGAiEAlqzKqgBf5hxJqd26QwcY
n3cvEKi4f2BSLe1Rfzr5oSoCIQD0izUOJXLNvmac9cMgV0HvkftBerDKFOcGeGTN
g3Eunw==
-----END CERTIFICATE-----
`

const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/ROnYXIkMKnipbLt
JnFEwXAifgeOv9TGLcK2RojE7jmhRANCAAQodCSHY8Sz5Lh/4K6+SzekkrRCeKMB
fmonVb7dUhM0ZWpoePCcRrMcJp5aNxLxEgkl2EMMMMwE3LlLSOX5LZz6
-----END PRIVATE KEY-----
`

const CLIENT_CRT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUYkXroqlz9blXW8llis6e2OxOc1QwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRdmFuZGFsLWZjLXRlc3QtY2EwIBcNMjYwNjE2MDgzMjUyWhgP
MjEyNjA1MjMwODMyNTJaMBgxFjAUBgNVBAMMDWNhLXZhbmRhbC1hcHAwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAASlCMCwjtrQUicWcWsO29R5S7fzjMbbxXvDh8/K
w57x/PN/uQwLHWCz1Tsyk0FnbrwGP+nPtwrUPIxrLN//euXko1cwVTATBgNVHSUE
DDAKBggrBgEFBQcDAjAdBgNVHQ4EFgQU2cxDCNrlVkk4ODs6ZPrkC6GzHjkwHwYD
VR0jBBgwFoAU/Qzz8pljWi/HIYNyLmK6hhdyZmAwCgYIKoZIzj0EAwIDRwAwRAIg
RghqArNm3bXnWnRi+jkEEJa8mRb2z0Wj4G7SIhtMurUCIBQSllVtICgZB9hvcM0D
d24fcW4nlfvaZJMJ6dRC1Wle
-----END CERTIFICATE-----
`

const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaamj/ycrEuPqpiC2
IhAYx/M5iN4t4P+B17V4GO54Nb2hRANCAASlCMCwjtrQUicWcWsO29R5S7fzjMbb
xXvDh8/Kw57x/PN/uQwLHWCz1Tsyk0FnbrwGP+nPtwrUPIxrLN//euXk
-----END PRIVATE KEY-----
`

const ROGUE_CLIENT_CRT = `-----BEGIN CERTIFICATE-----
MIIBhjCCASugAwIBAgIUbAYOlW4PQGyXjjRsjCPy62EHUmIwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcm9ndWUtY2EwIBcNMjYwNjE2MDgzMjUyWhgPMjEyNjA1MjMw
ODMyNTJaMBcxFTATBgNVBAMMDHJvZ3VlLWNsaWVudDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABOPSzdzQTQz3M5CDHLVPguvHd10ncaDV9t4zKUy/PCE+U7GTJwN2
TtypGnmYEahbcl45j94hwu495P5VbR5ohb6jVzBVMBMGA1UdJQQMMAoGCCsGAQUF
BwMCMB0GA1UdDgQWBBTf0woauniche3/ps77+Kd0dsbbSDAfBgNVHSMEGDAWgBSX
Yu0IJlPxi79Gyi5hR1IfS/sqyzAKBggqhkjOPQQDAgNJADBGAiEAxD4N4XWtaHPJ
yaCOzQP0e5RRyNst3QrhH0NSMyPw89wCIQC+bezLX97TuV1sId53Bo1l9j1TSOMa
EZotN/Wsq6L+qw==
-----END CERTIFICATE-----
`

const ROGUE_CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgR6fGq27O9eT/hi0Q
c+L5+lSm5fbDEghVJCo6k7HrG62hRANCAATj0s3c0E0M9zOQgxy1T4Lrx3ddJ3Gg
1fbeMylMvzwhPlOxkycDdk7cqRp5mBGoW3JeOY/eIcLuPeT+VW0eaIW+
-----END PRIVATE KEY-----
`

interface RelayHandle {
	readonly server: TlsServer
	readonly port: number
	/** sandboxId from the first connection's `SANDBOX <id>` preamble. */
	preamble(): Promise<string>
}

/**
 * A loopback stand-in for the per-FC-host mTLS relay.
 *
 * Terminates mTLS (requestCert + rejectUnauthorized + CA pin), reads the
 * `SANDBOX <id>\n` routing preamble line, then bridges the rest of the
 * TLS stream verbatim to a FRESH `net.connect` to `agentSockPath` (the
 * unix-socket-backed real agent) — exactly the dumb byte-pump the
 * production relay is. It does NOT speak framing itself and does NOT
 * send an ack line (matching the transport's no-ack INTEGRATE contract).
 */
function startMtlsRelay(agentSockPath: string, listenPort = 0): Promise<RelayHandle> {
	let resolvePreamble: (id: string) => void
	const preamble = new Promise<string>((r) => {
		resolvePreamble = r
	})

	return new Promise<RelayHandle>((resolve, reject) => {
		const server = createTlsServer(
			{
				requestCert: true,
				rejectUnauthorized: true,
				ca: CA_CRT,
				cert: SERVER_CRT,
				key: SERVER_KEY,
				minVersion: 'TLSv1.3',
			},
			(tlsSock: TLSSocket) => {
				// Read exactly the `SANDBOX <id>\n` preamble line, then bridge.
				let pre = Buffer.alloc(0)
				const onPreambleData = (chunk: Buffer) => {
					pre = Buffer.concat([pre, chunk])
					const nl = pre.indexOf(0x0a)
					if (nl < 0) return
					tlsSock.removeListener('data', onPreambleData)
					// Pause + unshift any post-preamble bytes so flowing-mode
					// data is not dropped between removing this listener and
					// attaching the pipe (the framed request can arrive in the
					// same OR a later chunk). `pipe` resumes the stream.
					tlsSock.pause()
					const line = pre.subarray(0, nl).toString('utf8')
					const rest = pre.subarray(nl + 1)
					if (rest.length > 0) tlsSock.unshift(rest)
					const m = /^SANDBOX (.+)$/.exec(line)
					const id = m?.[1]
					if (id === undefined) {
						tlsSock.destroy()
						return
					}
					resolvePreamble(id)
					// 1 inbound mTLS conn -> 1 FRESH local agent connect (the
					// resume-survival invariant the relay must preserve).
					const upstream = netConnect({ path: agentSockPath })
					upstream.on('error', () => tlsSock.destroy())
					tlsSock.on('error', () => upstream.destroy())
					upstream.once('connect', () => {
						tlsSock.pipe(upstream)
						upstream.pipe(tlsSock)
					})
				}
				tlsSock.on('data', onPreambleData)
			},
		)
		server.on('error', reject)
		server.listen(listenPort, '127.0.0.1', () => {
			const addr = server.address()
			if (addr === null || typeof addr === 'string') {
				reject(new Error('relay: no TCP port'))
				return
			}
			resolve({ server, port: addr.port, preamble: () => preamble })
		})
	})
}

/** Re-listen the relay on a FIXED port (the host-bridge-restart case). */
function startMtlsRelayOnPort(agentSockPath: string, port: number): Promise<RelayHandle> {
	return startMtlsRelay(agentSockPath, port)
}

describe('VsockAgentTransport mtls arm over a TLS loopback relay', () => {
	let agentServer: Server | undefined
	let relay: RelayHandle | undefined

	afterEach(async () => {
		if (relay) {
			await new Promise<void>((r) => relay?.server.close(() => r()))
			relay = undefined
		}
		if (agentServer) {
			await new Promise<void>((r) => agentServer?.close(() => r()))
			agentServer = undefined
		}
	})

	function mtlsTransport(opts?: ConstructorParameters<typeof VsockAgentTransport>[1]) {
		if (!relay) throw new Error('relay not started')
		return new VsockAgentTransport(
			{
				kind: 'mtls',
				host: '127.0.0.1',
				port: relay.port,
				sandboxId: 'sbx-ring0-abc123',
				tls: {
					ca: CA_CRT,
					cert: CLIENT_CRT,
					key: CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
			},
			opts,
		)
	}

	it('round-trips exec + write/read + healthz through the mTLS relay', async () => {
		agentServer = await startAgentServer(agent.handleConnection)
		relay = await startMtlsRelay(sockPath)
		const transport = mtlsTransport()

		const r = await transport.execute({
			command: '/bin/sh',
			args: ['-c', 'echo mtls-out; echo mtls-err 1>&2; exit 7'],
		})
		expect(r.stdout).toContain('mtls-out')
		expect(r.stderr).toContain('mtls-err')
		expect(r.exitCode).toBe(7)

		const payload = Buffer.from([0x00, 0xff, 0x10, 0x42, 0x00, 0x99, 0xfe])
		await transport.writeFile('m/blob.bin', payload)
		const read = await transport.readFile('m/blob.bin')
		expect(read.equals(payload)).toBe(true)

		expect(await transport.healthz()).toBe(true)
	})

	it('sends `SANDBOX <id>` as the first bytes after the handshake (no CONNECT line)', async () => {
		agentServer = await startAgentServer(agent.handleConnection)
		relay = await startMtlsRelay(sockPath)
		const transport = mtlsTransport()

		// Any op drives a dial; the relay records the preamble line.
		expect(await transport.healthz()).toBe(true)
		// The caller's first line is the routing preamble, NOT `CONNECT 1024`
		// — the relay issues the guest CONNECT host-side.
		await expect(relay.preamble()).resolves.toBe('sbx-ring0-abc123')
	})

	it('rejects a client presenting a wrong-CA cert (rejectUnauthorized blocks it)', async () => {
		agentServer = await startAgentServer(agent.handleConnection)
		relay = await startMtlsRelay(sockPath)
		// Rogue client cert chains to a DIFFERENT CA than the relay trusts.
		const rogue = new VsockAgentTransport(
			{
				kind: 'mtls',
				host: '127.0.0.1',
				port: relay.port,
				sandboxId: 'sbx-ring0-abc123',
				tls: {
					ca: CA_CRT,
					cert: ROGUE_CLIENT_CRT,
					key: ROGUE_CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
			},
			{ connectRetryBudgetMs: 600, connectRetryIntervalMs: 50, connectTimeoutMs: 300 },
		)
		// The relay's `rejectUnauthorized` drops the connection AFTER the
		// client handshake completes (the client trusts the server CA), so
		// the failure surfaces as a torn-down round-trip, not a TLS verify
		// error on the client side. Either way no agent traffic completes:
		// healthz swallows it into `false`; readFile rejects.
		expect(await rogue.healthz()).toBe(false)
		await expect(rogue.readFile('x')).rejects.toThrow()
	})

	it('rejects a server whose cert does not chain to the pinned CA (caller-side verify)', async () => {
		agentServer = await startAgentServer(agent.handleConnection)
		relay = await startMtlsRelay(sockPath)
		// The CALLER pins the ROGUE CA, so the relay's good-CA server cert
		// fails verification — proves the dialer's rejectUnauthorized works.
		const wrongCaCaller = new VsockAgentTransport(
			{
				kind: 'mtls',
				host: '127.0.0.1',
				port: relay.port,
				sandboxId: 'sbx-ring0-abc123',
				tls: {
					ca: ROGUE_CLIENT_CRT, // not the issuing CA → server cert unverifiable
					cert: CLIENT_CRT,
					key: CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
			},
			{ connectRetryBudgetMs: 600, connectRetryIntervalMs: 50, connectTimeoutMs: 300 },
		)
		await expect(wrongCaCaller.readFile('x')).rejects.toThrow(/could not connect to agent/)
	})

	it('survives a simulated resume through the relay (relay torn down then re-listened on the same port)', async () => {
		agentServer = await startAgentServer(agent.handleConnection)
		relay = await startMtlsRelay(sockPath)
		const fixedPort = relay.port
		const transport = new VsockAgentTransport(
			{
				kind: 'mtls',
				host: '127.0.0.1',
				port: fixedPort,
				sandboxId: 'sbx-ring0-abc123',
				tls: {
					ca: CA_CRT,
					cert: CLIENT_CRT,
					key: CLIENT_KEY,
					servername: 'sandbox.fc.internal',
				},
			},
			{ connectRetryBudgetMs: 5_000, connectRetryIntervalMs: 50, connectTimeoutMs: 1_000 },
		)
		const first = await transport.execute({ command: '/bin/sh', args: ['-c', 'echo before'] })
		expect(first.stdout).toContain('before')

		// Simulate the FC host bridge going away then coming back (the
		// network analogue of a vsock re-LISTEN): tear the relay down so the
		// caller's TLS connect gets ECONNREFUSED, and the per-request fresh
		// dial must ride the connect-retry budget until the relay is back.
		await new Promise<void>((r) => relay?.server.close(() => r()))
		relay = undefined

		const pending = transport.execute({ command: '/bin/sh', args: ['-c', 'echo after'] })
		await new Promise((r) => setTimeout(r, 300))
		// Re-listen the relay on the SAME port (the host bridge restarts).
		relay = await startMtlsRelayOnPort(sockPath, fixedPort)

		const after = await pending
		expect(after.stdout).toContain('after')
		expect(after.exitCode).toBe(0)
	})
})
