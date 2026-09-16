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
	/**
	 * What `healthz` advertises in `features`. Omitted by default, which is
	 * the guest an image built before a feature existed: the host then takes
	 * the old path for everything and refuses what only the new one serves.
	 */
	readonly features?: readonly string[]
	/**
	 * The file every `read-file` and `read-file-stream` answers with.
	 *
	 * When set, both ops behave the way `agent/agent.cjs` does for a single
	 * file: `read-file` honours `offset`/`length` and reports the WHOLE
	 * file's `sizeBytes` beside the slice, and `read-file-stream` sends
	 * `meta` -> `data`* -> `end` -> terminator. That is what lets a
	 * control-plane test — which cannot run the real agent, because the
	 * privilege probe would fail — still prove that a range a caller asked
	 * for reached the wire and that the bytes it got back are the slice.
	 */
	readonly readFileContent?: Buffer
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
	/**
	 * Bind to a different token, as a resumed pod's fresh agent does — and
	 * with it, be a fresh AGENT: a new pod is a new process, which has fenced
	 * nothing, so this also clears the fence a `cancellation_unconfirmed`
	 * raised. Nothing else clears it, exactly as nothing but a new pod clears
	 * the real one.
	 */
	setToken(token: string | undefined): void
	/**
	 * Change the canned stdout every later `execute` replies with.
	 *
	 * Settable rather than constructor-only for the same reason
	 * {@link ScriptedAgent.setLosingExecutions} is: the acquire-time privilege
	 * probe is itself an `execute`, so a case that needs a DIFFERENT canned
	 * reply — a file walk's JSONL records, or a guest that published
	 * {@link PRIVILEGED_PROC_STATUS} from the start where the case under test
	 * is really about the SECOND probe — has to install it after the create
	 * the probe gated, not before.
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
	/**
	 * Start (or stop) FORGETTING executions: every `execute` drops its
	 * connection mid-command, and every `cancel-execution` answers
	 * `unknown_execution` — the agent process restarted inside the same pod,
	 * so the uid and therefore the token are unchanged and the host is still
	 * talking to the right guest, but the execution table went with the old
	 * process.
	 *
	 * Same host-visible outcome as {@link setLosingExecutions} — the cancel is
	 * refused for the whole confirm window, so the outcome is reported UNKNOWN
	 * — and one crucial difference: `handleCancelExecution` reaches
	 * `unknown_execution` without ever calling `retireAgent`, so NO fence is
	 * raised and `healthz` goes on answering `ok`. It is the third diagnosis,
	 * the one whose advice is to do nothing.
	 */
	setForgetsExecutions(forgets: boolean): void
	/**
	 * Stop answering at all: every connection is accepted and destroyed
	 * before a reply, and every open one is torn down. A partitioned pod, an
	 * agent that died, a node that went away — from the host they are one
	 * thing, and the thing they are NOT is a guest that answered.
	 *
	 * The distinction is the whole point of the diagnostic `healthz` after an
	 * unconfirmed cancellation: a fenced agent ANSWERS `retiring: true` and
	 * needs a new pod, while this one answers nothing and may be perfectly
	 * fine a second from now.
	 */
	setUnreachable(unreachable: boolean): void
	/**
	 * Admit an `execute` and never reply, holding the connection open, so a
	 * case can break the stream ITSELF rather than have the guest end it.
	 * That is the shape a network loss under a running command has: the
	 * command was admitted, and the host stopped hearing about it.
	 */
	setExecuteHangs(hangs: boolean): void
	/**
	 * Answer a `healthz` the way the agent's CONNECTION gate does when it has
	 * no room for the probe: `handleConnection` refuses a connection that
	 * arrived over one unauthenticated connection too many — or behind an
	 * exhausted pre-auth buffer — with `{ ok: false, error }` and takes the
	 * connection down before `dispatch` ever sees the frame.
	 *
	 * The reply therefore says `ok: false` and carries NO `retiring` flag,
	 * which is the shape a host must not read as a fence: it names a reason
	 * of its own, and none of them is "this agent has retired".
	 */
	setHealthzRefusal(error: string | undefined): void
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
	/** See {@link ScriptedAgent.setForgetsExecutions}. Never fences. */
	let forgetsExecutions = false
	/**
	 * The agent has FENCED itself, exactly as `agent.cjs`'s `retireAgent`
	 * does: it could not confirm that a process group was gone, so from here
	 * on `healthz` answers `ok: false, retiring: true` and every op but
	 * `healthz` and `cancel-execution` is refused with `agent_retiring`.
	 *
	 * Derived rather than settable, because in the real agent it is derived:
	 * the fence is raised BY answering `cancellation_unconfirmed`, and a
	 * fixture where the two could be set apart would let a test assert a
	 * combination no guest can produce. It clears with `setToken`, which is
	 * this fixture's way of saying the pod was replaced — the only thing that
	 * clears the real one.
	 */
	let retiring = false
	let unreachable = false
	let executeHangs = false
	let healthzRefusal: string | undefined
	const open = new Set<Socket>()

	const server: Server = createServer((socket) => {
		connections.push({ localAddress: socket.localAddress ?? '' })
		open.add(socket)
		socket.on('close', () => open.delete(socket))
		const reader = new __framing.FrameReader()
		socket.on('error', () => {
			// A caller that destroys its socket mid-reply is normal here; the
			// real agent tolerates it too.
		})
		if (unreachable) {
			socket.destroy()
			return
		}
		socket.on('data', (chunk: Buffer) => {
			for (const payload of reader.push(chunk)) {
				if (payload.length === 0) continue
				const request = JSON.parse(payload) as Record<string, unknown>
				requests.push(request)
				const op = request.op
				if (op === 'healthz' && healthzRefusal !== undefined) {
					// The gate's answer, not `dispatch`'s: a named reason and
					// no fence flag, because the frame never reached the code
					// that knows whether the agent has fenced itself.
					send(socket, { ok: false, error: healthzRefusal })
					socket.end()
					continue
				}
				if (op === 'healthz') {
					// Never gated on a token, exactly as the real agent's is not
					// — and it is the ONE op a fenced agent still answers
					// truthfully, which is what tells a fenced pod from an
					// unreachable one.
					send(socket, {
						ok: !retiring,
						protocolVersion: 2,
						...(retiring ? { retiring: true } : {}),
						...(options.features ? { features: [...options.features] } : {}),
					})
					socket.end()
					continue
				}
				if (token !== undefined && request.token !== token) {
					send(socket, UNAUTHORIZED)
					socket.end()
					continue
				}
				// `dispatch`'s own gate: `cancel-execution` goes through a
				// fence (it is how a host asks about the command that raised
				// it) and everything else is refused by name.
				if (retiring && op !== 'cancel-execution') {
					send(socket, { ok: false, error: 'agent_retiring' })
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
					if (forgetsExecutions) {
						// A restarted agent process, not a wedged one: it can say
						// what it knows about this id, which is nothing.
						// `handleCancelExecution` answers this before it ever
						// reaches `ensureTermination`, so `retireAgent` is not
						// called and no fence goes up — the host is left with an
						// unconfirmed cancellation and a perfectly healthy agent.
						send(socket, { ok: false, error: 'unknown_execution' })
						socket.end()
						continue
					}
					if (losingExecutions) {
						// Answered, and useless: the agent cannot say what became of
						// the command. The controller retries this for its whole
						// confirm window before reporting the outcome unknown — and
						// the real agent FENCES itself on exactly this answer, so
						// the fixture does too.
						retiring = true
						send(socket, { ok: false, error: 'cancellation_unconfirmed' })
						socket.end()
						continue
					}
					send(socket, options.cancelReply ?? { ok: true, state: 'cancelled', started: false })
					socket.end()
					continue
				}
				if (op === 'execute') {
					// Admitted and never answered. The connection stays open, so
					// the failure a case is building has to come from somewhere
					// else — which is the point.
					if (executeHangs) continue
					if (losingExecutions || forgetsExecutions) {
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
					if (options.readFileError !== undefined) {
						send(socket, { ok: false, error: options.readFileError })
						socket.end()
						continue
					}
					const file = options.readFileContent
					if (file === undefined) {
						send(socket, { ok: true, content: Buffer.from('').toString('base64') })
						socket.end()
						continue
					}
					const range = (request.body ?? {}) as { offset?: number; length?: number }
					const from = range.offset ?? 0
					const whole = range.offset === undefined && range.length === undefined
					const slice = whole
						? file
						: file.subarray(from, range.length === undefined ? undefined : from + range.length)
					send(socket, {
						ok: true,
						content: slice.toString('base64'),
						// The WHOLE file, in both shapes — it is how a ranged
						// caller knows where the file ends.
						sizeBytes: file.length,
						encoding: 'base64',
						...(whole ? {} : { offset: from, bytesRead: slice.length }),
					})
					socket.end()
					continue
				}
				if (op === 'read-file-stream') {
					const file = options.readFileContent
					if (file === undefined) {
						send(socket, { type: 'error', error: 'read_file_stream_not_scripted' })
						terminate(socket)
						socket.end()
						continue
					}
					const range = (request.body ?? {}) as { offset?: number; length?: number }
					const from = range.offset ?? 0
					const slice = file.subarray(
						from,
						range.length === undefined ? undefined : from + range.length,
					)
					send(socket, {
						type: 'meta',
						sizeBytes: file.length,
						offset: from,
						length: slice.length,
					})
					// Deliberately more than one frame for anything that is not
					// tiny: a stream that arrives whole proves nothing about a
					// consumer that breaks partway.
					const chunkBytes = 8 * 1024
					for (let at = 0; at < slice.length; at += chunkBytes) {
						send(socket, {
							type: 'data',
							data: slice.subarray(at, at + chunkBytes).toString('base64'),
						})
					}
					send(socket, { type: 'end', bytesSent: slice.length })
					terminate(socket)
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
			retiring = false
		},
		setStdout: (next) => {
			stdout = next
		},
		setLosingExecutions: (next) => {
			losingExecutions = next
		},
		setForgetsExecutions: (next) => {
			forgetsExecutions = next
		},
		setExecuteHangs: (next) => {
			executeHangs = next
		},
		setHealthzRefusal: (next) => {
			healthzRefusal = next
		},
		setUnreachable: (next) => {
			unreachable = next
			if (!next) return
			for (const socket of open) socket.destroy()
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}
