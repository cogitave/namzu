/**
 * An in-process API server for backend-level tests.
 *
 * A real `node:http` listener rather than a stubbed `globalThis.fetch`,
 * because what these tests are checking IS the HTTP shape: which paths are
 * hit, in what order, and exactly what JSON goes up on the create. A fetch
 * stub would let a body change shape without a single assertion noticing.
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
	readonly method: string
	/** Path plus query string, exactly as the client sent it. */
	readonly path: string
	readonly body: unknown
}

export interface FakeApiReply {
	readonly status: number
	readonly body?: unknown
}

export interface FakeApiServer {
	readonly url: string
	/** Every request, in order, including the ones the handler refused. */
	readonly requests: readonly RecordedRequest[]
	matching(method: string, pathFragment: string): readonly RecordedRequest[]
	close(): Promise<void>
}

export async function startFakeApiServer(
	handle: (request: RecordedRequest) => FakeApiReply | Promise<FakeApiReply>,
): Promise<FakeApiServer> {
	const requests: RecordedRequest[] = []
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			const recorded: RecordedRequest = {
				method: req.method ?? 'GET',
				path: req.url ?? '',
				body: raw.length > 0 ? JSON.parse(raw) : undefined,
			}
			requests.push(recorded)
			void Promise.resolve(handle(recorded)).then(
				(reply) => {
					res.writeHead(reply.status, { 'content-type': 'application/json' })
					res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
				},
				(error: unknown) => {
					res.writeHead(500, { 'content-type': 'application/json' })
					res.end(JSON.stringify({ message: String(error) }))
				},
			)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		matching: (method, pathFragment) =>
			requests.filter((r) => r.method === method && r.path.includes(pathFragment)),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

/** A `status.conditions` entry the CRDs' own required fields are satisfied by. */
export function readyCondition(status: 'True' | 'False' | 'Unknown' = 'True'): {
	type: string
	status: string
	reason: string
	message: string
	lastTransitionTime: string
} {
	return {
		type: 'Ready',
		status,
		reason: status === 'True' ? 'DependenciesReady' : 'Pending',
		message: status === 'True' ? 'Pod is Ready; Service Exists' : 'waiting',
		lastTransitionTime: '2026-09-15T00:00:00Z',
	}
}
