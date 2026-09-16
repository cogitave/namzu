/**
 * A scripted stand-in for `agent/agent.cjs` on a loopback TCP socket.
 *
 * The real agent is the right peer for anything that is about the WIRE —
 * `transport.test.ts` and `sandbox-surface.test.ts` both run it — but it
 * cannot be the peer for anything about the acquire-time PRIVILEGE PROBE,
 * because the probe reads the guest's real `/proc/self/status` and a test
 * host's node process is (correctly) not deprivileged: its bounding set is
 * whatever it inherited and `NoNewPrivs` is 0. Running the real agent would
 * make every `create()` in every control-plane test fail the probe, which
 * says nothing about the control plane.
 *
 * So this server speaks exactly the frames those tests need and lets the
 * case decide what the probe sees. It is deliberately not a second
 * implementation of the agent: no PTY, no process, no jail — an `execute`
 * replies with a canned stream.
 */

import { randomUUID } from 'node:crypto'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'

import { __framing } from '../../../firecracker/transport.js'

/** What a correctly deprivileged guest publishes — the only shape that admits. */
export const DEPRIVILEGED_PROC_STATUS = [
	'Name:\tcat',
	'Uid:\t65532\t65532\t65532\t65532',
	'Gid:\t65532\t65532\t65532\t65532',
	'CapInh:\t0000000000000000',
	'CapPrm:\t0000000000000000',
	'CapEff:\t0000000000000000',
	'CapBnd:\t0000000000000000',
	'CapAmb:\t0000000000000000',
	'NoNewPrivs:\t1',
	'Seccomp:\t2',
	'',
].join('\n')

/**
 * What an ordinary container publishes: uid 0, the full bounding set, no
 * `no_new_privs`. Everything works; nothing was dropped. This is the state
 * the probe exists to refuse.
 */
export const PRIVILEGED_PROC_STATUS = [
	'Name:\tcat',
	'Uid:\t0\t0\t0\t0',
	'CapInh:\t0000000000000000',
	'CapPrm:\t000001ffffffffff',
	'CapEff:\t000001ffffffffff',
	'CapBnd:\t000001ffffffffff',
	'CapAmb:\t0000000000000000',
	'NoNewPrivs:\t0',
	'',
].join('\n')

export interface ScriptedAgentOptions {
	/**
	 * Address to listen on. `0.0.0.0` lets one server answer on several
	 * loopback addresses at once, which is how the suspend/resume suite proves
	 * a resumed workspace dialed somewhere new: the connection's own
	 * `localAddress` is the address the CLIENT chose to reach it at.
	 */
	readonly host?: string
	/** stdout every `execute` replies with. Default: deprivileged. */
	readonly stdout?: string
	/** Exit code every `execute` reports. Non-zero ⇒ "the probe could not run". */
	readonly exitCode?: number
	readonly stderr?: string
	/** When set, any request presenting a different token is refused. */
	readonly token?: string
	/** Override the `cancel-execution` reply (e.g. to refuse it). */
	readonly cancelReply?: unknown
	/**
	 * Refuse every `read-file` with this error text instead of returning
	 * content — a failure the guest ANSWERED, as opposed to one the dial
	 * produced. Its wording is the point wherever it is used: a host-side
	 * classification that reads an answered error's text can mistake it for
	 * something about the connection.
	 */
	readonly readFileError?: string
	/** Hold an `execute` open this long before replying, so a case can
	 * cancel one that is genuinely in flight. */
	readonly executeDelayMs?: number
}

/** One accepted connection: where the client aimed it. */
export interface ScriptedAgentConnection {
	/** The local address this connection arrived on — the client's target. */
	readonly localAddress: string
}

export interface ScriptedAgent {
	readonly port: number
	/** Every request envelope the server parsed, in order. */
	readonly requests: readonly Record<string, unknown>[]
	/** Every TCP connection accepted, in order. A call that refuses before
	 * dialing leaves this untouched, which is how "no dial" is asserted. */
	readonly connections: readonly ScriptedAgentConnection[]
	/** Bind to a different token, as a resumed pod's fresh agent does. */
	setToken(token: string | undefined): void
	/**
	 * Change the canned stdout every later `execute` replies with.
	 *
	 * Settable rather than constructor-only for the same reason
	 * {@link ScriptedAgent.setLosingExecutions} is: the acquire-time privilege
	 * probe is itself an `execute`, so a case that needs a DIFFERENT canned
	 * reply — a file walk's JSONL records, say — has to install it after the
	 * create the probe gated, not before.
	 */
	setStdout(stdout: string): void
	/**
	 * Start (or stop) losing executions: while this is on, every `execute`
	 * drops its connection mid-command and every `cancel-execution` refuses to
	 * confirm what became of it — an agent that has lost the plot, which from
	 * the host is indistinguishable from a partitioned pod. The shared
	 * execution controller retries the cancel for its whole confirm window and
	 * then reports the outcome UNKNOWN, which is what retires a sandbox.
	 *
	 * Settable rather than constructor-only because the acquire-time privilege
	 * probe is itself an `execute`: a guest that behaved this way from the
	 * start would fail the create instead of the call under test.
	 */
	setLosingExecutions(losing: boolean): void
	close(): Promise<void>
}

const UNAUTHORIZED = { ok: false, error: 'unauthorized' }

function send(socket: Socket, value: unknown): void {
	socket.write(__framing.frame(JSON.stringify(value)))
}

/** The zero-length frame that terminates an `execute` stream. */
function terminate(socket: Socket): void {
	socket.write(Buffer.from('00000000\n', 'ascii'))
}

export async function startScriptedAgent(
	options: ScriptedAgentOptions = {},
): Promise<ScriptedAgent> {
	const requests: Record<string, unknown>[] = []
	const connections: ScriptedAgentConnection[] = []
	let stdout = options.stdout ?? DEPRIVILEGED_PROC_STATUS
	const exitCode = options.exitCode ?? 0
	let token = options.token
	let losingExecutions = false

	const server: Server = createServer((socket) => {
		connections.push({ localAddress: socket.localAddress ?? '' })
		const reader = new __framing.FrameReader()
		socket.on('error', () => {
			// A caller that destroys its socket mid-reply is normal here; the
			// real agent tolerates it too.
		})
		socket.on('data', (chunk: Buffer) => {
			for (const payload of reader.push(chunk)) {
				if (payload.length === 0) continue
				const request = JSON.parse(payload) as Record<string, unknown>
				requests.push(request)
				const op = request.op
				if (op === 'healthz') {
					// Never gated on a token, exactly as the real agent's is not.
					send(socket, { ok: true, protocolVersion: 2 })
					socket.end()
					continue
				}
				if (token !== undefined && request.token !== token) {
					send(socket, UNAUTHORIZED)
					socket.end()
					continue
				}
				if (op === 'reserve-execution') {
					send(socket, {
						ok: true,
						protocolVersion: 2,
						// The controller validates this against a v4-UUID shape.
						executionId: `exec_${randomUUID()}`,
						leaseExpiresAt: Date.now() + 60_000,
					})
					socket.end()
					continue
				}
				if (op === 'cancel-execution') {
					if (losingExecutions) {
						// Answered, and useless: the agent cannot say what became of
						// the command. The controller retries this for its whole
						// confirm window before reporting the outcome unknown.
						send(socket, { ok: false, error: 'cancellation_unconfirmed' })
						socket.end()
						continue
					}
					send(socket, options.cancelReply ?? { ok: true, state: 'cancelled', started: false })
					socket.end()
					continue
				}
				if (op === 'execute') {
					if (losingExecutions) {
						// The command was admitted and the connection then died with
						// it: the host has no result, no exit code, and no way to
						// know whether anything is still running in that pod.
						socket.destroy()
						continue
					}
					const reply = () => {
						if (socket.destroyed) return
						if (stdout.length > 0) send(socket, { type: 'stdout_delta', data: stdout })
						if (options.stderr) send(socket, { type: 'stderr_delta', data: options.stderr })
						send(socket, { type: 'result', exitCode, timedOut: false, durationMs: 1 })
						terminate(socket)
						socket.end()
					}
					if (options.executeDelayMs) {
						setTimeout(reply, options.executeDelayMs).unref?.()
					} else {
						reply()
					}
					continue
				}
				if (op === 'write-file') {
					send(socket, { ok: true })
					socket.end()
					continue
				}
				if (op === 'read-file') {
					send(
						socket,
						options.readFileError !== undefined
							? { ok: false, error: options.readFileError }
							: { ok: true, content: Buffer.from('').toString('base64') },
					)
					socket.end()
					continue
				}
				send(socket, { ok: false, error: `unknown_op: ${String(op)}` })
				socket.end()
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		port,
		requests,
		connections,
		setToken: (next) => {
			token = next
		},
		setStdout: (next) => {
			stdout = next
		},
		setLosingExecutions: (next) => {
			losingExecutions = next
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}
