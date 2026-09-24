/**
 * @namzu/sandbox container-backend worker.
 *
 * Lives inside the per-task Docker container; talks HTTP on
 * loopback to the host-side `DockerSandboxBackend` adapter. The
 * host spawns one container per `Sandbox` instance and tears it
 * down on `destroy()`.
 *
 * Why HTTP and not stdin/stdout: a long-running container with a
 * stable HTTP surface lets the host issue many `exec` /
 * `read-file` / `write-file` calls per task without spawning a
 * new container for each (cold-start kills latency). namzu's
 * protocol is deliberately minimal because the namzu backend is
 * trusted-tenant by default. (For adversarial multi-tenant the
 * host picks the `microvm` tier instead.)
 *
 * Endpoints:
 *   GET  /healthz       — exact-protocol readiness probe.
 *   POST /execute       — run a command inside the workspace.
 *                         body: { executionId?, command, args, cwd, env, stdin,
 *                                 timeoutMs, maxOutputBytes }
 *                         response: NDJSON stream of
 *                                 { type: 'stdout_delta'|'stderr_delta'
 *                                       |'result'|'error', ... }
 *   POST /executions/reserve
 *                       — reserve an inert, expiring execution lease.
 *                         response: { ok, executionId, leaseExpiresAt }
 *   POST /cancel        — cancel one reserved or running execution.
 *                         body: { executionId }
 *                         a successful response is sent only after terminal
 *                         state is known; an unconfirmed stop retires worker.
 *   POST /read-file     — read a file from the workspace.
 *                         body: { path, encoding? }
 *                         response: { ok, content, sizeBytes }
 *   POST /write-file    — write a file inside the workspace.
 *                         body: { path, content, encoding? }
 *                         response: { ok, bytesWritten }
 *
 * Authn: `Authorization: Bearer <token>` on every route but `/healthz`,
 * where the token is `NAMZU_SANDBOX_TOKEN` — minted per instance by
 * whoever starts this worker, read here at startup, never baked into an
 * image, never written to disk, and dead with the container. Absent or
 * wrong is a `401` with the reason and nothing else; the request never
 * reaches a handler. The variable carries `WORKER_CONFIG_PREFIX`, which is
 * what keeps it out of every command the sandbox runs — see
 * {@link childEnvironment}.
 *
 * A worker with no token is only allowed to LISTEN if it is bound to
 * loopback; on anything routable it refuses to start. It listens on every
 * interface by default and has to, for the reasons recorded at the `BIND`
 * constant — which is exactly why the credential rather than the bind
 * address is what makes the default defensible.
 *
 * This paragraph used to say the worker "only listens on loopback" and,
 * later, that authn was "none" and the network the container sits on was
 * the only boundary. The first was false ten lines from a comment that
 * said so correctly, which is how a reader who found the true half stopped
 * looking. The second was true and no longer is. What is still true and
 * worth saying: the transport is plain HTTP, so this is a bearer token —
 * replayable by anything on the path — and network placement remains the
 * boundary it defends BEHIND, not something it replaces. The egress proxy
 * still checks nothing inbound of any kind; it stamps credentials on the
 * way out and has no opinion about what comes back.
 */

const http = require('node:http')
const { spawn } = require('node:child_process')
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const REMOTE_EXECUTION_PROTOCOL_VERSION = 2

/**
 * Prefix every variable this worker reads its own configuration from.
 *
 * Load-bearing: {@link childEnvironment} strips it, so the prefix is the
 * boundary between "the worker's configuration" and "the environment the
 * sandbox is supposed to run commands in". A new setting that does not use
 * it is handed to untrusted code automatically.
 */
const WORKER_CONFIG_PREFIX = 'NAMZU_SANDBOX_'

const PORT = Number(process.env.NAMZU_SANDBOX_PORT || 2024)
// Bind address picks `0.0.0.0` by default so a sibling container
// (a host app talking to a sandbox spawned via docker.sock on
// the same host) can reach the worker over a docker bridge network.
// Overridable via `NAMZU_SANDBOX_BIND` for the dev case where the
// SDK consumer runs on the docker host itself and prefers loopback.
//
// Narrowing this default is not the fix and was measured as a
// regression: a published container port translates to the container's
// bridge address, so a worker bound to the container's own loopback is
// unreachable through it. The container backend's reachability modes
// both need a non-loopback bind. What makes an every-interface listener
// defensible is the credential every route but `/healthz` requires and
// the refusal below when there is none — not the network placement alone,
// which is a property of the deployment rather than of this file.
const BIND = process.env.NAMZU_SANDBOX_BIND || '0.0.0.0'

/**
 * The per-instance credential, and the one escape from requiring it.
 *
 * `NAMZU_SANDBOX_TOKEN` is minted by whoever starts this worker — the
 * container backend at `docker run` time — and handed over in the
 * environment, which is the only channel this process can READ from. That
 * it is minted per instance rather than baked into the image is the whole
 * point: an image-level secret is shared by every container ever built
 * from it, readable by anything that can pull the image, and rotated by
 * rebuilding and redeploying every deployment.
 *
 * A worker the host did NOT start — a warm pool claimed by address — has
 * no such channel and must be provisioned with the token by whoever builds
 * the profile or image it comes from. That is a real gap, not a hand-wave:
 * see `docs/sdk/container-sandbox-worker.md`.
 *
 * Presence and contents are read separately on purpose. `= ""` is
 * REFUSED at startup in every mode, because that is the shape an injected
 * secret takes when it resolved to nothing — honouring it would open
 * exactly the hole the variable exists to close. (The microVM guest agent
 * refuses the same value for the same reason at its own startup.) So is
 * any value that differs from its own trim, for a subtler version of the
 * same reason: the presentation path reads the token out of a trimmed
 * header, so a padded value can never be presented and would leave the
 * worker booted, authenticated and refusing every caller — including its
 * host — for the life of the container.
 */
const TOKEN_WAS_SET = Object.prototype.hasOwnProperty.call(process.env, 'NAMZU_SANDBOX_TOKEN')
const TOKEN = process.env.NAMZU_SANDBOX_TOKEN
const AUTH_ENABLED = TOKEN_WAS_SET && TOKEN !== '' && TOKEN === TOKEN.trim()
/**
 * The third way a token can be set and useless: one nobody can present.
 *
 * The credential travels as an HTTP header value, and a header value
 * carries ONE BYTE per character. Two mechanisms enforce that and both are
 * outside this process. The client's `fetch` throws `Cannot convert
 * argument to a ByteString` for any code point above U+00FF before the
 * request leaves the host, and the HTTP parser this server runs drops the
 * connection on the C0 controls it will not accept — everything below
 * U+0020 except HTAB, plus DEL. Either way the worker boots authenticated
 * and refuses every caller including its host, for the life of the
 * container: the same failure the padded value above is refused for, from
 * the other end of the same header.
 *
 * The set below is therefore exactly what survives the round trip, mapped
 * rather than guessed: HTAB, printable ASCII, and U+0080–U+00FF, which
 * both sides carry as latin-1. Anything else is refused at startup, where
 * the reason can still be read.
 */
const TOKEN_IS_PRESENTABLE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/.test(TOKEN ?? '')
/**
 * The explicit escape from the refusal below, and what it gives up.
 *
 * Set `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` and a worker with no token
 * will listen on a routable address, which is the pre-token behaviour and
 * is unauthenticated `execute` for whoever can route to it. It exists so
 * that an existing deployment keeps working while it is provisioned with a
 * credential, and it is named rather than implied so that accepting the
 * exposure is a decision someone made on purpose.
 *
 * A configured token WINS over this flag: the escape can only mean "serve
 * without a credential", never "ignore the one I was given".
 *
 * Presence of the variable is not enough — `= 0` and `= false` are read as
 * "not set", because a flag whose off-spelling turns it on is a trap. It is
 * matched UNTRIMMED for the same reason: `= " yes "` is someone's editor
 * adding a space to a value they meant to write, and a security escape that
 * accepts an unrecognised spelling is exactly the trap the sentence above
 * is about. An unrecognised value therefore fails CLOSED — the worker
 * refuses to start — and the refusal names this variable and the accepted
 * spellings.
 */
const ALLOW_UNAUTHENTICATED = ['1', 'true', 'yes', 'on'].includes(
	(process.env.NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED || '').toLowerCase(),
)

/**
 * A bind address only this container's own loopback can reach.
 *
 * Deliberately a narrow allowlist rather than "anything that resolves
 * locally": `0.0.0.0` and `::` reach every interface and are what this
 * worker binds by default, which is the case the refusal exists for. An
 * address this predicate does not recognise is treated as routable, so a
 * spelling nobody thought of fails closed.
 */
function isLoopbackBind(bind) {
	const host = String(bind)
		.trim()
		.replace(/^\[|\]$/g, '')
		.toLowerCase()
	return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function refuseToStart(reason) {
	console.error(`[namzu-sandbox-worker] refusing to start: ${reason}`)
	process.exit(1)
}

/**
 * The startup decision, taken before a socket exists.
 *
 * Two asymmetries, both deliberate:
 *
 *  - No token on LOOPBACK may start. Nothing outside this container's
 *    network namespace can open that socket — inside the container the
 *    only listener is this one, and the host reaches it through Docker's
 *    port-forward, which is a different address. The exposure this issue
 *    is about is a routable listener, and a loopback bind is not one, so
 *    refusing here would break the dev case (a host running the SDK
 *    beside the docker host) without closing anything.
 *  - No token on anything ROUTABLE refuses. That is the default bind, so
 *    this is where the honest default costs something: a deployment that
 *    has not been given a credential stops working rather than continuing
 *    to run unauthenticated. The escape above is how it keeps working on
 *    purpose.
 */
function assertListenableConfiguration() {
	// A token that was SET but cannot be used is refused before the bind
	// address is considered: `""` is the empty injection, a padded value is
	// one the trimmed header can never match, and a value outside what a
	// header can carry is one no client can send at all.
	if (TOKEN_WAS_SET && !AUTH_ENABLED) {
		refuseToStart(
			'NAMZU_SANDBOX_TOKEN is set but is empty after trimming, or carries leading or trailing whitespace. An empty value is the shape a per-instance secret takes when the injection that was supposed to supply it resolved to nothing, and honouring it would open exactly the hole the variable exists to close. A PADDED value is refused for the other half of the same reason: the token is read out of a trimmed `Authorization` header, so a value with whitespace around it can never be presented, and this worker would boot authenticated and refuse every caller including its host until the container is gone. Set it to a per-instance value with no surrounding whitespace, or leave it unset entirely and let the bind-address rule below decide.',
		)
	}
	if (TOKEN_WAS_SET && !TOKEN_IS_PRESENTABLE) {
		refuseToStart(
			'NAMZU_SANDBOX_TOKEN carries a character that cannot be presented in an HTTP header value. A header carries one byte per character, so a code point above U+00FF is refused by the client before the request leaves it (`fetch` rejects it as a ByteString conversion), and a C0 control other than HTAB, or DEL, is refused by the HTTP parser on this side — the connection is dropped before the router sees it. Either way the token would be unanswerable: this worker would boot authenticated and refuse every caller including its host until the container is gone, which is the failure the padded-value refusal above exists to prevent and this is the same failure one rung further out. Mint the token from random bytes encoded as base64url (or any ASCII), which is what the container backend does.',
		)
	}
	if (AUTH_ENABLED) return
	if (isLoopbackBind(BIND)) return
	if (ALLOW_UNAUTHENTICATED) return
	refuseToStart(
		`no NAMZU_SANDBOX_TOKEN is configured and NAMZU_SANDBOX_BIND=${BIND} would accept connections from anything that can route to this container, where every route but /healthz runs a command, reads a file, or writes a file on the caller's behalf with no credential of any kind. Set NAMZU_SANDBOX_TOKEN to a per-instance secret (the starter of this container mints one; a worker from a warm pool must be provisioned with one) and present it as \`Authorization: Bearer <token>\`; or bind 127.0.0.1 if only this container can be the caller; or set NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1 (exactly that spelling: 1, true, yes or on, in any case, with no surrounding whitespace) to serve unauthenticated on a routable address, which gives up the credential entirely rather than deferring it.`,
	)
}

/**
 * The digest compared against, precomputed once.
 *
 * Comparing fixed-width digests rather than the strings means the
 * comparison is constant-time whatever the presented length and that
 * `timingSafeEqual` cannot throw on a length mismatch — so neither the
 * token's value nor its length is learnable by probing.
 */
function digest(value) {
	return createHash('sha256').update(value).digest()
}

const TOKEN_DIGEST = AUTH_ENABLED ? digest(TOKEN) : undefined

/** The bearer token a request presents, or `undefined` if it presents none. */
function presentedToken(req) {
	const header = req.headers.authorization
	if (typeof header !== 'string') return undefined
	const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
	return match ? match[1] : undefined
}

function isAuthorized(req) {
	if (!AUTH_ENABLED) return true
	const presented = presentedToken(req)
	if (presented === undefined) return false
	return timingSafeEqual(TOKEN_DIGEST, digest(presented))
}

const WORKSPACE_ROOT = process.env.NAMZU_SANDBOX_WORKSPACE || '/workspace'
const READ_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_READ_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
// Writable roots: WORKSPACE_ROOT is always writable; NAMZU_SANDBOX_WRITE_ROOTS
// adds extra RW mounts (e.g. `/mnt/user-data/outputs`, `/mnt/user-data/scratch`)
// so the agent's `write`/`append` tools can land in the sibling mounts the
// host chose, not just inside `/workspace`. This must be a strict subset of
// READ_ROOTS or read-only mounts (uploads, skills) would silently become
// writable.
const WRITE_ROOTS = normalizeRoots(
	[WORKSPACE_ROOT, ...(process.env.NAMZU_SANDBOX_WRITE_ROOTS || '').split(path.delimiter)].filter(
		Boolean,
	),
)
const MAX_BODY_BYTES = Number(process.env.NAMZU_SANDBOX_MAX_BODY_BYTES || 8 * 1024 * 1024)
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
// Ceiling on the caller-supplied `timeoutMs`. `/execute`'s `timeoutMs` sets
// how long the spawned child (and the container resources it holds — CPU,
// memory, the open NDJSON response) stays alive; upstream this value comes
// straight from the `bash` tool's `timeout` argument, a model-chosen number
// with no cap of its own (see `resolveTimeoutMs` in the firecracker guest
// agent, `agent/agent.cjs`, which guards the same unbounded value on that
// transport). Left unbounded here, a single call can pin a container for as
// long as Node's timer will honor (`setTimeout` clamps at ~24.8 days rather
// than firing early), which is a resource-exhaustion vector, not a
// convenience knob. A request above the cap is REFUSED, not quietly
// clamped: silently running under a different deadline than the caller
// asked for is the "accepted and not applied" shape this codebase treats
// as worse than never offering the control — the caller stops looking,
// and a timeout it believes it set is not the one in force.
const MAX_TIMEOUT_MS = Number(process.env.NAMZU_SANDBOX_MAX_TIMEOUT_MS || 30 * 60 * 1000)
// Cancellation is a second control request, not an aborted `/execute`
// transport. The worker owns a finite execution lease before it owns a
// process, then a finite TERM -> KILL confirmation window once it does.
// Unknown ids are never admitted by `/execute`, so no tombstone has to make
// an unbounded promise about a request that may arrive later.
const EXECUTION_LEASE_TTL_MS = Number(process.env.NAMZU_SANDBOX_EXECUTION_LEASE_TTL_MS || 30_000)
const EXECUTION_TERMINAL_TTL_MS = Number(
	process.env.NAMZU_SANDBOX_EXECUTION_TERMINAL_TTL_MS || 60_000,
)
const MAX_TRACKED_EXECUTIONS = Number(process.env.NAMZU_SANDBOX_MAX_TRACKED_EXECUTIONS || 1_024)
// `terminateAndConfirm` only escalates SIGTERM to SIGKILL when the owned
// process group is STILL alive at the end of this window — a group that
// goes quiet before then is read as "the signal worked," with no check
// that the signal was the reason. A command that ignores SIGTERM but
// happens to finish on its own before this elapses therefore runs to
// completion untouched, and is reported back as a clean, unaborted-looking
// result: exactly the outcome `SandboxExecOptions.signal`'s contract
// forbids ("must terminate the owned process ... never silently ignore the
// signal and let the command run to completion"). This was 2000ms until
// issue #469's kind conformance run caught the identical mechanism in
// `agent/agent.cjs` (the Firecracker/kubernetes guest agent this worker's
// spawn/jail/framing logic is deliberately kept parallel with) — every test
// in THIS file that drives this path shortens it (80ms, 700ms, ...) "so the
// abort case proves the kill in milliseconds, not the production window",
// which hid this default's own behaviour from every one of them exactly as
// it did on the other transport. Kept short enough to leave the shared
// SIGTERM-ignoring fixture (~400ms to finish on its own) a wide margin; a
// deployment that genuinely needs longer for cooperative cleanup sets
// `NAMZU_SANDBOX_CANCEL_GRACE_MS` explicitly.
const CANCEL_GRACE_MS = Number(process.env.NAMZU_SANDBOX_CANCEL_GRACE_MS || 250)
const CANCEL_CONFIRM_TIMEOUT_MS = Number(
	process.env.NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS || 5_000,
)
const POISON_EXIT_DELAY_MS = 50
const EXECUTION_ID_PATTERN = /^exec_[0-9a-f-]{36}$/
// Idle timeout: if the worker sees no `/execute`, `/read-file`, or
// `/write-file` request for this many ms, it `process.exit(0)`s. The
// container is spawned `--rm` so the daemon collects the corpse
// automatically; that's the cheap layer-2 defense against orphaned
// sandboxes when the host's TTL or the supervisor's `finally`
// block both fail. `0` disables.
//
// Default 5 min: a supervised agent's median tool-call → tool-call
// gap is well under a minute, so 5 min is a comfortable buffer that
// still bounds runaway lifetime to a single-digit-minute scale. Hosts
// that run longer interactive turns (heavy data-prep, slow LLMs)
// override via env.
const IDLE_TIMEOUT_MS = Number(process.env.NAMZU_SANDBOX_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000)

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let total = 0
		req.on('data', (chunk) => {
			total += chunk.length
			if (total > MAX_BODY_BYTES) {
				reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
			} catch (err) {
				reject(err)
			}
		})
		req.on('error', reject)
	})
}

function writeJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

/**
 * The one answer an unauthenticated caller gets.
 *
 * The body is the reason and nothing else — no "expected"/"got", no prefix
 * of either value, no length, no hint about which routes exist. The
 * `www-authenticate` header is the standard challenge and carries only the
 * scheme and a realm name.
 *
 * The request body is deliberately NOT read here. Nothing downstream can
 * act on it, and reading it would mean an unauthenticated peer could make
 * this process parse bytes and hold a lease. Node discards the remainder
 * of the request itself once the response is finished, and its own
 * `requestTimeout` bounds how long that may take.
 */
function writeUnauthorized(res) {
	res.setHeader('www-authenticate', 'Bearer realm="namzu-sandbox-worker"')
	writeJson(res, 401, { error: 'unauthorized' })
}

function writeEvent(res, event) {
	res.write(`${JSON.stringify(event)}\n`)
}

function resolveWithinWorkspace(p, base) {
	const resolved = path.resolve(base, p)
	const baseResolved = path.resolve(base)
	if (!resolved.startsWith(`${baseResolved}${path.sep}`) && resolved !== baseResolved) {
		throw new Error('path escapes the workspace')
	}
	return resolved
}

function normalizeRoots(roots) {
	const seen = new Set()
	const normalized = []
	for (const root of roots) {
		const trimmed = String(root || '').trim()
		if (!trimmed) continue
		const resolved = path.resolve(trimmed)
		if (seen.has(resolved)) continue
		seen.add(resolved)
		normalized.push(resolved)
	}
	return normalized
}

function isWithinRoot(resolved, root) {
	return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

function resolveReadablePath(p) {
	return resolveAgainstRoots(p, READ_ROOTS)
}

function resolveWritablePath(p) {
	return resolveAgainstRoots(p, WRITE_ROOTS)
}

function resolveAgainstRoots(p, roots) {
	if (!path.isAbsolute(p)) {
		return {
			target: resolveWithinWorkspace(p, WORKSPACE_ROOT),
			root: path.resolve(WORKSPACE_ROOT),
		}
	}
	const target = path.resolve(p)
	const root = roots.find((candidate) => isWithinRoot(target, candidate))
	if (!root) {
		throw new Error('path escapes the workspace')
	}
	return { target, root }
}

/**
 * After lexical resolution proves the requested path doesn't ESCAPE
 * `/workspace` via `..`, we still have to defend against symlinks
 * inside the workspace pointing OUTSIDE it (e.g. `/workspace/leak ->
 * /etc/passwd`). The lexical check only inspects the string; the
 * actual `fs.readFile` follows symlinks. Resolve via `realpath` and
 * verify the resolved target is still inside the workspace before
 * touching the file.
 *
 * For writes the parent directory's realpath is what matters — the
 * file itself may not exist yet, so realpath the parent and
 * reconstruct the final path. If the parent contains a symlink
 * jumping out of the workspace, this rejects the write.
 */
async function realpathWithinWorkspace(target, base) {
	const baseReal = await fs.realpath(path.resolve(base))
	let real
	try {
		real = await fs.realpath(target)
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			const parentReal = await fs.realpath(path.dirname(target))
			real = path.join(parentReal, path.basename(target))
		} else {
			throw err
		}
	}
	if (!real.startsWith(`${baseReal}${path.sep}`) && real !== baseReal) {
		throw new Error('symlink escapes the workspace')
	}
	return real
}

// Mirrors `resolveTimeoutMs` in `agent/agent.cjs` — same bound, same
// refusal, same unbounded upstream input, different transport. Throws so
// the caller learns its request was rejected; the handler turns that into
// a 400 beside `invalid_cwd`.
function resolveTimeoutMs(rawTimeoutMs) {
	const timeoutMs = rawTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeoutMs)
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be a finite number in (0, ${MAX_TIMEOUT_MS}]`)
	}
	return timeoutMs
}

/**
 * The environment a spawned command runs in.
 *
 * This used to be `{ ...process.env, ...body.env }`, which handed the
 * worker's ENTIRE environment to every command the agent runs — by
 * construction, on every call, visible in a bare `env` in any shell
 * transcript. That is a stronger exposure than "untrusted code could read
 * `/proc/self/environ` if it thought to": it is active propagation, and the
 * agent does not have to go looking.
 *
 * What rode along: `NAMZU_SANDBOX_WORKSPACE`, `_READ_ROOTS` and
 * `_WRITE_ROOTS` — the confinement layout itself, handed to the code being
 * confined — plus every other setting below. So the boundary announced its
 * own shape to the thing it was drawn around.
 *
 * Stripping by prefix rather than by an allowlist of known-safe names is
 * deliberate, and it is the difference between this working and this
 * breaking egress:
 *
 *  - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container ON
 *    PURPOSE, so that tooling inside routes through the egress boundary. An
 *    allowlist assembled from first principles drops them and every
 *    proxied workload silently stops being proxied — which would look
 *    exactly like the policy working.
 *  - A host's own `options.env` arrives on this same channel and is meant
 *    to reach commands. It is indistinguishable from the worker's config
 *    once both are in `process.env`; the prefix is the only thing that
 *    tells them apart.
 *
 * `body.env` is applied AFTER the strip and is not filtered. Inheritance is
 * implicit and gets the default; an explicit per-call value is a caller
 * deciding, including a caller that deliberately sets a prefixed name.
 */
function childEnvironment(requested) {
	const inherited = {}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(WORKER_CONFIG_PREFIX)) continue
		inherited[key] = process.env[key]
	}
	return { ...inherited, ...(requested || {}) }
}

/**
 * Execution ownership registry.
 *
 * A reservation is deliberately inert: losing its response can leak one
 * bounded map entry, never a process. `/execute` may transition ONLY a live
 * reservation, which is the admission barrier that makes cancel-before-start
 * sound without an immortal unknown-id tombstone.
 */
const executions = new Map()
let activeWorkCount = 0
let workerPoisoned = false

function acquireWorkerActivity() {
	let released = false
	activeWorkCount += 1
	disarmIdleTimer()
	return () => {
		if (released) return
		released = true
		activeWorkCount = Math.max(0, activeWorkCount - 1)
		if (activeWorkCount === 0) resetIdleTimer()
	}
}

async function whileWorkerActive(operation) {
	const release = acquireWorkerActivity()
	try {
		return await operation()
	} finally {
		release()
	}
}

function pruneExecutions(now = Date.now()) {
	for (const [executionId, execution] of executions) {
		if (
			(execution.state === 'reserved' || execution.state === 'terminal') &&
			execution.expiresAt <= now
		) {
			executions.delete(executionId)
		}
	}
}

function makeRoomForReservation() {
	if (executions.size < MAX_TRACKED_EXECUTIONS) return
	const terminal = [...executions.entries()]
		.filter(([, execution]) => execution.state === 'terminal')
		.sort(([, left], [, right]) => left.expiresAt - right.expiresAt)
	for (const [executionId] of terminal) {
		executions.delete(executionId)
		if (executions.size < MAX_TRACKED_EXECUTIONS) return
	}
}

function validateExecutionId(executionId) {
	return typeof executionId === 'string' && EXECUTION_ID_PATTERN.test(executionId)
}

function syntheticCancelledResult(start = Date.now()) {
	return {
		exitCode: 1,
		timedOut: false,
		durationMs: Math.max(0, Date.now() - start),
		stdoutTruncated: false,
		stderrTruncated: false,
	}
}

function rememberTerminal(execution, outcome, result, error) {
	execution.started = execution.started ?? Boolean(execution.child)
	execution.state = 'terminal'
	execution.outcome = outcome
	execution.result = result
	execution.error = error
	execution.expiresAt = Date.now() + EXECUTION_TERMINAL_TTL_MS
	execution.child = undefined
	execution.processGroupId = undefined
	execution.done = undefined
	execution.resolveDone = undefined
	execution.terminationPromise = undefined
}

function terminalPayload(execution) {
	return {
		ok: true,
		state: execution.outcome,
		started: execution.started === true,
		...(execution.result ? { result: execution.result } : {}),
		...(execution.error ? { error: execution.error } : {}),
	}
}

async function handleReserveExecution(_req, res) {
	pruneExecutions()
	makeRoomForReservation()
	if (executions.size >= MAX_TRACKED_EXECUTIONS) {
		writeJson(res, 503, {
			error: 'execution_capacity',
			message: `worker already tracks ${MAX_TRACKED_EXECUTIONS} execution leases`,
		})
		return
	}

	const executionId = `exec_${randomUUID()}`
	const leaseExpiresAt = Date.now() + EXECUTION_LEASE_TTL_MS
	executions.set(executionId, {
		executionId,
		state: 'reserved',
		expiresAt: leaseExpiresAt,
	})
	writeJson(res, 201, {
		ok: true,
		protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION,
		executionId,
		leaseExpiresAt,
	})
}

function processGroupAlive(processGroupId) {
	if (!processGroupId) return false
	if (process.platform === 'win32') return true
	try {
		process.kill(-processGroupId, 0)
		return true
	} catch (error) {
		if (error?.code === 'ESRCH') return false
		// EPERM still proves that the group exists. Any other result is not
		// evidence that it is gone, so keep waiting until the hard bound.
		return true
	}
}

function signalProcessGroup(execution, signal) {
	const processGroupId = execution.processGroupId
	if (!processGroupId || process.platform === 'win32') {
		try {
			execution.child?.kill(signal)
		} catch {}
		return
	}
	try {
		process.kill(-processGroupId, signal)
	} catch (error) {
		if (error?.code !== 'ESRCH') throw error
	}
}

function delay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
}

async function waitForGroupExit(processGroupId, deadlineAt) {
	while (processGroupAlive(processGroupId)) {
		const remaining = deadlineAt - Date.now()
		if (remaining <= 0) return false
		await delay(Math.min(25, remaining))
	}
	return true
}

async function waitForDone(execution, deadlineAt) {
	const remaining = deadlineAt - Date.now()
	if (remaining <= 0) throw new Error('execution close was not observed before the deadline')
	let timer
	try {
		return await Promise.race([
			execution.done,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('execution close was not observed before the deadline')),
					remaining,
				)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function terminateAndConfirm(execution, cause) {
	if (execution.state === 'terminal') return terminalPayload(execution)
	if (execution.state === 'exited') {
		// `exit` proves that the owned leader has gone; `close` may lag while
		// inherited stdio drains. Do not relabel a naturally completed command,
		// and do not signal a numeric process-group id after its leader exited.
		await waitForDone(execution, Date.now() + CANCEL_CONFIRM_TIMEOUT_MS)
		return terminalPayload(execution)
	}
	if (execution.state !== 'running') {
		throw new Error(`execution is not running (state=${execution.state})`)
	}
	if (execution.terminationCause === undefined) execution.terminationCause = cause

	const deadlineAt = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
	signalProcessGroup(execution, 'SIGTERM')
	const termDeadline = Math.min(deadlineAt, Date.now() + CANCEL_GRACE_MS)
	let groupGone = await waitForGroupExit(execution.processGroupId, termDeadline)
	if (!groupGone) {
		if (execution.state === 'exited') {
			throw new Error(
				`process group ${execution.processGroupId} outlived its leader during cancellation; refusing to signal a reusable numeric process-group id`,
			)
		}
		signalProcessGroup(execution, 'SIGKILL')
		groupGone = await waitForGroupExit(execution.processGroupId, deadlineAt)
	}
	if (!groupGone) {
		throw new Error(`process group ${execution.processGroupId} remained live after SIGKILL`)
	}

	await waitForDone(execution, deadlineAt)
	return terminalPayload(execution)
}

function ensureTermination(execution, cause) {
	if (!execution.terminationPromise) {
		execution.terminationPromise = terminateAndConfirm(execution, cause).catch((error) => {
			// A later idempotent cancel is allowed to retry observation/signalling.
			// Retaining a rejected promise would turn a lost first confirmation
			// into a permanent false negative even after the process has exited.
			execution.terminationPromise = undefined
			throw error
		})
	}
	return execution.terminationPromise
}

async function confirmExitedProcessGroup(execution) {
	if (!processGroupAlive(execution.processGroupId)) return
	if (execution.terminationCause !== undefined) {
		const groupGone = await waitForGroupExit(
			execution.processGroupId,
			Date.now() + CANCEL_CONFIRM_TIMEOUT_MS,
		)
		if (groupGone) return
	} else {
		// `close` and kernel process-table cleanup can be adjacent but not
		// perfectly simultaneous. Observe one short no-signal grace before
		// treating the surviving numeric group id as unsafe to reuse.
		await delay(25)
		if (!processGroupAlive(execution.processGroupId)) return
	}
	throw new Error(
		`process group ${execution.processGroupId} remained live after its leader exited; refusing to signal a reusable numeric process-group id`,
	)
}

function poisonWorker(error) {
	if (workerPoisoned) return
	workerPoisoned = true
	disarmIdleTimer()
	console.error(
		`[namzu-sandbox-worker] termination could not be confirmed; retiring worker: ${error instanceof Error ? error.message : String(error)}`,
	)
	try {
		server.close()
	} catch {}
	// This worker is the container's ownership boundary. If it cannot prove
	// that a command is gone, keeping the container reusable would allow an
	// unowned process to overlap the next call. Exiting PID 1 asks the runtime
	// to tear down the whole container and its remaining process namespace.
	setTimeout(() => process.exit(1), POISON_EXIT_DELAY_MS)
}

async function handleCancelExecution(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (error) {
		writeJson(res, 400, { error: 'invalid_body', message: error.message })
		return
	}
	if (!validateExecutionId(body.executionId)) {
		writeJson(res, 400, { error: 'invalid_execution_id' })
		return
	}

	pruneExecutions()
	const execution = executions.get(body.executionId)
	if (!execution) {
		writeJson(res, 404, { error: 'unknown_execution' })
		return
	}

	if (execution.state === 'reserved' || execution.state === 'starting') {
		const result = syntheticCancelledResult(execution.startedAt)
		rememberTerminal(execution, 'cancelled', result)
		writeJson(res, 200, terminalPayload(execution))
		return
	}
	if (execution.state === 'terminal') {
		writeJson(res, 200, terminalPayload(execution))
		return
	}

	try {
		writeJson(res, 200, await ensureTermination(execution, 'cancelled'))
	} catch (error) {
		writeJson(res, 504, {
			error: 'cancellation_unconfirmed',
			message: error instanceof Error ? error.message : String(error),
		})
		poisonWorker(error)
	}
}

async function handleExecute(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}

	if (!body.command || typeof body.command !== 'string') {
		writeJson(res, 400, { error: 'missing_command' })
		return
	}

	let trackedExecution
	if (body.executionId !== undefined) {
		if (!validateExecutionId(body.executionId)) {
			writeJson(res, 400, { error: 'invalid_execution_id' })
			return
		}
	}

	// Resolve `cwd` and pre-create it BEFORE we commit to the streaming
	// 200 NDJSON response: both calls can throw (`resolveWithinWorkspace`
	// rejects a host path that escapes the container workspace, and
	// `fs.mkdir` can fail for permission / EROFS / ENOSPC). Without this
	// guard the rejection bubbles out of the http callback, becomes an
	// unhandled promise rejection, and on Node ≥ 15 with the default
	// `unhandledRejection: throw` policy it terminates the worker
	// process. The container exits 1 (`--rm` GCs it), the host's next
	// `fetch` gets `UND_ERR_SOCKET` ("other side closed") and reports
	// it as the bare "fetch failed" real transcripts surfaced —
	// every subsequent tool call in the same supervisor.run() then
	// hits the same dead DNS name and looks like a sandbox-runtime bug
	// when the trigger was a single bad input on a single endpoint.
	let cwd
	try {
		cwd = body.cwd ? resolveWithinWorkspace(body.cwd, WORKSPACE_ROOT) : WORKSPACE_ROOT
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_cwd', message: err.message })
		return
	}
	let timeoutMs
	try {
		timeoutMs = resolveTimeoutMs(body.timeoutMs)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_timeout', message: err.message })
		return
	}
	const maxOutputBytes = Number(body.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES
	const start = Date.now()

	if (body.executionId !== undefined) {
		pruneExecutions()
		trackedExecution = executions.get(body.executionId)
		if (!trackedExecution) {
			writeJson(res, 404, { error: 'unknown_execution' })
			return
		}
		if (trackedExecution.state !== 'reserved') {
			writeJson(res, 409, {
				error: 'execution_not_reserved',
				state:
					trackedExecution.state === 'terminal' ? trackedExecution.outcome : trackedExecution.state,
			})
			return
		}
		// Validation above is synchronous, so this remains an atomic admission
		// transition. Invalid input leaves an expiring reservation rather than
		// manufacturing an immortal `starting` entry.
		trackedExecution.state = 'starting'
		trackedExecution.startedAt = start
		trackedExecution.expiresAt = undefined
	}

	try {
		await fs.mkdir(cwd, { recursive: true })
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeJson(res, 400, { error: 'mkdir_failed', message: err.message })
		return
	}
	if (trackedExecution?.state === 'terminal') {
		writeJson(res, 409, {
			error: 'execution_cancelled',
			state: trackedExecution.outcome,
		})
		return
	}

	let child
	try {
		child = spawn(body.command, Array.isArray(body.args) ? body.args : [], {
			cwd,
			env: childEnvironment(body.env),
			stdio: [body.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			// The worker owns the process group, not only the command's outer
			// wrapper. Cancellation can therefore address the wrapper and ordinary
			// descendants with the same signal. A descendant that deliberately
			// creates a new session is outside this narrower process-group claim.
			detached: process.platform !== 'win32',
		})
	} catch (err) {
		if (trackedExecution?.state === 'starting') {
			rememberTerminal(trackedExecution, 'failed', undefined, err.message)
		}
		writeJson(res, 400, { error: 'spawn_failed', message: err.message })
		return
	}

	res.writeHead(200, {
		'content-type': 'application/x-ndjson; charset=utf-8',
		'cache-control': 'no-store',
	})

	if (body.stdin !== undefined && child.stdin) {
		child.stdin.end(String(body.stdin))
	}

	const stdout = { chunks: [], bytes: 0, truncated: false }
	const stderr = { chunks: [], bytes: 0, truncated: false }
	let settled = false
	let resolveDone
	const done = new Promise((resolve) => {
		resolveDone = resolve
	})
	const execution = trackedExecution ?? { state: 'starting', startedAt: start }
	Object.assign(execution, {
		state: 'running',
		child,
		processGroupId: child.pid,
		done,
		resolveDone,
		terminationCause: undefined,
	})
	// `whileWorkerActive` owns request parsing and preparation. The spawned
	// command outlives this handler, so take a second activity lease before the
	// request lease can be released; `settle` transfers it back exactly once.
	const releaseActivity = acquireWorkerActivity()

	function appendChunk(target, chunk) {
		if (target.truncated) return null
		const remaining = maxOutputBytes - target.bytes
		if (remaining <= 0) {
			target.truncated = true
			return null
		}
		const clipped = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
		target.chunks.push(clipped)
		target.bytes += clipped.length
		if (clipped.length < chunk.length) target.truncated = true
		return clipped
	}

	child.stdout.on('data', (chunk) => {
		const clipped = appendChunk(stdout, chunk)
		if (clipped) writeEvent(res, { type: 'stdout_delta', data: clipped.toString('utf8') })
	})
	child.stderr.on('data', (chunk) => {
		const clipped = appendChunk(stderr, chunk)
		if (clipped) writeEvent(res, { type: 'stderr_delta', data: clipped.toString('utf8') })
	})

	const timeout = setTimeout(() => {
		void ensureTermination(execution, 'timeout').catch((error) => {
			console.error(
				`[namzu-sandbox-worker] timed out execution could not be confirmed stopped: ${error instanceof Error ? error.message : String(error)}`,
			)
			poisonWorker(error)
		})
	}, timeoutMs)
	timeout.unref()

	function settle(error, result) {
		if (settled) return
		settled = true
		clearTimeout(timeout)
		releaseActivity()
		if (trackedExecution) {
			rememberTerminal(
				trackedExecution,
				execution.terminationCause === 'cancelled' ? 'cancelled' : error ? 'failed' : 'completed',
				result,
				error?.message,
			)
		}
		resolveDone({ error, result })
		try {
			if (error) writeEvent(res, { type: 'error', error: error.message })
			else writeEvent(res, { type: 'result', ...result })
			res.end()
		} catch {}
	}

	child.on('error', (error) => {
		settle(error)
	})

	child.on('exit', (exitCode, signal) => {
		if (execution.state !== 'running') return
		execution.state = 'exited'
		execution.exitCode = exitCode
		execution.exitSignal = signal
	})

	child.on('close', (exitCode, signal) => {
		void confirmExitedProcessGroup(execution)
			.then(() => {
				settle(undefined, {
					exitCode: typeof exitCode === 'number' ? exitCode : -1,
					timedOut: execution.terminationCause === 'timeout',
					durationMs: Date.now() - start,
					...(signal ? { signal } : {}),
					stdoutTruncated: stdout.truncated,
					stderrTruncated: stderr.truncated,
				})
			})
			.catch((error) => poisonWorker(error))
	})
}

async function handleReadFile(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}
	if (!body.path) {
		writeJson(res, 400, { error: 'missing_path' })
		return
	}
	try {
		const { target, root } = resolveReadablePath(body.path)
		const real = await realpathWithinWorkspace(target, root)
		const buf = await fs.readFile(real)
		const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
		writeJson(res, 200, {
			ok: true,
			content: buf.toString(encoding),
			sizeBytes: buf.length,
			encoding,
		})
	} catch (err) {
		writeJson(res, 400, { ok: false, error: err.message })
	}
}

async function handleWriteFile(req, res) {
	let body
	try {
		body = await readBody(req)
	} catch (err) {
		writeJson(res, 400, { error: 'invalid_body', message: err.message })
		return
	}
	if (!body.path || body.content === undefined) {
		writeJson(res, 400, { error: 'missing_path_or_content' })
		return
	}
	try {
		const { target, root } = resolveWritablePath(body.path)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const real = await realpathWithinWorkspace(target, root)
		const buf =
			body.encoding === 'base64'
				? Buffer.from(String(body.content), 'base64')
				: Buffer.from(String(body.content), 'utf8')
		// flag 'wx' rejects existing symlinks pointing out of the workspace
		// only when the target doesn't exist; for existing files we already
		// confirmed via realpath that they resolve inside one of WRITE_ROOTS,
		// so a plain writeFile is safe.
		await fs.writeFile(real, buf)
		writeJson(res, 200, { ok: true, bytesWritten: buf.length })
	} catch (err) {
		writeJson(res, 400, { ok: false, error: err.message })
	}
}

// Idle-exit timer. Every "real work" request (`/execute`,
// `/executions/reserve`, `/cancel`, `/read-file`, `/write-file`) holds an
// activity lease for its whole handler; a spawned command transfers that lease
// through process close. `/healthz` deliberately holds none — heartbeat
// liveness pings should not extend a sandbox that's otherwise idle. When the timer fires, exit cleanly so the
// container's `--rm` flag triggers daemon-side cleanup. `0` disables
// the layer entirely (testing, hosts that don't want it).
let idleTimer
function disarmIdleTimer() {
	if (!idleTimer) return
	clearTimeout(idleTimer)
	idleTimer = undefined
}

function resetIdleTimer() {
	if (!IDLE_TIMEOUT_MS || IDLE_TIMEOUT_MS <= 0) return
	disarmIdleTimer()
	// Active HTTP work or an execution owns the worker. The idle policy starts
	// only after the final owner releases, so it cannot tear down request
	// parsing, file I/O, command preparation, or a live execution stream.
	if (activeWorkCount > 0) return
	idleTimer = setTimeout(() => {
		console.log(
			`[namzu-sandbox-worker] idle for ${IDLE_TIMEOUT_MS}ms — exiting (container --rm cleans up)`,
		)
		// Exit code 0: this is intentional shutdown, not a crash. The
		// host's docker logs see a clean exit; the `--rm` flag (set by
		// `@namzu/sandbox` when spawning) collects the container body.
		process.exit(0)
	}, IDLE_TIMEOUT_MS)
	// `unref()` so this timer doesn't keep the event loop alive on its
	// own — process exits naturally if everything else (HTTP server,
	// pending children) settles first.
	idleTimer.unref?.()
}

const server = http.createServer(async (req, res) => {
	try {
		// The gate is the FIRST thing in the router, ahead of the poison
		// check and ahead of every dispatch, so an unauthenticated caller
		// cannot tell an existing route from a missing one, or a bad token
		// from a missing one: both are the same `401` with the same body.
		//
		// `/healthz` is the exception and the whole of it: it is what a
		// host probes BEFORE it has any other business with the worker —
		// the readiness poll runs many times per create — so a worker that
		// required a token for it would need the token plumbed into the
		// readiness path and would still answer a liveness question with a
		// credential error. It reveals liveness and the protocol version
		// and nothing else; the body is unchanged by any of this.
		//
		// Two consequences of that exemption, named rather than discovered.
		//
		// The poison check below answers BEFORE the `/healthz` dispatch, so
		// an unauthenticated caller CAN tell a retiring worker from a
		// serving one on that one route: `503 {"error":"worker_retiring"}`
		// where a healthy worker answers `200`. This used to be written
		// down as impossible. It is the drain signal, and it is the host's
		// readiness probe that has to read it — a probe with no credential
		// to present. What it discloses is that the worker is going away,
		// and nothing about what it holds, what it has run, or which routes
		// exist. Every route that does anything is behind the token, and
		// there a retiring worker and a serving one are the same `401` to
		// anyone without one.
		//
		// The exemption compares the WHOLE of `req.url`, so `POST /healthz`,
		// `GET /healthz?x=1` and `GET /healthz/` are not it: they are gated,
		// and with a token they are `404`s like any other route that does
		// not exist.
		if (!(req.method === 'GET' && req.url === '/healthz') && !isAuthorized(req)) {
			writeUnauthorized(res)
			return
		}
		if (workerPoisoned) {
			writeJson(res, 503, { error: 'worker_retiring' })
			return
		}
		if (req.method === 'GET' && req.url === '/healthz') {
			writeJson(res, 200, {
				ok: true,
				protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION,
			})
			return
		}
		if (req.method === 'POST' && req.url === '/execute') {
			await whileWorkerActive(() => handleExecute(req, res))
			return
		}
		if (req.method === 'POST' && req.url === '/executions/reserve') {
			await whileWorkerActive(() => handleReserveExecution(req, res))
			return
		}
		if (req.method === 'POST' && req.url === '/cancel') {
			await whileWorkerActive(() => handleCancelExecution(req, res))
			return
		}
		if (req.method === 'POST' && req.url === '/read-file') {
			await whileWorkerActive(() => handleReadFile(req, res))
			return
		}
		if (req.method === 'POST' && req.url === '/write-file') {
			await whileWorkerActive(() => handleWriteFile(req, res))
			return
		}
		writeJson(res, 404, { error: 'not_found' })
	} catch (err) {
		// Last-line-of-defence: ANY async path that throws past the
		// per-handler try/catch must not be allowed to crash the
		// worker. The container is single-tenant per task; a process
		// exit kills every in-flight supervisor + child agent that
		// shared the cached sandbox handle, and they all fail with
		// the misleading bare `fetch failed`. Respond if the headers
		// are still inflight; otherwise log and drop — the host will
		// see a socket close on that one request and retry whatever
		// it was doing, but the next request lands on a still-alive
		// worker.
		console.error('[namzu-sandbox-worker] uncaught handler error:', err?.stack ? err.stack : err)
		try {
			if (!res.headersSent) {
				writeJson(res, 500, {
					error: 'internal',
					message: err?.message ? err.message : String(err),
				})
			} else {
				try {
					res.end()
				} catch {}
			}
		} catch {}
	}
})

// Defence-in-depth process-level handlers: log loudly if something
// slips past every try/catch, but DO NOT exit the worker. A caller's
// retry path treats a single 500 / 502 as transient, while a process
// exit produces the catastrophic "every subsequent tool call fetch
// fails because the container is gone" pattern.
process.on('unhandledRejection', (err) => {
	console.error('[namzu-sandbox-worker] unhandledRejection:', err?.stack ? err.stack : err)
})
process.on('uncaughtException', (err) => {
	console.error('[namzu-sandbox-worker] uncaughtException:', err?.stack ? err.stack : err)
})

// The startup decision comes before `listen`, so a worker that cannot
// authenticate on a routable address refuses while refusal is still free:
// nothing has answered yet, and the host sees an exited container rather
// than an open one it must notice for itself.
assertListenableConfiguration()
// A failed `listen` must not look like a clean shutdown. Without this
// handler the `error` event is unhandled, the process-level handler below
// logs it and does not exit, and the worker then has nothing keeping its
// event loop alive — so it exits 0, having served nothing, and a host (or a
// test) reading an exit code calls that an intentional shutdown. That is
// the one thing an operator cannot act on: the container is gone, the
// reason is in a log they may not be reading, and the code says success.
server.on('error', (error) => {
	console.error(
		`[namzu-sandbox-worker] could not listen on ${BIND}:${PORT}: ${error?.message ?? error}`,
	)
	process.exit(1)
})
server.listen(PORT, BIND, () => {
	console.log(
		`[namzu-sandbox-worker] listening on ${BIND}:${PORT} workspace=${WORKSPACE_ROOT} idleTimeoutMs=${IDLE_TIMEOUT_MS} auth=${AUTH_ENABLED ? 'bearer' : 'none'}`,
	)
	// Arm the idle timer at boot. If the host never sends a single
	// `/execute` (e.g. supervisor hangs before its first tool call),
	// the sandbox still bounds its own lifetime.
	resetIdleTimer()
})
