import { sign as edSign } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ANSWER_PREFIX } from '../license/answer.js'
import { type TestKey, makeKey } from './package-builder.js'

/**
 * Test-only: the publisher's licence service on 127.0.0.1 with its own ephemeral key, an injectable
 * clock and a call log, so a test asserts exactly what was sent. Not a product; it never ships.
 */

export type Scenario =
	| 'ok'
	| 'seats-exhausted'
	| 'invalid-key'
	| 'revoked'
	| 'suspended'
	| 'expired'
	| 'rate-limited'
	| 'unavailable'
	| 'slow'
	| 'offline'
	| 'bad-signature'
	| 'wrong-nonce'
	| 'replayed'
	| 'wrong-machine'
	| 'wrong-extension'
	| 'old-issued-at'
	| 'long-lifetime'
	| 'oversized'
	| 'not-json'
	| 'unsigned-403-with-valid-cache'
	| 'wrong-content-type'

export interface Call {
	op: string
	body: Record<string, unknown>
	headers: Record<string, string | string[] | undefined>
}

const HOUR = 3_600_000
const DAY = 86_400_000

export class FakeLicenseService {
	readonly key: TestKey
	private readonly other: TestKey
	scenario: Scenario = 'ok'
	calls: Call[] = []
	/** The one key this service knows. */
	goodKey = 'GOOD-KEY-1234'
	validHours = 24
	entitlementDays = 365
	seats = 25
	private server: Server | undefined
	private lastOk: string | undefined
	private held: ServerResponse[] = []

	constructor(
		readonly extensionId: string,
		readonly now: () => number = Date.now,
		keyId = 'dev-lic-svc',
	) {
		this.key = makeKey(keyId)
		this.other = makeKey(keyId)
	}

	get url(): string {
		return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/v1`
	}

	/** The licence key file the package carries, matching this service's key. */
	get keyFile(): string {
		return JSON.stringify({
			keyId: this.key.id,
			algorithm: 'ed25519',
			publicKey: this.key.publicB64,
		})
	}

	async listen(): Promise<void> {
		this.server = createServer((req, res) => void this.handle(req, res))
		await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r))
	}

	async close(): Promise<void> {
		for (const r of this.held) r.destroy()
		this.held = []
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
		this.server?.closeAllConnections?.()
	}

	/** Answer every request held by the `slow` scenario with an unavailable error. */
	releaseSlow(): void {
		for (const r of this.held) this.json(r, 503, { v: 1, error: { code: 'unavailable' } })
		this.held = []
	}

	private json(
		res: ServerResponse,
		status: number,
		body: unknown,
		type = 'application/json',
	): void {
		res.writeHead(status, { 'Content-Type': type })
		res.end(typeof body === 'string' ? body : JSON.stringify(body))
	}

	envelope(payload: Record<string, unknown>, signer: TestKey = this.key): string {
		const bytes = Buffer.from(JSON.stringify(payload))
		const signature = edSign(
			null,
			Buffer.concat([Buffer.from(ANSWER_PREFIX), bytes]),
			signer.privateKey,
		).toString('base64')
		return JSON.stringify({
			v: 1,
			keyId: this.key.id,
			payload: bytes.toString('base64url'),
			signature,
		})
	}

	private payload(op: string, status: string, body: Record<string, unknown>) {
		const t = this.now()
		return {
			v: 1,
			op,
			status,
			licenseId: 'lic-0001',
			activationId: 'act-1',
			extensionId: this.extensionId,
			machineHash: body.machineHash,
			nonce: body.nonce,
			issuedAt: new Date(t).toISOString(),
			validUntil: new Date(t + this.validHours * HOUR).toISOString(),
			expires: new Date(t + this.entitlementDays * DAY).toISOString(),
			customer: { id: 'cust-1', name: 'Example Customer' },
			seats: this.seats,
			features: ['pro'],
			message: status === 'revoked' || status === 'suspended' ? status : null,
		}
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = []
		for await (const c of req) chunks.push(c as Buffer)
		const op = (req.url ?? '').split('/').pop() ?? ''
		let body: Record<string, unknown> = {}
		try {
			body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		} catch {
			// a request the client could not have made
		}
		this.calls.push({ op, body, headers: req.headers })
		const s = this.scenario
		switch (s) {
			case 'offline':
				req.socket.destroy()
				return
			case 'slow':
				this.held.push(res)
				return
			case 'seats-exhausted':
				return this.json(res, 409, { v: 1, error: { code: 'seats-exhausted' } })
			case 'invalid-key':
				return this.json(res, 404, { v: 1, error: { code: 'invalid-key' } })
			case 'unsigned-403-with-valid-cache':
				return this.json(res, 403, { v: 1, error: { code: 'invalid-key' } })
			case 'rate-limited':
				return this.json(res, 429, { v: 1, error: { code: 'rate-limited', retryAfterSec: 120 } })
			case 'unavailable':
				return this.json(res, 503, { v: 1, error: { code: 'unavailable' } })
			case 'not-json':
				return this.json(res, 200, 'this is not json')
			case 'oversized':
				return this.json(res, 200, 'x'.repeat(20_000))
			case 'wrong-content-type':
				return this.json(res, 200, this.envelope(this.payload(op, 'active', body)), 'text/plain')
			case 'replayed':
				if (this.lastOk) return this.json(res, 200, this.lastOk)
				break
			default:
				break
		}
		if (op === 'activate' && body.licenseKey !== this.goodKey)
			return this.json(res, 404, { v: 1, error: { code: 'invalid-key' } })
		const status =
			s === 'revoked' || s === 'suspended' || s === 'expired'
				? s
				: op === 'release'
					? 'released'
					: 'active'
		const p: Record<string, unknown> = this.payload(op, status, body)
		let signer = this.key
		if (s === 'bad-signature') signer = this.other
		if (s === 'wrong-nonce') p.nonce = 'another-nonce'
		if (s === 'wrong-machine') p.machineHash = 'another-machine'
		if (s === 'wrong-extension') p.extensionId = 'com.other.thing'
		if (s === 'old-issued-at') p.issuedAt = new Date(this.now() - HOUR).toISOString()
		if (s === 'long-lifetime') p.validUntil = new Date(this.now() + 90 * DAY).toISOString()
		const text = this.envelope(p, signer)
		if (s === 'ok') this.lastOk = text
		this.json(res, 200, text)
	}
}
