/**
 * Minimal Kubernetes API client: bare fetch/https transport plus in-cluster
 * ServiceAccount bootstrap.
 *
 * Sibling of the ACI and Firecracker control-plane clients: same
 * dependency-free shape, different API. No `@kubernetes/client-node`, no
 * kubeconfig parsing, no exec-credential-plugin invocation, no YAML anywhere
 * — `@namzu/sandbox` still declares zero runtime `dependencies` after this
 * module.
 *
 * ## Auth / SDK-dependency boundary
 * Two access sources, neither needing a YAML parser:
 *  - `{ inCluster: true }` reads the projected ServiceAccount volume
 *    (`token`, `ca.crt`, `namespace`) plus `KUBERNETES_SERVICE_HOST` /
 *    `KUBERNETES_SERVICE_PORT` — pure file + env reads, the same boundary
 *    `kubectl` itself uses inside a pod. The token file is re-read on EVERY
 *    request because kubelet rotates projected tokens under the pod; caching
 *    it would produce an intermittent 401 hours into a long-lived host
 *    process.
 *  - `{ server, ca?, getToken }` supplied by the caller mirrors ACI's
 *    `ArmTokenProvider` and Firecracker's `OrchestratorTokenProvider`
 *    (`../aci-standby-pool/index.ts`, `../firecracker/index.ts`). Kubeconfig
 *    parsing, context merging and exec-credential-plugin invocation
 *    (kubelogin, gcloud, aws-iam-authenticator, ...) all stay OUTSIDE this
 *    package; the caller resolves a bearer token however it likes.
 *
 * ## Transport
 * Default path is bare global `fetch`. When a custom CA is present — always
 * true in-cluster, since the cluster CA is never in the process's system
 * trust store — the call goes through `node:https.request` with that `ca`
 * and `rejectUnauthorized: true` instead, exactly as
 * `../firecracker/index.ts` splits `fetchOrchestratorRequest` from
 * `httpsOrchestratorRequest` ("the package declares no undici dependency").
 *
 * ## Status mapping
 * 404/410 become an `AlreadyGoneError` sentinel a teardown path can treat as
 * success (ACI's `armCall(..., [404, 410])` accepts the same pair for
 * exactly that reason — see `../aci-standby-pool/index.ts`). 409 becomes a
 * `ConflictError` an adoption/retry path can catch. 401/403 become a
 * `CredentialError` naming the attempted verb and resource — never the
 * token, which this module never logs or embeds in any thrown message.
 *
 * ## What a failure carries, and what it deliberately does not
 * Everything else — a connect failure, and every non-2xx status the mapping
 * above does not name — rejects with {@link KubernetesApiError}, which
 * carries the verb, the path, the status where there was one, and the
 * `Retry-After` the server sent with a 429 or a 503. That is METADATA and
 * nothing more: there is no retry loop and no retry policy in this module.
 * A retry is a decision about the OPERATION — a GET during a readiness poll
 * may be repeated, a POST that may already have committed may not — and this
 * client cannot tell those apart. `backends/kubernetes/index.ts` owns the
 * policy, beside the acquire it serves and inside that acquire's existing
 * deadline.
 *
 * ## Deadlines
 * Every request carries its own bound
 * ({@link KubernetesClientOptions.requestTimeoutMs}, default
 * {@link DEFAULT_API_REQUEST_TIMEOUT_MS}) on top of whatever signal the
 * caller passed, because the caller's signal is optional everywhere and
 * several call sites are SHARED flights that run under whichever caller
 * arrived first — one signal-less `destroy()` against an API server that
 * accepted a request and never answered would otherwise pin every later
 * caller joined to it. The bound covers `getToken()`, the connection and
 * reading the body, on both transports, and expiry rejects with
 * {@link KubernetesApiTimeoutError} rather than the generic `failed:` error
 * so a caller can tell a timeout from a refusal. A caller's own abort still
 * behaves exactly as it did.
 *
 * ## Not in v1
 * No watch, no informers, no resourceVersion/bookmark tracking. Readiness is
 * polled by the caller with `../readiness.js`'s `OperationDeadline`, exactly
 * as ACI polls `provisioningState`.
 */

import { readFileSync } from 'node:fs'
import https from 'node:https'

/** The only verbs anything in this backend needs to send. */
export type KubernetesHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * Which patch dialect a `PATCH` body is.
 *
 *  - `merge` (the default, and what every caller sent before conditional
 *    writes existed) is RFC 7386 `application/merge-patch+json`: a partial
 *    object that recurses into maps, so a patch touching one annotation
 *    leaves the others standing. It has no way to express a condition.
 *  - `json` is RFC 6902 `application/json-patch+json`: an ordered list of
 *    operations, one of which is `test`. That is the whole reason it exists
 *    here — a `test` and the mutation it guards travel in ONE request, so
 *    there is no window between checking and writing. See
 *    `objects.ts`'s `buildHolderEpochPatch`.
 *
 * Omitted means `merge`, so no existing call site changes a byte.
 */
export type KubernetesPatchType = 'merge' | 'json'

/**
 * Authentication callback. Caller returns a fresh bearer token. Invoked on
 * every request so a long-running host survives token rotation — the same
 * contract as ACI's `ArmTokenProvider` and Firecracker's
 * `OrchestratorTokenProvider`.
 */
export type KubernetesTokenProvider = () => Promise<string>

/**
 * In-cluster bootstrap. The token, CA and namespace come off the projected
 * ServiceAccount volume; the API server address comes off the env vars the
 * kubelet always sets for the pod's default-namespace Service.
 */
export interface InClusterKubernetesAccess {
	readonly inCluster: true
	/**
	 * Overridable so tests never touch the real projected-volume path.
	 * Defaults to `/var/run/secrets/kubernetes.io/serviceaccount`.
	 */
	readonly serviceAccountDir?: string
}

/**
 * Caller-supplied server + credential (see {@link KubernetesTokenProvider}).
 * `namespace` is required here because, unlike the in-cluster path, there is
 * no ServiceAccount file to read it from — the caller must say which
 * namespace this client operates in.
 */
export interface ExplicitKubernetesAccess {
	readonly inCluster?: false
	readonly server: string
	readonly namespace: string
	/** Custom cluster CA. Present → the client dials over `node:https`. */
	readonly ca?: string | Buffer
	readonly getToken: KubernetesTokenProvider
}

export type KubernetesAccess = InClusterKubernetesAccess | ExplicitKubernetesAccess

/**
 * Bound every request this client sends is measured against, on top of the
 * caller's own signal. Orthogonal to {@link KubernetesAccess}, which says
 * WHO the client is, so it is a second argument rather than another arm of
 * that union.
 */
export interface KubernetesClientOptions {
	/**
	 * Milliseconds a single request may take, end to end: resolving the
	 * token, connecting, sending, and reading the reply. Default
	 * {@link DEFAULT_API_REQUEST_TIMEOUT_MS}; minimum
	 * {@link MIN_API_REQUEST_TIMEOUT_MS}. There is deliberately NO value
	 * that turns the bound off — see {@link resolveRequestTimeoutMs}.
	 */
	readonly requestTimeoutMs?: number
}

/**
 * Default {@link KubernetesClientOptions.requestTimeoutMs} — 30 s.
 *
 * The same cap `lease.ts` already puts on a renewal PATCH, and below the
 * 60 s `readyTimeoutMs` default, so a request that times out still leaves
 * the readiness budget something to report with.
 */
export const DEFAULT_API_REQUEST_TIMEOUT_MS = 30_000

/** Floor for {@link KubernetesClientOptions.requestTimeoutMs} — 1 s. */
export const MIN_API_REQUEST_TIMEOUT_MS = 1_000

export interface KubernetesClient {
	/**
	 * `path` is the API-server path (e.g.
	 * `/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxclaims/id`), not a full
	 * URL. Returns the parsed JSON body, or `undefined` for a 204 or an empty
	 * body. Rejects with {@link KubernetesAlreadyGoneError},
	 * {@link KubernetesConflictError} or {@link KubernetesCredentialError} for
	 * the status codes each names, and with {@link KubernetesApiTimeoutError}
	 * when the request outlives
	 * {@link KubernetesClientOptions.requestTimeoutMs}; a connect failure and
	 * any other non-2xx status reject with {@link KubernetesApiError}.
	 *
	 * `patchType` picks the dialect a `PATCH` body is sent as, and is ignored
	 * for every other verb. `json` additionally maps a 422 to
	 * {@link KubernetesPatchNotAppliedError} — see that class for why the
	 * status alone is all the API server gives anyone to go on.
	 */
	request<T>(
		method: KubernetesHttpMethod,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		patchType?: KubernetesPatchType,
	): Promise<T | undefined>
	/** From the ServiceAccount file in-cluster, from config otherwise. */
	namespace(): string
}

const DEFAULT_SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

/** 404/410 → this. A teardown path treats it as "already achieved". */
export class KubernetesAlreadyGoneError extends Error {
	constructor(
		readonly method: KubernetesHttpMethod,
		readonly resource: string,
		readonly status: number,
	) {
		super(`kubernetes ${method} ${resource} -> ${status}: already gone`)
		this.name = 'KubernetesAlreadyGoneError'
	}
}

/** 409 → this. An adoption/retry path can catch it and re-read + retry. */
export class KubernetesConflictError extends Error {
	constructor(
		readonly method: KubernetesHttpMethod,
		readonly resource: string,
	) {
		super(`kubernetes ${method} ${resource} -> 409: conflict`)
		this.name = 'KubernetesConflictError'
	}
}

/**
 * A JSON Patch the API server would not apply: 422 Unprocessable Entity.
 *
 * ## What the API server actually says, measured
 *
 * Against a real API server (v1.37.0) and the agent-sandbox `Sandbox` CRD, a
 * JSON Patch whose `test` clause does not hold answers **422** with this
 * body, byte for byte:
 *
 * ```json
 * {"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure",
 *  "message":"the server rejected our request due to an error in our request",
 *  "reason":"Invalid","details":{},"code":422}
 * ```
 *
 * A patch that is simply WRONG — a pointer into a member that does not
 * exist, say — answers with exactly the same status, the same reason and the
 * same message. The server does not name the operation that failed, so
 * nothing this class could read off the response would tell a lost race from
 * a malformed body, and a class that claimed to would be lying.
 *
 * So it says what it can honestly say: the patch did not apply and NOTHING
 * was changed. Deciding which of the two it was belongs to the caller that
 * knows what it tested — `workspace.ts` re-reads the object and compares the
 * value it tested against what is stored now: changed ⇒ somebody raced it,
 * unchanged ⇒ the body is wrong and the error is rethrown rather than
 * retried forever.
 *
 * Not a {@link KubernetesConflictError}: that one is 409, which the same
 * server returns for a DELETE whose `preconditions.resourceVersion` does not
 * match (measured on the same cluster, with a message that DOES name the two
 * versions). The two statuses mean different things and are kept apart.
 */
export class KubernetesPatchNotAppliedError extends Error {
	constructor(
		readonly method: KubernetesHttpMethod,
		readonly resource: string,
		readonly status: number,
	) {
		super(
			`kubernetes ${method} ${resource} -> ${status}: the API server did not apply the JSON patch and changed nothing. It does not say which operation failed, so this is either a \`test\` clause that no longer holds — another holder wrote the object first — or a patch body that is wrong.`,
		)
		this.name = 'KubernetesPatchNotAppliedError'
	}
}

/**
 * 401/403 → this. Names the attempted verb and resource only — never the
 * token, and never the response body (the API server does not echo the
 * token back, but the body is untrusted content this module has no reason
 * to repeat into a thrown message).
 */
export class KubernetesCredentialError extends Error {
	constructor(
		readonly verb: KubernetesHttpMethod,
		readonly resource: string,
		readonly status: number,
	) {
		super(`kubernetes API refused ${verb} ${resource}: ${status}`)
		this.name = 'KubernetesCredentialError'
	}
}

/**
 * The request outlived {@link KubernetesClientOptions.requestTimeoutMs}.
 *
 * Deliberately NOT the generic `failed:` error: a caller that can tell a
 * timeout from a refusal can retry an idempotent write, and one that cannot
 * has to treat every failure alike. Carries the verb, the resource path and
 * the bound that expired — and, like every other error in this module,
 * never the bearer token.
 *
 * A timeout says nothing about whether the request was APPLIED, which is
 * why nothing here tries to: a suspend restores the state it saw and sends
 * its idempotent patch again, a create POST that landed is adopted through
 * the 409 path, and a DELETE that already applied counts as done.
 */
export class KubernetesApiTimeoutError extends Error {
	constructor(
		readonly verb: KubernetesHttpMethod,
		readonly resource: string,
		readonly timeoutMs: number,
	) {
		super(
			`kubernetes ${verb} ${resource} was still unanswered ${timeoutMs}ms after it was sent, and was given up on (apiRequestTimeoutMs). Whether the API server applied it is unknown. Raise apiRequestTimeoutMs if this cluster is genuinely this slow.`,
		)
		this.name = 'KubernetesApiTimeoutError'
	}
}

/**
 * Which half of a request failed, and therefore what is known about it.
 *
 *  - `'connect'` — the request never got an answer: DNS, TCP, TLS or a reset
 *    socket. Whether the API server saw it at all is unknown.
 *  - `'status'` — the API server answered, with a status this client's
 *    mapping does not name. `status` is then always present.
 */
export type KubernetesApiFailureTransport = 'connect' | 'status'

/**
 * Every API failure this client does not already name: a connect failure, and
 * every non-2xx status outside 401/403/404/409/410 (and the 422 a JSON patch
 * gets).
 *
 * It exists because "a burst past node capacity" and "the API server is down"
 * used to be the same plain `Error`, separable only by matching the message
 * text a release is free to reword. The fields are the smallest set that
 * makes the difference decidable by a caller:
 *
 *  - `status` — absent for a connect failure, present for every answered one.
 *  - `retryAfterMs` — the `Retry-After` header the API server sends with a
 *    429 (its own priority-and-fairness queue shedding load) and sometimes
 *    with a 503, normalised to milliseconds from either spelling the header
 *    allows. Absent when the server sent none, which is not the same as zero.
 *  - `transport` — see {@link KubernetesApiFailureTransport}.
 *  - `cause` — the underlying error for a connect failure.
 *
 * **There is no retry here.** This class is metadata; `index.ts` decides what
 * is worth repeating, because only the caller knows whether the operation is
 * idempotent and only the caller owns a clock to repeat it inside.
 *
 * The message keeps the exact wording both throw sites used before, so a host
 * that logs it sees no change and only a host that inspects the type gains
 * anything.
 */
export class KubernetesApiError extends Error {
	readonly method: KubernetesHttpMethod
	readonly path: string
	readonly status?: number
	readonly retryAfterMs?: number
	readonly transport: KubernetesApiFailureTransport

	constructor(
		message: string,
		details: {
			readonly method: KubernetesHttpMethod
			readonly path: string
			readonly status?: number
			readonly retryAfterMs?: number
			readonly transport: KubernetesApiFailureTransport
			readonly cause?: unknown
		},
	) {
		super(message, details.cause !== undefined ? { cause: details.cause } : undefined)
		this.name = 'KubernetesApiError'
		this.method = details.method
		this.path = details.path
		if (details.status !== undefined) this.status = details.status
		if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
		this.transport = details.transport
	}
}

/**
 * `Retry-After`, in milliseconds, or `undefined` when the server sent none or
 * sent one that cannot be read.
 *
 * RFC 9110 allows two spellings and the API server uses the first: a
 * delta-seconds integer (`Retry-After: 1`), which is what
 * priority-and-fairness sends with a 429. The HTTP-date spelling is accepted
 * too, because a proxy in front of the API server may rewrite it. A date in
 * the past, or a negative delta, reads as `0` — "now" — rather than being
 * discarded, because the server still said to wait and the answer to "how
 * long" is "no longer".
 */
export function parseRetryAfterMs(header: string | undefined): number | undefined {
	if (header === undefined) return undefined
	const raw = header.trim()
	if (raw === '') return undefined
	if (/^-?\d+$/.test(raw)) {
		const seconds = Number(raw)
		if (!Number.isSafeInteger(seconds)) return undefined
		return Math.max(0, seconds * 1_000)
	}
	const at = Date.parse(raw)
	if (Number.isNaN(at)) return undefined
	return Math.max(0, at - Date.now())
}

/**
 * Validate the configured bound, or supply the default.
 *
 * There is no disabling value, and `0` is refused rather than read as
 * "unbounded": an unanswered request is not a supported configuration.
 * Several call sites are single-flight promises that run under the FIRST
 * caller's signal and never consult a later one's, so one hung request
 * does not block one caller — it blocks every caller that joined it, on a
 * handle whose state already refuses data-plane calls. A cluster with a
 * genuinely slow API server raises the number.
 */
export function resolveRequestTimeoutMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_API_REQUEST_TIMEOUT_MS
	if (!Number.isSafeInteger(value) || value < MIN_API_REQUEST_TIMEOUT_MS) {
		throw new Error(
			`kubernetes: apiRequestTimeoutMs must be an integer of at least ${MIN_API_REQUEST_TIMEOUT_MS}ms, got ${JSON.stringify(
				value,
			)}. No value disables the bound: a request the API server accepted and never answered would hang its caller — and every later caller joined to the same single-flight suspend, delete or verification — until the process was killed. Raise the number instead; the default is ${DEFAULT_API_REQUEST_TIMEOUT_MS}ms.`,
		)
	}
	return value
}

/**
 * Await `promise`, but give up the moment `signal` aborts, rejecting with
 * that signal's reason.
 *
 * `getToken()` is a caller-supplied callback and `res.text()` is a body the
 * peer may simply stop sending, and neither takes a signal of its own, so
 * without this the bound would cover only the part of a request this module
 * happens to hold a socket for. The late settlement is swallowed rather
 * than left dangling: an unobserved rejection is still a rejection.
 */
function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => {})
		return Promise.reject(signal.reason)
	}
	return new Promise<T>((resolve, reject) => {
		let done = false
		const onAbort = () => {
			done = true
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				if (!done) resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				if (!done) reject(error)
			},
		)
	})
}

function stripTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url
}

interface ResolvedAccess {
	readonly baseUrl: string
	readonly ca?: string | Buffer
	readonly namespace: string
	readonly getToken: KubernetesTokenProvider
}

/**
 * Reads `ca.crt` and `namespace` once (they do not rotate for the pod's
 * lifetime); returns a `getToken` closure that re-reads `token` on every
 * call, because kubelet DOES rotate the projected token under a live pod.
 */
function resolveInCluster(access: InClusterKubernetesAccess): ResolvedAccess {
	const dir = access.serviceAccountDir ?? DEFAULT_SERVICE_ACCOUNT_DIR
	const host = process.env.KUBERNETES_SERVICE_HOST
	const port = process.env.KUBERNETES_SERVICE_PORT
	if (host === undefined || host === '' || port === undefined || port === '') {
		throw new Error(
			'kubernetes: in-cluster access requires KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT',
		)
	}
	const ca = readFileSync(`${dir}/ca.crt`)
	const namespace = readFileSync(`${dir}/namespace`, 'utf8').trim()
	return {
		baseUrl: `https://${host}:${port}`,
		ca,
		namespace,
		getToken: async () => readFileSync(`${dir}/token`, 'utf8').trim(),
	}
}

function resolveExplicit(access: ExplicitKubernetesAccess): ResolvedAccess {
	return {
		baseUrl: stripTrailingSlash(access.server),
		ca: access.ca,
		namespace: access.namespace,
		getToken: access.getToken,
	}
}

/** A transport-agnostic view of the API-server response the mapping needs. */
interface RawResponse {
	readonly status: number
	readonly contentType: string
	/**
	 * One response header, by lowercase name, or `undefined`.
	 *
	 * Exactly one header is read through it — `Retry-After` — and it is a
	 * lookup rather than the whole header bag on purpose: the two transports
	 * below spell a header bag differently (`Headers` versus a
	 * `string | string[]` record), and a caller that had to cope with both
	 * would be the third place in this file that knows which transport ran.
	 */
	readonly header: (name: string) => string | undefined
	readonly text: () => Promise<string>
}

/** The plain-`fetch` path — the DEFAULT, used whenever no custom CA is set. */
async function fetchRequest(
	url: string,
	method: KubernetesHttpMethod,
	headers: Record<string, string>,
	payload: string | undefined,
	signal?: AbortSignal,
): Promise<RawResponse> {
	const init: RequestInit = { method, headers }
	if (payload !== undefined) init.body = payload
	if (signal !== undefined) init.signal = signal
	const res = await fetch(url, init)
	return {
		status: res.status,
		contentType: res.headers.get('content-type') ?? '',
		header: (name) => res.headers.get(name) ?? undefined,
		text: () => res.text(),
	}
}

/**
 * The custom-CA path: a `node:https` request presenting the injected `ca`
 * and verifying the API server's cert against it (`rejectUnauthorized:
 * true`). `node:https` is used rather than fetch+a custom dispatcher because
 * the package declares no undici dependency — `node:https` is always
 * importable and needs nothing added (mirrors
 * `../firecracker/index.ts`'s `httpsOrchestratorRequest`).
 */
function httpsRequest(
	url: string,
	method: KubernetesHttpMethod,
	headers: Record<string, string>,
	payload: string | undefined,
	ca: string | Buffer,
	signal?: AbortSignal,
): Promise<RawResponse> {
	const target = new URL(url)
	return new Promise<RawResponse>((resolve, reject) => {
		const req = https.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port !== '' ? Number(target.port) : 443,
				path: `${target.pathname}${target.search}`,
				method,
				headers,
				ca,
				rejectUnauthorized: true,
				...(signal !== undefined ? { signal } : {}),
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					const ct = res.headers['content-type']
					resolve({
						status: res.statusCode ?? 0,
						contentType: Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? ''),
						header: (name) => {
							const value = res.headers[name]
							return Array.isArray(value) ? value[0] : value
						},
						text: async () => Buffer.concat(chunks).toString('utf8'),
					})
				})
				res.on('error', reject)
			},
		)
		req.on('error', reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
}

/**
 * `PATCH` carries a JSON MERGE patch body (RFC 7386) unless the caller asked
 * for `json`, which sends an RFC 6902 operation list instead — never
 * server-side apply, never YAML. `POST` carries a plain JSON create body.
 * `GET`/`DELETE` normally carry no body; when a caller does pass one to
 * `DELETE` — a `DeleteOptions` with `preconditions` — it is sent as plain
 * JSON, which is what the API server expects there.
 */
function contentTypeFor(method: KubernetesHttpMethod, patchType: KubernetesPatchType): string {
	if (method !== 'PATCH') return 'application/json'
	return patchType === 'json' ? 'application/json-patch+json' : 'application/merge-patch+json'
}

export function createKubernetesClient(
	access: KubernetesAccess,
	options: KubernetesClientOptions = {},
): KubernetesClient {
	const resolved = access.inCluster === true ? resolveInCluster(access) : resolveExplicit(access)
	// Validated at construction, not at the first request: a configuration
	// this module will never honour should be refused where the operator can
	// still see which backend it came from.
	const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs)

	async function request<T>(
		method: KubernetesHttpMethod,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		patchType: KubernetesPatchType = 'merge',
	): Promise<T | undefined> {
		signal?.throwIfAborted()
		// The caller's signal is WRAPPED, never replaced: `deadline` aborts
		// with the caller's own reason when the caller aborts, so every path
		// below behaves exactly as it did, and with a
		// KubernetesApiTimeoutError when the bound expires first. Combined by
		// hand rather than with `AbortSignal.any`, which this package's
		// declared Node floor (20.0) predates.
		const deadlineController = new AbortController()
		const deadline = deadlineController.signal
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			deadlineController.abort(new KubernetesApiTimeoutError(method, path, requestTimeoutMs))
		}, requestTimeoutMs)
		timer.unref?.()
		const forwardCallerAbort = () => deadlineController.abort(signal?.reason)
		signal?.addEventListener('abort', forwardCallerAbort, { once: true })
		/** True while the CALLER is the one who gave up, which wins. */
		const callerGaveUp = () => signal?.aborted === true
		const readBody = async (res: RawResponse): Promise<string> =>
			await settleOnAbort(res.text(), deadline)

		try {
			// Covered by the bound at last: `getToken()` is caller code that
			// takes no signal of its own, and an in-cluster token read that
			// blocks on a wedged volume used to be unbounded on every request.
			const token = await settleOnAbort(resolved.getToken(), deadline)
			deadline.throwIfAborted()
			const url = `${resolved.baseUrl}${path}`
			const payload = body !== undefined ? JSON.stringify(body) : undefined
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			}
			if (payload !== undefined) headers['content-type'] = contentTypeFor(method, patchType)

			let res: RawResponse
			try {
				res =
					resolved.ca !== undefined
						? await httpsRequest(url, method, headers, payload, resolved.ca, deadline)
						: await fetchRequest(url, method, headers, payload, deadline)
			} catch (err) {
				if (err instanceof KubernetesApiTimeoutError) throw err
				// A timeout is named rather than folded into `failed:`; a
				// caller's own abort still produces the wrapped error it
				// always produced.
				if (timedOut && !callerGaveUp()) {
					throw new KubernetesApiTimeoutError(method, path, requestTimeoutMs)
				}
				// Same sentence it has always thrown, on a class that says which
				// half failed. Nothing here decides whether to try again: see
				// {@link KubernetesApiError}.
				throw new KubernetesApiError(
					`kubernetes ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
					{ method, path, transport: 'connect', cause: err },
				)
			}

			if (res.status === 401 || res.status === 403) {
				await readBody(res)
				deadline.throwIfAborted()
				throw new KubernetesCredentialError(method, path, res.status)
			}
			if (res.status === 404 || res.status === 410) {
				await readBody(res)
				deadline.throwIfAborted()
				throw new KubernetesAlreadyGoneError(method, path, res.status)
			}
			if (res.status === 409) {
				await readBody(res)
				deadline.throwIfAborted()
				throw new KubernetesConflictError(method, path)
			}
			// Before the generic mapping, and only for the dialect that has a
			// `test` clause to fail: a merge patch has no condition, so a 422
			// on one is a malformed body and belongs in the generic error
			// where it always was.
			if (res.status === 422 && method === 'PATCH' && patchType === 'json') {
				await readBody(res)
				deadline.throwIfAborted()
				throw new KubernetesPatchNotAppliedError(method, path, res.status)
			}
			if (res.status < 200 || res.status >= 300) {
				// Read BEFORE the body, because `readBody` can abort out of this
				// block and the header is the whole reason a caller can wait the
				// length the server asked for rather than a length it invented.
				// Only for the two statuses that mean "later, not never": a 400
				// carrying one would be the server contradicting itself.
				const retryAfterMs =
					res.status === 429 || res.status === 503
						? parseRetryAfterMs(res.header('retry-after'))
						: undefined
				const text = await readBody(res)
				deadline.throwIfAborted()
				throw new KubernetesApiError(`kubernetes ${method} ${path} -> ${res.status}: ${text}`, {
					method,
					path,
					status: res.status,
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
					transport: 'status',
				})
			}
			if (res.status === 204) return undefined
			if (res.contentType.includes('application/json')) {
				const text = await readBody(res)
				deadline.throwIfAborted()
				return text.length > 0 ? (JSON.parse(text) as T) : undefined
			}
			return undefined
		} finally {
			clearTimeout(timer)
			signal?.removeEventListener('abort', forwardCallerAbort)
		}
	}

	return {
		request,
		namespace: () => resolved.namespace,
	}
}
