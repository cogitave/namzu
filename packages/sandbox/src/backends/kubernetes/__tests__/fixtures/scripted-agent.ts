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
	/** stdout every `execute` replies with. Default: deprivileged. */
	readonly stdout?: string
	/** Exit code every `execute` reports. Non-zero ⇒ "the probe could not run". */
	readonly exitCode?: number
	readonly stderr?: string
	/** When set, any request presenting a different token is refused. */
	readonly token?: string
	/** Override the `cancel-execution` reply (e.g. to refuse it). */
	readonly cancelReply?: unknown
	/** Hold an `execute` open this long before replying, so a case can
	 * cancel one that is genuinely in flight. */
	readonly executeDelayMs?: number
}

export interface ScriptedAgent {
	readonly port: number
	/** Every request envelope the server parsed, in order. */
	readonly requests: readonly Record<string, unknown>[]
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
	const stdout = options.stdout ?? DEPRIVILEGED_PROC_STATUS
	const exitCode = options.exitCode ?? 0

	const server: Server = createServer((socket) => {
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
				if (options.token !== undefined && request.token !== options.token) {
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
					send(socket, options.cancelReply ?? { ok: true, state: 'cancelled', started: false })
					socket.end()
					continue
				}
				if (op === 'execute') {
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
					send(socket, { ok: true, content: Buffer.from('').toString('base64') })
					socket.end()
					continue
				}
				send(socket, { ok: false, error: `unknown_op: ${String(op)}` })
				socket.end()
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		port,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}
