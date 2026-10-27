import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

/**
 * Certificates are checked by the process that makes the connection, and Node
 * reads `NODE_EXTRA_CA_CERTS` once, when it starts. So each case runs a child
 * process that installs the network settings and makes one request to a real
 * HTTPS server on loopback, and reports what happened.
 */

function hasOpenssl(): boolean {
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}
const openssl = hasOpenssl()

const here = dirname(fileURLToPath(import.meta.url))

/** The tsx loader that lets a child process import the TypeScript source. */
function tsxLoader(): string {
	for (let dir = here; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
		if (existsSync(candidate)) return pathToFileURL(candidate).href
		if (dirname(dir) === dir) throw new Error('tsx is not installed')
	}
}

interface Pair {
	readonly cert: string
	readonly key: string
}

let dir: string
let server: Server | undefined
const roots: string[] = []

function makePair(name: string, subject: string, passphrase?: string): Pair {
	const key = join(dir, `${name}.key`)
	const cert = join(dir, `${name}.crt`)
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'ec',
			'-pkeyopt',
			'ec_paramgen_curve:prime256v1',
			...(passphrase ? ['-passout', `pass:${passphrase}`] : ['-nodes']),
			'-keyout',
			key,
			'-out',
			cert,
			'-days',
			'2',
			'-subj',
			`/CN=${subject}`,
			'-addext',
			'subjectAltName=IP:127.0.0.1',
			'-addext',
			'basicConstraints=critical,CA:TRUE',
		],
		{ stdio: 'ignore' },
	)
	return { cert, key }
}

async function serve(pair: Pair, clientCa?: Pair): Promise<number> {
	server = createServer(
		{
			cert: readFileSync(pair.cert),
			key: readFileSync(pair.key),
			...(clientCa
				? { requestCert: true, rejectUnauthorized: true, ca: readFileSync(clientCa.cert) }
				: {}),
		},
		(req, res) => {
			const peer = (
				req.socket as unknown as { getPeerCertificate(): { subject?: { CN?: string } } }
			).getPeerCertificate()
			res.end(`client:${peer.subject?.CN ?? 'none'}`)
		},
	)
	await new Promise<void>((resolveListen) => server?.listen(0, '127.0.0.1', resolveListen))
	return (server.address() as AddressInfo).port
}

interface Outcome {
	readonly status?: number
	readonly body?: string
	readonly errorCodes?: readonly string[]
	readonly reported: readonly string[]
}

/** One request from a fresh process that has installed the network settings. */
async function request(url: string, env: Record<string, string>): Promise<Outcome> {
	const script = join(dir, 'request.mjs')
	writeFileSync(
		script,
		`const reported = []
const { installNetwork } = await import(${JSON.stringify(pathToFileURL(resolve(here, 'install.ts')).href)})
await installNetwork({ report: (message) => reported.push(message) })
try {
  const response = await fetch(${JSON.stringify(url)})
  console.log(JSON.stringify({ status: response.status, body: await response.text(), reported }))
} catch (error) {
  const codes = []
  for (let e = error; e; e = e.cause) if (e.code) codes.push(e.code)
  console.log(JSON.stringify({ errorCodes: codes, reported }))
}
`,
	)
	const child = spawn(process.execPath, ['--import', tsxLoader(), script], {
		env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let out = ''
	let err = ''
	child.stdout.on('data', (chunk) => {
		out += chunk
	})
	child.stderr.on('data', (chunk) => {
		err += chunk
	})
	const code = await new Promise<number | null>((done) => child.on('close', done))
	if (code !== 0) throw new Error(`the child exited ${code}: ${err}`)
	return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Outcome
}

beforeAll(() => {
	if (!openssl) console.warn('openssl is not installed here, so the certificate cases are skipped')
})

afterEach(async () => {
	if (server) {
		server.closeAllConnections()
		await new Promise<void>((done) => server?.close(() => done()))
		server = undefined
	}
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fresh(): void {
	dir = mkdtempSync(join(tmpdir(), 'namzu-tls-'))
	roots.push(dir)
}

// Each case starts a Node process and compiles the source with tsx, which is
// real subprocess work, so it gets more than the default five seconds.
const SLOW = 60_000

describe.skipIf(!openssl)('certificates', () => {
	it(
		'trusts a certificate authority named in NODE_EXTRA_CA_CERTS, and refuses the server without it',
		async () => {
			fresh()
			const serverPair = makePair('server', '127.0.0.1')
			const port = await serve(serverPair)
			const url = `https://127.0.0.1:${port}/`

			const without = await request(url, {})
			expect(without.status).toBeUndefined()
			expect(without.errorCodes?.some((code) => /SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))).toBe(
				true,
			)

			const trusted = await request(url, { NODE_EXTRA_CA_CERTS: serverPair.cert })
			expect(trusted).toMatchObject({ status: 200, body: 'client:none' })
		},
		SLOW,
	)

	it(
		'still trusts it with a proxy installed, since the dispatcher is built on Node’s own trust store',
		async () => {
			fresh()
			const serverPair = makePair('server', '127.0.0.1')
			const port = await serve(serverPair)
			const outcome = await request(`https://127.0.0.1:${port}/`, {
				NODE_EXTRA_CA_CERTS: serverPair.cert,
				// Skipped for this host, so the request is direct but the dispatcher is the proxy-aware one.
				HTTPS_PROXY: 'http://127.0.0.1:9',
				NO_PROXY: '127.0.0.1',
			})
			expect(outcome).toMatchObject({ status: 200 })
		},
		SLOW,
	)

	it(
		'presents the client certificate to a server that asks for one',
		async () => {
			fresh()
			const serverPair = makePair('server', '127.0.0.1')
			const clientPair = makePair('client', 'namzu-test-client')
			const port = await serve(serverPair, clientPair)
			const url = `https://127.0.0.1:${port}/`

			const without = await request(url, { NODE_EXTRA_CA_CERTS: serverPair.cert })
			expect(without.status).toBeUndefined()

			const presented = await request(url, {
				NODE_EXTRA_CA_CERTS: serverPair.cert,
				NAMZU_CLIENT_CERT: clientPair.cert,
				NAMZU_CLIENT_KEY: clientPair.key,
			})
			expect(presented).toMatchObject({ status: 200, body: 'client:namzu-test-client' })
		},
		SLOW,
	)

	it(
		'opens a client key that has a passphrase',
		async () => {
			fresh()
			const serverPair = makePair('server', '127.0.0.1')
			const clientPair = makePair('client', 'namzu-test-client', 'correct horse')
			const port = await serve(serverPair, clientPair)
			const outcome = await request(`https://127.0.0.1:${port}/`, {
				NODE_EXTRA_CA_CERTS: serverPair.cert,
				NAMZU_CLIENT_CERT: clientPair.cert,
				NAMZU_CLIENT_KEY: clientPair.key,
				NAMZU_CLIENT_KEY_PASSPHRASE: 'correct horse',
			})
			expect(outcome).toMatchObject({ status: 200, body: 'client:namzu-test-client' })
		},
		SLOW,
	)
})
