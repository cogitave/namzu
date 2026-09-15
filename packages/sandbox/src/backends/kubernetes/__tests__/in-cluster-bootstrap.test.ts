/**
 * In-cluster ServiceAccount bootstrap: token/ca.crt/namespace fixture files
 * plus KUBERNETES_SERVICE_HOST/PORT stand in for the projected volume + the
 * env vars the kubelet sets for every pod. `serviceAccountDir` is the
 * override this test uses instead of the real
 * `/var/run/secrets/kubernetes.io/serviceaccount` path.
 *
 * The API server itself is a real loopback `https.createServer` presenting
 * the fixture CA's server leaf, so the whole path — CA trust, base-URL
 * construction, Authorization header — runs over an actual TLS handshake
 * rather than a stubbed transport.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKubernetesClient } from '../k8s-client.js'
import { CA_CRT, SERVER_CRT, SERVER_KEY } from './fixtures/https-pki.js'

let saDir: string
let server: HttpsServer | undefined
let seenAuthHeaders: string[]
const ORIGINAL_HOST = process.env.KUBERNETES_SERVICE_HOST
const ORIGINAL_PORT = process.env.KUBERNETES_SERVICE_PORT

beforeEach(async () => {
	saDir = mkdtempSync(join(tmpdir(), 'k8s-sa-'))
	seenAuthHeaders = []
	server = createHttpsServer({ cert: SERVER_CRT, key: SERVER_KEY }, (req, res) => {
		seenAuthHeaders.push(req.headers.authorization ?? '')
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ ok: true }))
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
	const address = server?.address() as AddressInfo
	process.env.KUBERNETES_SERVICE_HOST = '127.0.0.1'
	process.env.KUBERNETES_SERVICE_PORT = String(address.port)
})

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
	rmSync(saDir, { recursive: true, force: true })
	// process.env.X = undefined sets the string "undefined" rather than
	// removing the var, so delete is the only correct way to restore "not
	// set" here.
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	if (ORIGINAL_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
	else process.env.KUBERNETES_SERVICE_HOST = ORIGINAL_HOST
	// biome-ignore lint/performance/noDelete: must remove the var, not set "undefined".
	if (ORIGINAL_PORT === undefined) delete process.env.KUBERNETES_SERVICE_PORT
	else process.env.KUBERNETES_SERVICE_PORT = ORIGINAL_PORT
})

function writeServiceAccountFixture(token: string, namespace = 'namzu-tasks'): void {
	writeFileSync(join(saDir, 'token'), token, 'utf8')
	writeFileSync(join(saDir, 'ca.crt'), CA_CRT, 'utf8')
	writeFileSync(join(saDir, 'namespace'), namespace, 'utf8')
}

describe('in-cluster bootstrap', () => {
	it('reads token/ca.crt/namespace plus env and dials the expected base URL with the bearer header', async () => {
		writeServiceAccountFixture('initial-token', 'namzu-tasks')
		const client = createKubernetesClient({ inCluster: true, serviceAccountDir: saDir })

		expect(client.namespace()).toBe('namzu-tasks')
		const result = await client.request<{ ok: boolean }>(
			'GET',
			'/apis/agents.x-k8s.io/v1/namespaces/namzu-tasks/sandboxes',
		)

		expect(result).toEqual({ ok: true })
		expect(seenAuthHeaders).toEqual(['Bearer initial-token'])
	})

	it('picks up a rotated token file on the second call without caching the first', async () => {
		writeServiceAccountFixture('token-one')
		const client = createKubernetesClient({ inCluster: true, serviceAccountDir: saDir })

		await client.request('GET', '/apis/agents.x-k8s.io/v1/namespaces/namzu-tasks/sandboxes')
		writeFileSync(join(saDir, 'token'), 'token-two', 'utf8')
		await client.request('GET', '/apis/agents.x-k8s.io/v1/namespaces/namzu-tasks/sandboxes')

		expect(seenAuthHeaders).toEqual(['Bearer token-one', 'Bearer token-two'])
	})

	it('throws when KUBERNETES_SERVICE_HOST/PORT are missing', () => {
		writeServiceAccountFixture('t')
		// biome-ignore lint/performance/noDelete: see the afterEach comment above.
		delete process.env.KUBERNETES_SERVICE_HOST
		// biome-ignore lint/performance/noDelete: see the afterEach comment above.
		delete process.env.KUBERNETES_SERVICE_PORT
		expect(() => createKubernetesClient({ inCluster: true, serviceAccountDir: saDir })).toThrow()
	})
})
