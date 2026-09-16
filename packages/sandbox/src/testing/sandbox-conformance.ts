/**
 * The {@link Sandbox} contract, as a suite a backend author runs against
 * their own implementation.
 *
 * ## Why this exists
 *
 * `@namzu/sdk`'s `Sandbox` interface is the one thing every backend in this
 * package promises to implement the same way — `exec`'s exit codes, the
 * `AbortSignal` contract, a `writeFile`/`readFile` round trip, terminal
 * ownership on `destroy()` — and until now nothing PROVED that two backends
 * agreed on any of it. Each backend carried its own bespoke test file
 * (`sandbox-surface.test.ts`, `backend.test.ts`, …), written by whoever
 * built that backend, checking whatever that author thought to check. A
 * shared contract can be silently narrower than either file: this suite is
 * the thing that would have caught it.
 *
 * ## Why it takes its runner as an argument
 *
 * The same shape as `@namzu/sdk/testing`'s checkpoint-store and provider
 * driver suites, and for the same two reasons: `@namzu/sandbox` gains no
 * test dependency from publishing it, and a caller can pass a RECORDING
 * `describe`/`it` and run the whole contract as ordinary code — which is
 * how `testing/__tests__/conformance-fails-a-broken-sandbox.test.ts`
 * proves a deliberately wrong `Sandbox` fails it.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Contract behaviour only — never a backend-specific object, field or
 * error string. A case never inspects `sandbox.constructor.name`, never
 * matches an error message, and never assumes a particular
 * {@link SandboxEnvironment}. `openTerminal` and `openTcpConnection` are
 * OPTIONAL on {@link Sandbox} by the SDK's own contract — a backend that
 * cannot honour one must omit it rather than accept and ignore it — so a
 * factory whose sandbox omits either capability skips that section rather
 * than failing it. Every other section runs against every sandbox.
 *
 * ## Where it runs today
 *
 * Both `backends/kubernetes/__tests__/conformance.test.ts` and
 * `backends/firecracker/__tests__/conformance.test.ts` call this against a
 * real `agent/agent.cjs` on a loopback socket — proving the suite is
 * backend-agnostic rather than one backend's tests wearing a new name.
 * `packages/sandbox/k8s/scripts/contract-suite.mjs` runs it a third time,
 * against a live cluster.
 *
 * ## Not published from `@namzu/sandbox`'s entry point
 *
 * The package has no `testing` subpath today (unlike `@namzu/sdk`), and
 * this batch does not add one — promoting this to a public import path is
 * a deliberate, separate decision. Within the monorepo a caller imports it
 * by relative path, exactly as the two files above do:
 *
 * ```ts sketch
 * import { defineSandboxConformance } from '../../../testing/sandbox-conformance.js'
 *
 * defineSandboxConformance({
 *   describe, it, expect,
 *   label: 'my-backend',
 *   makeSandbox: async () => ({ sandbox: await myBackend.create(), dispose: async () => {} }),
 * })
 * ```
 */

import { createHash } from 'node:crypto'
import type {
	OpenTerminalOptions,
	Sandbox,
	SandboxTcpConnectOptions,
	TerminalSession,
} from '@namzu/sdk'

import type {
	ConformanceAssertion,
	ConformanceDescribe,
	ConformanceExpect,
	ConformanceIt,
} from '@namzu/sdk/testing'

/**
 * The contract revision these assertions express. Carried on the describe
 * label so a failure is legible on sight as "the sandbox contract", the
 * same convention `PROVIDER_DRIVER_CONTRACT_VERSION` uses — raised only
 * when a case is ADDED or TIGHTENED, never on a rewording.
 */
export const SANDBOX_CONTRACT_VERSION = 2

/** A sandbox to test, plus whatever teardown building it required. */
export interface SandboxConformanceHandle {
	readonly sandbox: Sandbox
	/**
	 * Called after each case, pass or fail — closes fixture servers, restores
	 * environment variables, removes temp directories. Distinct from
	 * `sandbox.destroy()`, which the suite calls itself (idempotently) as
	 * part of every case's teardown; `dispose` is for what `makeSandbox`
	 * itself stood up, not for the sandbox's own lifecycle.
	 */
	dispose?(): void | Promise<void>
}

/**
 * Build one fresh {@link Sandbox}. Called once per case, so no case can be
 * affected by another's writes, aborts or destroys — the suite never
 * assumes a shared instance and never reuses one across cases.
 */
export type MakeSandbox = () => SandboxConformanceHandle | Promise<SandboxConformanceHandle>

export interface SandboxConformanceOptions {
	readonly describe: ConformanceDescribe
	readonly it: ConformanceIt
	readonly expect: ConformanceExpect
	readonly makeSandbox: MakeSandbox
	/** Names the backend in test output. Defaults to `sandbox`. */
	readonly label?: string
	/**
	 * Whether this backend's guest can run the `openTcpConnection` positive
	 * case's listener at all — by default {@link nodeGuestListener}, `node
	 * -e`. Defaults to `true`: every backend this suite ships against runs
	 * `agent/agent.cjs` in the guest, and that agent IS node, so node on the
	 * guest's own `PATH` is a precondition of the agent existing rather than
	 * an extra capability this suite demands.
	 *
	 * Set `false` for a guest that cannot run a listener this way at all
	 * (no `openTerminal`, or an image with neither node nor a substitute) —
	 * the case then SKIPS, its own title stating why, rather than failing a
	 * backend for a capability its contract never promised. A backend that
	 * can run *some* listener, just not node, keeps this `true` (or omits
	 * it) and supplies {@link SandboxConformanceOptions.guestListenerCommand}
	 * instead.
	 */
	readonly guestCanRunNode?: boolean
	/**
	 * Overrides the program the `openTcpConnection` positive case starts
	 * inside the guest. Defaults to {@link nodeGuestListener}. A guest
	 * without node but with, say, busybox `nc` can supply its own command as
	 * long as it reports the bound port the way
	 * {@link GuestListenerCommand.parsePort} expects.
	 */
	readonly guestListenerCommand?: () => GuestListenerCommand
}

/** Assert `call()` rejects. The contract cares that admission was refused, never the message. */
async function expectRejects(
	expect: ConformanceExpect,
	call: () => Promise<unknown>,
): Promise<void> {
	let rejected = false
	try {
		await call()
	} catch {
		rejected = true
	}
	expect(rejected).toBe(true)
}

/** Assert `call()` resolves — the inverse check, for the rare case a rejection is the defect. */
async function expectResolves(
	expect: ConformanceExpect,
	call: () => Promise<unknown>,
): Promise<void> {
	let threw: unknown
	try {
		await call()
	} catch (error) {
		threw = error
	}
	expect(threw === undefined).toBe(true)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `size` bytes of deterministic pseudo-random content (xorshift32 from a
 * fixed seed).
 *
 * Pseudo-random rather than a repeated byte because the large-body case
 * below is about whether every byte survived in the right ORDER: a body of
 * one repeated value passes a length check and a content check even if the
 * transport shipped its pieces out of order, duplicated one, or dropped
 * one and padded. Deterministic rather than `randomBytes` so a failure is
 * reproducible from the size alone.
 */
function deterministicBytes(size: number): Buffer {
	const out = Buffer.allocUnsafe(size)
	let x = 0x9e3779b9
	for (let i = 0; i < size; i += 1) {
		x ^= x << 13
		x >>>= 0
		x ^= x >> 17
		x ^= x << 5
		x >>>= 0
		out[i] = x & 0xff
	}
	return out
}

/** `sha256` of a buffer, hex — a byte-exact comparison that prints short. */
function digest(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex')
}

/**
 * A program the `openTcpConnection` positive case can start INSIDE a guest
 * through {@link Sandbox.openTerminal}, and dial back into over
 * `openTcpConnection` itself.
 *
 * Starting the listener in the guest — rather than in the orchestrator/test
 * process, which is what this case used to do — is the whole point: a
 * listener on the HOST'S loopback only ever proves anything for a backend
 * whose "guest" happens to share that loopback (a Firecracker fixture over a
 * local socket, a fake-agent-in-this-process kubernetes test). It never
 * proves anything for a real remote guest, which cannot dial the
 * orchestrator's loopback at all — that gap is exactly what let the case
 * pass in every colocated fixture and fail the one time it ran against a
 * live cluster.
 */
export interface GuestListenerCommand {
	/** The program `openTerminal` runs as the session's top-level process. */
	readonly command: string
	readonly args: readonly string[]
	/**
	 * Reads the port the listener bound out of everything it has printed to
	 * its terminal so far. Returns `undefined` until the listener has
	 * reported one — the suite polls this as output arrives rather than
	 * parsing a single chunk, because a pty may deliver the report split
	 * across reads.
	 */
	parsePort(output: string): number | undefined
}

/** What {@link nodeGuestListener} has its script print once it is bound. */
const NODE_LISTENER_MARKER = 'namzu-conformance-listening:'

/**
 * The default {@link GuestListenerCommand}: `node -e` binding an ephemeral
 * port on the GUEST's own loopback, echoing `conformance-reply:<payload>`
 * back for the first chunk of the one connection it accepts, then reporting
 * the bound port on its own stdout — the only way the host, which cannot
 * inspect a real remote guest's open ports any other way, learns which port
 * to dial.
 *
 * Every backend this suite ships against runs `agent/agent.cjs` in the
 * guest, which is itself node — so node on the guest's `PATH` is not an
 * extra requirement this suite invents, it is a precondition of the agent
 * existing at all. A backend whose guest genuinely cannot run node (or
 * cannot run `openTerminal`) declares that through
 * {@link SandboxConformanceOptions.guestCanRunNode} or supplies its own
 * command via {@link SandboxConformanceOptions.guestListenerCommand}.
 */
export function nodeGuestListener(): GuestListenerCommand {
	const script = [
		"const net = require('node:net');",
		'const server = net.createServer((socket) => {',
		"  socket.once('data', (chunk) => {",
		"    socket.end(Buffer.concat([Buffer.from('conformance-reply:'), chunk]));",
		'  });',
		'});',
		"server.listen(0, '127.0.0.1', () => {",
		`  process.stdout.write(${JSON.stringify(NODE_LISTENER_MARKER)} + server.address().port + '\\n');`,
		'});',
	].join('\n')
	return {
		command: 'node',
		args: ['-e', script],
		parsePort(output) {
			const marker = output.indexOf(NODE_LISTENER_MARKER)
			if (marker === -1) return undefined
			const match = /\d+/.exec(output.slice(marker + NODE_LISTENER_MARKER.length))
			return match ? Number(match[0]) : undefined
		},
	}
}

/**
 * Start `listener` through `openTerminal`, and resolve once it has reported
 * the port it bound.
 *
 * The returned `stop()` kills the terminal's owned process tree — the exact
 * ownership guarantee the `openTerminal` section above already proves
 * `destroy()` gets for free, used here to tear the listener down without
 * waiting for the whole sandbox to go away.
 *
 * Takes `openTerminal` as a plain function rather than a `Sandbox`, so a
 * unit test can exercise the port-parsing and exit-races above without a
 * `Sandbox` fixture — see `__tests__/guest-listener.test.ts`.
 */
export async function startGuestListener(
	openTerminal: (options: OpenTerminalOptions) => Promise<TerminalSession>,
	listener: GuestListenerCommand,
): Promise<{ readonly port: number; stop(): Promise<void> }> {
	const terminal = await openTerminal({
		command: listener.command,
		args: listener.args,
		size: { cols: 80, rows: 24 },
	})

	let output = ''
	const port = await new Promise<number>((resolve, reject) => {
		const unsubscribe = terminal.onData((chunk) => {
			output += chunk
			const found = listener.parsePort(output)
			if (found !== undefined) {
				unsubscribe()
				resolve(found)
			}
		})
		void terminal.exited.then((result) => {
			// A settled promise ignores a later resolve/reject, so this is a
			// no-op on the path where the port was already found and `stop()`
			// is what causes this exit — it only fires the rejection when the
			// listener died before ever reporting a port.
			if (listener.parsePort(output) === undefined) {
				unsubscribe()
				reject(
					new Error(
						`guest listener exited before reporting a port (exit code ${result.exitCode}): ${
							output || '<no output>'
						}`,
					),
				)
			}
		})
	})

	return {
		port,
		async stop() {
			terminal.kill()
			await terminal.exited.catch(() => {})
		},
	}
}

/**
 * Register the {@link Sandbox} contract against one backend.
 *
 * Call it once per backend. It registers cases through the supplied
 * `describe`/`it`; it does not run them.
 */
export function defineSandboxConformance(options: SandboxConformanceOptions): void {
	const { describe, it, expect, makeSandbox } = options
	const label = options.label ?? 'sandbox'
	const guestCanRunNode = options.guestCanRunNode ?? true
	const guestListenerCommand = options.guestListenerCommand ?? nodeGuestListener

	/**
	 * Run `body` against a sandbox built for this case alone.
	 *
	 * Destroys the sandbox itself (idempotent, so a body that already
	 * destroyed it costs nothing extra) before calling `dispose`, so a
	 * case that forgets to release a pod/microVM does not leak one — the
	 * same reasoning `withStore`'s `finally` states for a leaked temp
	 * directory: a suite that is expensive to run red is a suite people
	 * stop running.
	 */
	const withSandbox = (body: (sandbox: Sandbox) => Promise<void>) => async () => {
		const handle = await makeSandbox()
		try {
			await body(handle.sandbox)
		} finally {
			await handle.sandbox.destroy().catch(() => {})
			await handle.dispose?.()
		}
	}

	describe(`${label} — sandbox contract v${SANDBOX_CONTRACT_VERSION}`, () => {
		describe('exec', () => {
			it(
				'reports the exit code and streams stdout/stderr as the command runs',
				withSandbox(async (sandbox) => {
					const chunks: { stream: string; data: string }[] = []
					const result = await sandbox.exec(
						'/bin/sh',
						['-c', 'echo conformance-out; echo conformance-err 1>&2; exit 7'],
						{ onOutput: (chunk) => chunks.push({ ...chunk }) },
					)

					expect(result.exitCode).toBe(7)
					expect(result.timedOut).toBe(false)
					expect(result.stdout).toMatch(/conformance-out/)
					expect(result.stderr).toMatch(/conformance-err/)
					// Streamed, not just present in the final string: a backend
					// that buffers everything until exit and calls `onOutput`
					// once at the end would satisfy the two checks above and
					// fail this one.
					expect(
						chunks.some((c) => c.stream === 'stdout' && c.data.includes('conformance-out')),
					).toBe(true)
					expect(
						chunks.some((c) => c.stream === 'stderr' && c.data.includes('conformance-err')),
					).toBe(true)
				}),
			)

			it(
				'reports busy while a command is in flight and ready once it settles',
				withSandbox(async (sandbox) => {
					let observedBusy = false
					await sandbox.exec('/bin/sh', ['-c', 'echo started; sleep 0.2'], {
						onOutput: (chunk) => {
							if (chunk.data.includes('started')) observedBusy = sandbox.status === 'busy'
						},
					})
					expect(observedBusy).toBe(true)
					expect(sandbox.status).toBe('ready')
				}),
			)

			it(
				'honours an AbortSignal: the process is really terminated, never a partial success',
				withSandbox(async (sandbox) => {
					// The contract (`SandboxExecOptions.signal`'s own doc comment):
					// a backend that accepts the signal must terminate the process
					// it owns, or prove admission never happened; it must never
					// silently ignore the signal and let the command run to
					// completion while reporting as though it had been cancelled.
					// The command below writes a marker file a moment after
					// printing "ready" — if the process is genuinely killed on
					// abort, that write never happens. That is the decisive
					// check; whatever the settled promise looks like is a second,
					// weaker one.
					const marker = 'conformance-abort-marker.txt'
					const caller = new AbortController()
					let signalReady: (() => void) | undefined
					const ready = new Promise<void>((resolve) => {
						signalReady = resolve
					})

					const running = sandbox.exec(
						'/bin/sh',
						[
							'-c',
							`trap '' TERM; (trap '' TERM; sleep 0.4; printf late > ${marker}) & echo ready; wait`,
						],
						{
							signal: caller.signal,
							onOutput: (chunk) => {
								if (chunk.stream === 'stdout' && chunk.data.includes('ready')) signalReady?.()
							},
						},
					)
					await ready
					caller.abort(new Error('conformance suite cancelled this command'))

					// Resolve OR reject are both compliant — a backend that cannot
					// confirm the kill may refuse instead of reporting a result it
					// is not sure of. What is never compliant is reporting a clean,
					// unaborted-looking success.
					let settled: { exitCode: number; signal?: string } | undefined
					try {
						settled = await running
					} catch {
						settled = undefined
					}
					if (settled !== undefined) {
						expect(settled.exitCode === 0 && settled.signal === undefined).toBe(false)
					}

					// Long enough that an un-killed process would have finished its
					// sleep and written the file.
					await sleep(900)
					await expectRejects(expect, () => sandbox.readFile(marker))
				}),
			)
		})

		describe('file IO', () => {
			it(
				'round-trips a UTF-8 string through writeFile/readFile',
				withSandbox(async (sandbox) => {
					await sandbox.writeFile('conformance-notes.txt', 'héllo wörld')
					const read = await sandbox.readFile('conformance-notes.txt')
					expect(read.toString('utf8')).toBe('héllo wörld')
				}),
			)

			it(
				'round-trips arbitrary binary content byte for byte',
				withSandbox(async (sandbox) => {
					const payload = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x42, 0xfe, 0x7f, 0x80, 0x01])
					await sandbox.writeFile('nested/conformance/blob.bin', payload)
					const read = await sandbox.readFile('nested/conformance/blob.bin')
					// Compared as base64 rather than through a deep-equality
					// matcher: the four matchers this suite is allowed to assume
					// (`toBe`/`toEqual`/`toBeGreaterThan`/`toMatch`) do not
					// guarantee byte-exact `Buffer` comparison across every
					// runner a caller might wire in, and a corrupted byte belongs
					// in the string this failure prints.
					expect(read.toString('base64')).toBe(payload.toString('base64'))
				}),
			)

			/**
			 * A body too large to cross the wire in ONE message.
			 *
			 * 7 MiB is chosen against a real number rather than a round one:
			 * a `write-file` body travels base64-encoded inside the request
			 * envelope, so 7 MiB of content is ~9.3 MiB of frame — past the
			 * 8 MiB ceiling the guest agent enforces on an unauthenticated
			 * connection's first frame, which on a transport that dials
			 * fresh per call is EVERY frame. That ceiling used to make this
			 * case a documented refusal on the kubernetes backend while the
			 * host-local backends served it without noticing, which is
			 * exactly the shape of divergence a contract suite exists to
			 * catch: `Sandbox.writeFile` promises to write a file, and a
			 * caller seeding a repository archive into a workspace cannot
			 * be told that the promise holds below a number nothing in the
			 * interface names.
			 *
			 * Compared by digest, not by content: a mismatch here belongs in
			 * the failure message as a short string, and 7 MiB of base64
			 * does not.
			 */
			it(
				'round-trips a body larger than one wire frame',
				withSandbox(async (sandbox) => {
					const payload = deterministicBytes(7 * 1024 * 1024)
					await sandbox.writeFile('conformance-large/archive.bin', payload)
					const read = await sandbox.readFile('conformance-large/archive.bin')
					expect(read.length).toBe(payload.length)
					expect(digest(read)).toBe(digest(payload))
				}),
			)
		})

		describe('listFiles', () => {
			it(
				'lists written files as absolute paths with their sizes',
				withSandbox(async (sandbox) => {
					const contentA = '123456789'
					const contentB = '42 bytes worth of fixed content!!'
					await sandbox.writeFile('conformance-list/a.txt', contentA)
					await sandbox.writeFile('conformance-list/b.txt', contentB)
					const dir = `${sandbox.rootDir}/conformance-list`
					const files = await sandbox.listFiles(dir)
					const byPath = new Map(files.map((f) => [f.path, f.size]))
					expect(byPath.get(`${dir}/a.txt`)).toBe(Buffer.byteLength(contentA))
					expect(byPath.get(`${dir}/b.txt`)).toBe(Buffer.byteLength(contentB))
				}),
			)

			it(
				'reports a root that does not exist as empty rather than failing',
				withSandbox(async (sandbox) => {
					const files = await sandbox.listFiles(`${sandbox.rootDir}/conformance-never-created`)
					expect(files.length).toBe(0)
				}),
			)
		})

		/**
		 * Optional on {@link Sandbox} by the SDK's own contract: a backend that
		 * cannot provide a real pseudo-terminal must OMIT the method rather
		 * than hand back a pipe masquerading as one. So a factory whose
		 * sandbox has no `openTerminal` is not in violation of anything — the
		 * case below passes vacuously for it, which is the documented
		 * skip-if-unavailable this suite promises rather than a silent hole:
		 * both shipped backends (kubernetes, firecracker) DO implement it, so
		 * in CI this case only ever runs vacuously against a fixture that
		 * deliberately declines the capability.
		 */
		describe('openTerminal', () => {
			it(
				'is owned by the sandbox: destroy() kills and awaits every terminal it returned',
				withSandbox(async (sandbox) => {
					if (!sandbox.openTerminal) return

					const terminal = await sandbox.openTerminal({
						command: '/bin/sh',
						args: ['-c', 'sleep 30'],
						size: { cols: 80, rows: 24 },
					})

					let exited = false
					void terminal.exited.then(() => {
						exited = true
					})

					await sandbox.destroy()
					// Nothing awaited in between: awaiting `terminal.exited` here
					// would rescue a `destroy()` that only fired the kill and
					// returned without waiting for it, which is exactly the
					// defect this case exists to catch.
					expect(exited).toBe(true)
					await terminal.exited
				}),
			)
		})

		/**
		 * Same optionality and the same documented skip as `openTerminal`,
		 * above: a factory whose sandbox has no `openTcpConnection` passes
		 * vacuously. The positive case below adds a second, independent skip
		 * axis on top of that — see `guestCanRunNode` and
		 * `guestListenerCommand` on {@link SandboxConformanceOptions} — because
		 * proving the forward really crosses into a REMOTE guest needs a
		 * listener running there, and not every guest can start one the same
		 * way.
		 */
		describe('openTcpConnection', () => {
			// The reason for a title, rather than a console message, printing
			// the skip: `ConformanceIt` promises only `(name, body) => unknown`
			// (`contract-suite.mjs`'s own flat recorder has no skip concept
			// either), so the one channel a skip can travel through every
			// runner this suite is ever handed is the case's own name — decided
			// once, here, from options given synchronously to
			// `defineSandboxConformance`, not from anything discovered at run
			// time.
			const positiveCaseTitle = guestCanRunNode
				? 'forwards a bidirectional stream to a service started inside the guest'
				: 'forwards a bidirectional stream to a service started inside the guest (skipped: guestCanRunNode is false)'

			it(
				positiveCaseTitle,
				withSandbox(async (sandbox) => {
					if (!sandbox.openTcpConnection) return
					if (!guestCanRunNode) return
					const openTerminal = sandbox.openTerminal
					if (!openTerminal) {
						// A backend offering `openTcpConnection` without
						// `openTerminal` has no portable way for this suite to
						// start a guest-side listener — declare the skip
						// explicitly (`guestCanRunNode: false`) rather than
						// leaving the default to discover it here as a failure.
						throw new Error(
							'openTcpConnection conformance: starting a guest-side listener needs openTerminal, ' +
								'which this sandbox does not implement. Pass guestCanRunNode: false to ' +
								'defineSandboxConformance to skip this case with a stated reason, or supply ' +
								'guestListenerCommand for a guest that can run a listener some other way.',
						)
					}

					// Called through `.call(sandbox, …)` rather than passed as
					// a bare reference: `openTerminal` may be an ordinary
					// method relying on `this` (a class-based fixture, for
					// instance), and detaching it from `sandbox` would drop
					// that binding.
					const listener = await startGuestListener(
						(terminalOptions) => openTerminal.call(sandbox, terminalOptions),
						guestListenerCommand(),
					)
					try {
						const connection = await sandbox.openTcpConnection({ port: listener.port })
						let received = ''
						const unsubscribe = connection.onData((chunk) => {
							received += Buffer.from(chunk).toString('utf8')
						})
						connection.write('conformance-hello')
						await connection.closed
						expect(received).toBe('conformance-reply:conformance-hello')
						unsubscribe()
					} finally {
						await listener.stop()
					}
				}),
			)

			it(
				'refuses a non-loopback host',
				withSandbox(async (sandbox) => {
					if (!sandbox.openTcpConnection) return

					// `SandboxTcpConnectOptions.host` types as loopback-only; the
					// cast is deliberate — this proves the refusal is enforced at
					// RUNTIME, not merely by the type checker a compliant caller
					// could route around with the same cast.
					const nonLoopback = {
						port: 9,
						host: '203.0.113.10',
					} as unknown as SandboxTcpConnectOptions
					await expectRejects(
						expect,
						() =>
							sandbox.openTcpConnection?.(nonLoopback) ?? Promise.reject(new Error('unreachable')),
					)
				}),
			)
		})

		describe('destroy', () => {
			it(
				'is idempotent, however many times or however concurrently it is called',
				withSandbox(async (sandbox) => {
					await Promise.all([sandbox.destroy(), sandbox.destroy()])
					expect(sandbox.status).toBe('destroyed')
					await expectResolves(expect, () => sandbox.destroy())
					expect(sandbox.status).toBe('destroyed')
				}),
			)

			it(
				'refuses every call once destroyed, rather than admitting one',
				withSandbox(async (sandbox) => {
					await sandbox.destroy()

					await expectRejects(expect, () => sandbox.exec('/bin/sh', ['-c', 'true']))
					await expectRejects(expect, () => sandbox.writeFile('x.txt', 'x'))
					await expectRejects(expect, () => sandbox.readFile('x.txt'))
					await expectRejects(expect, () => sandbox.listFiles(sandbox.rootDir))
					// `?.()` rather than an `if` guard around the assertion: it is
					// type-correct whether or not the capability exists, and when
					// it does not exist there is nothing to refuse — the
					// documented skip-if-unavailable this suite promises for
					// every optional capability.
					if (sandbox.openTerminal) {
						await expectRejects(
							expect,
							() =>
								sandbox.openTerminal?.({ size: { cols: 80, rows: 24 } }) ??
								Promise.reject(new Error('unreachable')),
						)
					}
					if (sandbox.openTcpConnection) {
						await expectRejects(
							expect,
							() =>
								sandbox.openTcpConnection?.({ port: 9 }) ??
								Promise.reject(new Error('unreachable')),
						)
					}
				}),
			)
		})
	})
}

// Re-exported so a caller building a recording harness (as this suite's own
// negative test does) can type it without reaching into `@namzu/sdk/testing`
// a second time.
export type { ConformanceAssertion, ConformanceDescribe, ConformanceExpect, ConformanceIt }
