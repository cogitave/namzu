/**
 * Provider error taxonomy — Zen driver.
 *
 * Zen is the one driver whose own `failure()` (`../client.ts`) does not
 * always get a vendor SDK's classified error object: the four wire adapters
 * it delegates to (`createOpenAICompatible`, `createOpenAI().responses`,
 * `createAnthropic`, `createGoogleGenerativeAI`) throw `APICallError` for an
 * HTTP-level failure, but a TRANSPORT failure — no response arrived at
 * all — surfaces as whatever the platform's own `fetch` rejected with, which
 * `failure()` has to fingerprint itself via `safeErrorEnvelope`.
 *
 * That fingerprinting used `Object.getOwnPropertyDescriptor` to read
 * `message`/`name`/`type`/`code`/`status`, which returns `undefined` for a
 * `DOMException` — the exact class `fetch` rejects with on `AbortSignal`
 * abort/timeout — because `DOMException.prototype` defines `message` and
 * `name` as prototype accessors, not own instance properties. The result
 * was silent: every field came back `undefined`, and the operator saw the
 * hardcoded fallback "The model stream failed." instead of the real
 * platform reason, on precisely the failure this function exists to
 * describe. See `docs`/PR discussion for the reproduction that reported
 * `big-pickle` as "provider.network" with no usable detail.
 *
 * Transport seam: `ZenConfig.baseURL` — a loopback server, so the REAL
 * `@ai-sdk/openai-compatible` adapter and the REAL `fetch`/`AbortSignal`
 * machinery run, exactly like the sibling drivers' own taxonomy suites.
 *
 * A second bug shared the same call site: `error.statusCode ?? 502`
 * fabricated an HTTP 502 for an `APICallError` that never got any HTTP
 * response at all (a transport failure such as `ECONNREFUSED`), which
 * `classifyProviderHttpStatus` then read as a genuine upstream 5xx — `kind:
 * 'server'` ("resume once it recovers") instead of `kind: 'network'` ("check
 * reachability"). Test (d) is the regression guard.
 *
 * Tests (f) and (g) cover the two remaining acceptance points: a real HTTP
 * response, even a failing one, is never reported as `network`; and the
 * classified error names the model that failed, not just the provider, so
 * an operator reading one line out of a log — or a run juggling several
 * models — can tell which request this was.
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ZenProvider } from '../client.js'

/** Obviously fake, non-functional token — present only as a leak probe. */
const FAKE_CREDENTIAL = 'zen-FAKE-DO-NOT-USE-0000'

interface ScriptedReply {
	status: number
	body: string
	headers?: Record<string, string>
}

let server: Server | undefined

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
})

async function startEndpoint(reply: ScriptedReply): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(reply.status, {
			'Content-Type': 'application/json',
			...(reply.headers ?? {}),
		})
		res.end(reply.body)
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}/v1`
}

/** Accepts the connection and reads the request, then never replies. */
async function startHangingEndpoint(): Promise<string> {
	server = createServer(() => {
		// Deliberately no res.writeHead/res.end: the client's own timeout,
		// not a scripted status, is what ends this request.
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}/v1`
}

async function drain(provider: ZenProvider, model = 'glm-5.3-flash'): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model,
			messages: [{ role: 'user', content: 'hi' }],
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

describe('@namzu/zen — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		const baseURL = await startEndpoint({
			status: 429,
			headers: { 'retry-after': '2' },
			body: JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
		})
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL })

		const err = await drain(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			retryAfterMs: 2000,
			providerId: 'zen',
		})
	}, 30_000)

	it("(b) 401 classifies as 'auth'", async () => {
		const baseURL = await startEndpoint({
			status: 401,
			body: JSON.stringify({ error: { message: 'Invalid API key' } }),
		})
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL })

		const err = await drain(provider)

		expect(err).toMatchObject({ name: 'ProviderRequestError', kind: 'auth', status: 401 })
	}, 30_000)

	it('(c) SECURITY: a credential echoed back in an error body never reaches the thrown message', async () => {
		const baseURL = await startEndpoint({
			status: 401,
			body: JSON.stringify({ error: { message: `Invalid key: ${FAKE_CREDENTIAL}` } }),
		})
		const provider = new ZenProvider({ apiKey: FAKE_CREDENTIAL, baseURL })

		const err = await drain(provider)

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	}, 30_000)

	it("(d) a connection that is refused outright classifies as 'network'", async () => {
		// Bind, read back the port, then close: nothing is listening by the
		// time the driver connects — an immediate ECONNREFUSED, no response
		// of any kind. The plainest transport failure there is.
		const closedPortURL = await startEndpoint({ status: 200, body: '{}' })
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL: closedPortURL })

		const err = await drain(provider)

		expect(err).toMatchObject({ name: 'ProviderRequestError', kind: 'network' })
		expect('cause' in (err as object)).toBe(false)
	}, 30_000)

	it("(e) a client-side timeout (no response arrives) classifies as 'network' AND keeps the platform's own reason in `detail`", async () => {
		const baseURL = await startHangingEndpoint()
		// Short enough to fail fast in CI; long enough that the request has
		// definitely reached the server before the client gives up.
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL, timeout: 200 })

		const err = await drain(provider)

		expect(err).toMatchObject({ name: 'ProviderRequestError', kind: 'network' })
		expect('cause' in (err as object)).toBe(false)
		// Regression guard: `fetch` rejects an aborted/timed-out request with a
		// `DOMException`, whose `message`/`name` live on the PROTOTYPE, not as
		// own properties. Before the fix, `safeErrorEnvelope` read this as
		// `undefined` for every field and fell back to the hardcoded
		// "The model stream failed.", discarding the platform's real reason.
		const detail = (err as { detail?: string }).detail ?? ''
		expect(detail.toLowerCase()).not.toBe('the model stream failed.')
		expect(detail.length).toBeGreaterThan(0)
	}, 30_000)

	it("(f) a 500 with a body classifies as 'server', carrying the real status and the provider's own words", async () => {
		const baseURL = await startEndpoint({
			status: 500,
			body: JSON.stringify({ error: { message: 'Upstream model backend crashed' } }),
		})
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL })

		const err = await drain(provider)

		// A real HTTP response — even a 500 — must never be reported as
		// 'network': the provider answered, it just answered badly.
		expect(err).toMatchObject({ name: 'ProviderRequestError', kind: 'server', status: 500 })
		expect((err as { detail?: string }).detail).toContain('Upstream model backend crashed')
	}, 30_000)

	it('(g) the reported big-pickle shape: a stalled connection to model "big-pickle" classifies as \'network\' and names the model in the message', async () => {
		// This is the owner's exact report: `big-pickle` on Zen, no HTTP
		// response ever arrives, and the operator sees only
		// "Error [provider.network]: The provider could not be reached." with
		// no way to tell which of a run's several models that was.
		const baseURL = await startHangingEndpoint()
		const provider = new ZenProvider({ apiKey: 'test-key', baseURL, timeout: 200 })

		const err = await drain(provider, 'big-pickle')

		expect(err).toMatchObject({ name: 'ProviderRequestError', kind: 'network' })
		expect('cause' in (err as object)).toBe(false)
		expect((err as Error).message).toContain('big-pickle')
		expect((err as { detail?: string }).detail ?? '').toContain('big-pickle')
	}, 30_000)
})
