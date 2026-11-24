import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionError } from './errors.js'
import { schemaProblems } from './json-schema.js'
import type { Manifest } from './types.js'

/** `namzu-ext-query/1`: a 4-byte big-endian length, then UTF-8 JSON; one request at a time. */

export const QUERY_TIMEOUT_MS = 5000

/** Where the process listens: a named pipe on Windows, a Unix socket in a private folder elsewhere. */
export function queryAddress(
	platform: NodeJS.Platform,
	extensionId: string,
	runDir: string,
	userHash: string,
): string {
	const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)
	if (platform === 'win32') return `\\\\.\\pipe\\namzu-ext-${h(extensionId)}-${h(userHash)}`
	const preferred = join(runDir, 'q.sock')
	// A Unix socket path is limited to about 100 bytes.
	return Buffer.byteLength(preferred) <= 100
		? preferred
		: join(tmpdir(), `nx-${h(extensionId)}-${h(userHash)}.sock`)
}

/** How long a freshly started process may take to open its query endpoint after it said it is collecting. */
export const ENDPOINT_READY_MS = 10_000
const ENDPOINT_RETRY_MS = 20

/**
 * Resolves true once something accepts a connection at `address` (a connect that is then closed at once, so
 * no request is sent), false when `deadlineMs` passes first. A process that is still opening its socket
 * refuses or has no file yet; those are retried until the deadline, which only bounds a failure: a normal
 * start resolves on the first connect that works, not on the clock.
 */
export function waitForEndpoint(address: string, deadlineMs = ENDPOINT_READY_MS): Promise<boolean> {
	return new Promise((resolve) => {
		let over = false
		let retry: ReturnType<typeof setTimeout> | undefined
		const stop = setTimeout(() => {
			over = true
			if (retry) clearTimeout(retry)
			resolve(false)
		}, deadlineMs)
		stop.unref?.()
		const attempt = () => {
			if (over) return
			const socket = createConnection(address)
			socket.once('connect', () => {
				socket.destroy()
				if (over) return
				over = true
				clearTimeout(stop)
				resolve(true)
			})
			socket.once('error', () => {
				socket.destroy()
				if (!over) {
					retry = setTimeout(attempt, ENDPOINT_RETRY_MS)
					retry.unref?.()
				}
			})
		}
		attempt()
	})
}

export function requestOnce(
	address: string,
	request: unknown,
	timeoutMs = QUERY_TIMEOUT_MS,
	maxBytes = 4 * 1024 * 1024,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(address)
		let buf = Buffer.alloc(0)
		let done = false
		const finish = (fn: () => void) => {
			if (done) return
			done = true
			clearTimeout(timer)
			socket.destroy()
			fn()
		}
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(
						new ExtensionError('query-timeout', 'timeout', 'The extension did not answer in time.'),
					),
				),
			timeoutMs,
		)
		socket.once('connect', () => {
			const body = Buffer.from(JSON.stringify(request), 'utf8')
			const head = Buffer.alloc(4)
			head.writeUInt32BE(body.length)
			socket.write(Buffer.concat([head, body]))
		})
		socket.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk])
			if (buf.length >= 4) {
				const len = buf.readUInt32BE(0)
				if (len > maxBytes)
					return finish(() =>
						reject(
							new ExtensionError(
								'query-too-big',
								'maxBytes',
								'The answer is larger than the query allows.',
							),
						),
					)
				if (buf.length >= 4 + len) {
					const raw = buf.subarray(4, 4 + len).toString('utf8')
					finish(() => {
						try {
							resolve(JSON.parse(raw))
						} catch {
							reject(new ExtensionError('query-invalid', 'json', 'The answer is not valid JSON.'))
						}
					})
				}
			}
		})
		socket.once('error', (e) =>
			finish(() =>
				reject(
					new ExtensionError(
						'query-unreachable',
						'connect',
						`The extension is not reachable: ${e.message}`,
					),
				),
			),
		)
		socket.once('close', () =>
			finish(() =>
				reject(
					new ExtensionError(
						'query-closed',
						'closed',
						'The extension closed the connection without an answer.',
					),
				),
			),
		)
	})
}

/** Collect every `kind` an answer names, to hold it to the query's declared `returns` (R3). */
function kindsIn(value: unknown, depth = 0, out: string[] = []): string[] {
	if (depth > 4 || !value || typeof value !== 'object') return out
	if (Array.isArray(value)) {
		for (const v of value) kindsIn(v, depth + 1, out)
		return out
	}
	for (const [k, v] of Object.entries(value)) {
		if (k === 'kind' && typeof v === 'string') out.push(v)
		else kindsIn(v, depth + 1, out)
	}
	return out
}

/** The host's run-time checks on an answer: R2 (fits the schema and the size), R3 (only declared kinds, only declared columns). */
export function checkAnswer(
	manifest: Manifest,
	queryId: string,
	answer: unknown,
	schema: unknown,
	bytes: number,
): { ok: true; result: unknown } | { ok: false; code: 'R2' | 'R3'; message: string } {
	const q = manifest.contributes.endpoint.queries.find((x) => x.id === queryId)
	if (!q) return { ok: false, code: 'R2', message: 'no such query' }
	if (bytes > q.maxBytes)
		return {
			ok: false,
			code: 'R2',
			message: `the answer is ${bytes} bytes; this query allows ${q.maxBytes}`,
		}
	const a = answer as { v?: number; ok?: boolean; result?: unknown; error?: unknown } | null
	if (!a || typeof a !== 'object' || a.v !== 1 || typeof a.ok !== 'boolean')
		return { ok: false, code: 'R2', message: 'the reply is not a namzu-ext-query/1 answer' }
	if (!a.ok) return { ok: false, code: 'R2', message: 'the extension reported an error' }
	const problems = schemaProblems(schema, a.result)
	if (problems.length > 0)
		return { ok: false, code: 'R2', message: `the answer does not fit its schema: ${problems[0]}` }
	for (const kind of kindsIn(a.result))
		if (!q.returns.includes(kind))
			return {
				ok: false,
				code: 'R3',
				message: `the answer names ${kind}, which this query does not declare`,
			}
	const res = a.result as { kind?: string; columns?: unknown } | undefined
	if (res && typeof res.kind === 'string' && Array.isArray(res.columns)) {
		const declared =
			manifest.produces.find((d) => d.id === res.kind)?.fields.map((f) => f.name) ?? []
		for (const c of res.columns)
			if (typeof c !== 'string' || !declared.includes(c))
				return {
					ok: false,
					code: 'R3',
					message: `the answer has a column ${String(c)} the manifest does not declare`,
				}
	}
	return { ok: true, result: a.result }
}

/** The host's run-time check on an action's answer: it fits the action's schema and its size (R2). */
export function checkActionAnswer(
	manifest: Manifest,
	actionId: string,
	answer: unknown,
	schema: unknown,
	bytes: number,
): { ok: true; result: unknown } | { ok: false; code: 'R2'; message: string } {
	const a = manifest.contributes.endpoint.actions?.find((x) => x.id === actionId)
	if (!a) return { ok: false, code: 'R2', message: 'no such action' }
	if (bytes > a.maxBytes)
		return {
			ok: false,
			code: 'R2',
			message: `the answer is ${bytes} bytes; this action allows ${a.maxBytes}`,
		}
	const r = answer as { v?: number; ok?: boolean; result?: unknown } | null
	if (!r || typeof r !== 'object' || r.v !== 1 || typeof r.ok !== 'boolean')
		return { ok: false, code: 'R2', message: 'the reply is not a namzu-ext-query/2 answer' }
	if (!r.ok) return { ok: false, code: 'R2', message: 'the extension reported an error' }
	const problems = schemaProblems(schema, r.result)
	if (problems.length > 0)
		return { ok: false, code: 'R2', message: `the answer does not fit its schema: ${problems[0]}` }
	return { ok: true, result: r.result }
}
