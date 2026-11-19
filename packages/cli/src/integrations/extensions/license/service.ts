import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Manifest } from '../types.js'
import {
	ANSWER_MAX_BYTES,
	type AnswerCheck,
	type AnswerOp,
	checkAnswer,
	reopenEnvelope,
} from './answer.js'
import {
	type ServiceCache,
	type ServiceState,
	computeState,
	nextAttemptAt,
	readCache,
	readSecret,
	writeCache,
	writeSecret,
} from './cache.js'
import type { LicenseVerifierKey } from './key.js'

/**
 * The client of the publisher's licence service (`namzu-license/1`). Namzu makes every request itself:
 * HTTPS only, the one host the manifest declares for the licence check, no redirect, 10 s, small
 * bodies, no cookies, no credentials header. The extension process never sees the key.
 */

export const REQUEST_TIMEOUT_MS = 10_000
export const REQUEST_MAX_BYTES = 2048
export const RETRY_AFTER_MAX_S = 3600
export const USER_AGENT_PREFIX = 'namzu/'

export interface TransportRequest {
	readonly url: string
	readonly body: string
}
export interface TransportResponse {
	readonly status: number
	readonly contentType: string
	readonly body: string
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

/** The default transport. A redirect is an answer like any other: it is not followed, so it never verifies. */
export function nodeTransport(hostVersion: string): Transport {
	return (req) =>
		new Promise<TransportResponse>((resolve, reject) => {
			const u = new URL(req.url)
			const send = u.protocol === 'http:' ? httpRequest : httpsRequest
			const r = send(
				{
					method: 'POST',
					hostname: u.hostname,
					port: u.port || undefined,
					path: `${u.pathname}${u.search}`,
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json',
						'User-Agent': `${USER_AGENT_PREFIX}${hostVersion} license/1`,
						'Content-Length': Buffer.byteLength(req.body),
					},
				},
				(res) => {
					const chunks: Buffer[] = []
					let size = 0
					res.on('data', (c: Buffer) => {
						size += c.length
						if (size > ANSWER_MAX_BYTES) {
							res.destroy()
							resolve({
								status: res.statusCode ?? 0,
								contentType: String(res.headers['content-type'] ?? ''),
								body: 'x'.repeat(size),
							})
							return
						}
						chunks.push(c)
					})
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							contentType: String(res.headers['content-type'] ?? ''),
							body: Buffer.concat(chunks).toString('utf8'),
						}),
					)
					res.on('error', reject)
				},
			)
			r.on('error', reject)
			r.end(req.body)
		})
}

export type CallResult =
	| {
			kind: 'answer'
			check: Extract<AnswerCheck, { ok: true }>
			envelope: string
	  }
	| { kind: 'refused'; why: Extract<AnswerCheck, { ok: false }>['why'] }
	| { kind: 'error'; code: string; retryAfterSec?: number }
	| { kind: 'unreachable' }

export type ActivateOutcome =
	| { ok: true; state: ServiceState }
	| { ok: false; code: string; message: string }

/** What a person reads for each refusal: Namzu's words, never text from the service. */
export const ERROR_WORDS: Readonly<Record<string, string>> = {
	'invalid-key': 'That licence key was not found.',
	'wrong-extension': 'That licence key is for a different extension.',
	'seats-exhausted': 'All seats of this licence are in use.',
	'unsupported-version': 'The licence service does not support this version of Namzu.',
	'bad-request': 'The licence service did not accept the request.',
	'rate-limited': 'The licence service asked to try again later.',
	unavailable: 'The licence service is not available right now.',
	unreachable: 'The licence service could not be reached.',
	'clock-skew': "Your computer's clock is off by more than ten minutes.",
	refused: 'The answer of the licence service could not be trusted, so it was not used.',
}

export interface ServiceLicenceOptions {
	readonly manifest: Manifest
	readonly verifierKey: LicenseVerifierKey
	readonly machineHash: string
	readonly hostVersion: string
	readonly cacheFile: string
	readonly secretFile: string
	readonly transport: Transport
	readonly now: () => number
	readonly devMode: boolean
	/** DEV only, and only with a `dev-` key: replaces the manifest's base address. */
	readonly baseOverride?: string
	readonly audit: (event: LicenceAudit, detail?: string) => void
	readonly highWater?: () => number | undefined
}

export type LicenceAudit =
	| 'license-activated'
	| 'license-refreshed'
	| 'license-refresh-failed'
	| 'license-grace'
	| 'license-revoked'
	| 'license-released'
	| 'license-answer-refused'

type ServiceSection = Extract<Manifest['licensing'], { kind: 'service' }>['service']

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms)
		p.then(
			(v) => {
				clearTimeout(t)
				resolve(v)
			},
			(e) => {
				clearTimeout(t)
				reject(e)
			},
		)
	})

export class ServiceLicence {
	private inFlight = false
	private readonly svc: ServiceSection

	constructor(private readonly o: ServiceLicenceOptions) {
		const l = o.manifest.licensing
		if (l.kind !== 'service') throw new Error('not a service licence')
		this.svc = l.service
	}

	private baseUrl(): string {
		const dev = this.o.devMode && this.o.verifierKey.keyId.startsWith('dev-')
		return (dev && this.o.baseOverride ? this.o.baseOverride : this.svc.baseUrl).replace(/\/$/, '')
	}

	/**
	 * The stored answer, re-verified on every read: the payload and the lifetime come from the signed
	 * bytes, so editing the file cannot make a licence longer or turn a revoked one active. A file
	 * that fails the check counts as no licence.
	 */
	private read(): ServiceCache | undefined {
		const c = readCache(this.o.cacheFile)
		if (!c) return undefined
		const v = reopenEnvelope({
			envelope: c.envelope,
			verifierKey: this.o.verifierKey,
			keyId: this.svc.verifier.keyId,
			extensionId: this.o.manifest.id,
			machineHash: this.o.machineHash,
			devMode: this.o.devMode,
		})
		if (!v) return undefined
		return { ...c, payload: v.payload, validUntil: v.validUntil }
	}

	state(): ServiceState {
		return computeState({
			cache: this.read(),
			offlineGraceDays: this.svc.offlineGraceDays,
			now: this.o.now(),
			highWater: this.o.highWater?.(),
		})
	}

	hasKey(): boolean {
		return readSecret(this.o.secretFile) !== undefined
	}

	cache(): ServiceCache | undefined {
		return this.read()
	}

	/**
	 * The claims the extension may read, checked by Namzu: never the key and never the activation id.
	 * The signed envelope is not passed on, because its payload carries the activation id.
	 */
	answerForExtension(): string | undefined {
		const c = this.read()
		if (!c) return undefined
		const { activationId: _a, ...rest } = c.payload as unknown as Record<string, unknown>
		return JSON.stringify({ claims: rest })
	}

	private body(op: AnswerOp, nonce: string, extra: Record<string, unknown>): string {
		const sends = this.svc.sends
		const b: Record<string, unknown> = { v: 1, op, nonce, ...extra }
		if (sends.includes('extensionId')) b.extensionId = this.o.manifest.id
		if (sends.includes('extensionVersion')) b.extensionVersion = this.o.manifest.version
		if (sends.includes('hostVersion')) b.hostVersion = this.o.hostVersion
		return JSON.stringify(b)
	}

	private async call(op: AnswerOp, extra: Record<string, unknown>): Promise<CallResult> {
		const nonce = randomBytes(16).toString('base64url')
		const body = this.body(op, nonce, extra)
		if (Buffer.byteLength(body) > REQUEST_MAX_BYTES) return { kind: 'unreachable' }
		if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
			this.o.audit('license-answer-refused', 'tls-checks-switched-off')
			return { kind: 'unreachable' }
		}
		let res: TransportResponse
		try {
			res = await withTimeout(
				this.o.transport({ url: `${this.baseUrl()}/${op}`, body }),
				REQUEST_TIMEOUT_MS,
			)
		} catch {
			return { kind: 'unreachable' }
		}
		if (res.status === 200) {
			if (!/^application\/json\b/i.test(res.contentType)) {
				this.o.audit('license-answer-refused', 'content-type')
				return { kind: 'refused', why: 'not-json' }
			}
			const check = checkAnswer({
				text: res.body,
				verifierKey: this.o.verifierKey,
				keyId: this.svc.verifier.keyId,
				extensionId: this.o.manifest.id,
				machineHash: this.o.machineHash,
				op,
				nonce,
				now: this.o.now(),
				devMode: this.o.devMode,
			})
			if (!check.ok) {
				this.o.audit('license-answer-refused', check.why)
				return { kind: 'refused', why: check.why }
			}
			if (check.clamped) this.o.audit('license-answer-refused', 'lifetime-clamped')
			return { kind: 'answer', check, envelope: res.body }
		}
		// An unsigned error: it can say what happened to this attempt, never change a licence state.
		let code = res.status >= 500 ? 'unavailable' : 'bad-request'
		let retryAfterSec: number | undefined
		try {
			const j = JSON.parse(res.body) as {
				error?: { code?: unknown; retryAfterSec?: unknown }
			}
			if (typeof j.error?.code === 'string' && j.error.code in ERROR_WORDS) code = j.error.code
			if (typeof j.error?.retryAfterSec === 'number' && j.error.retryAfterSec > 0)
				retryAfterSec = Math.min(j.error.retryAfterSec, RETRY_AFTER_MAX_S)
		} catch {
			// an unreadable error body is an unavailable service
		}
		return { kind: 'error', code, ...(retryAfterSec ? { retryAfterSec } : {}) }
	}

	private guard<T>(fn: () => Promise<T>, busy: T): Promise<T> {
		if (this.inFlight) return Promise.resolve(busy)
		this.inFlight = true
		return fn().finally(() => {
			this.inFlight = false
		})
	}

	private fail(code: string): ActivateOutcome {
		return {
			ok: false,
			code,
			message: ERROR_WORDS[code] ?? ERROR_WORDS.refused ?? '',
		}
	}

	/** First activation with the key the person typed. The key is stored only after a signed answer. */
	activate(licenseKey: string): Promise<ActivateOutcome> {
		return this.guard<ActivateOutcome>(async () => {
			const r = await this.call('activate', {
				licenseKey,
				machineHash: this.o.machineHash,
			})
			if (r.kind === 'unreachable') return this.fail('unreachable')
			if (r.kind === 'refused') return this.fail(r.why === 'clock-skew' ? 'clock-skew' : 'refused')
			if (r.kind === 'error') return this.fail(r.code)
			this.store(r, licenseKey)
			this.o.audit(
				r.check.payload.status === 'active' ? 'license-activated' : 'license-revoked',
				r.check.payload.customer.id,
			)
			return { ok: true, state: this.state() }
		}, this.fail('unavailable'))
	}

	private store(r: Extract<CallResult, { kind: 'answer' }>, licenseKey?: string): void {
		const p = r.check.payload
		const old = this.read()
		writeCache(this.o.cacheFile, {
			schema: 1,
			kind: 'service',
			activationId: p.activationId || old?.activationId || '',
			envelope: r.envelope,
			payload: p,
			validUntil: r.check.validUntil,
			receivedAt: this.o.now(),
			lastAttemptAt: this.o.now(),
			failures: 0,
		})
		if (licenseKey !== undefined) writeSecret(this.o.secretFile, licenseKey)
	}

	/** Whether a refresh is due now (the due time, or the retry schedule after a failure). */
	due(): boolean {
		const c = this.read()
		if (!c || c.payload.status !== 'active') return false
		return this.o.now() >= nextAttemptAt(c, this.svc.refreshHours)
	}

	/** The time of the next refresh attempt, or undefined with nothing to refresh. */
	nextAt(): number | undefined {
		const c = this.read()
		if (!c || c.payload.status !== 'active') return undefined
		return nextAttemptAt(c, this.svc.refreshHours)
	}

	/** Refresh the cached answer. Only a signed answer changes the state; a failed attempt only counts. */
	refresh(): Promise<{
		changed: boolean
		state: ServiceState
		error?: string
	}> {
		return this.guard(
			async () => {
				const c = this.read()
				if (!c) return { changed: false, state: this.state() }
				const r = await this.call('refresh', {
					activationId: c.activationId,
					machineHash: this.o.machineHash,
				})
				if (r.kind === 'answer') {
					const before = c.payload.status
					this.store(r)
					const after = r.check.payload.status
					this.o.audit(
						after === 'active' ? 'license-refreshed' : 'license-revoked',
						after === before ? undefined : after,
					)
					return { changed: true, state: this.state() }
				}
				if (r.kind === 'error' && (r.code === 'invalid-key' || r.code === 'wrong-extension')) {
					// The activation is unknown to the service: one more activation with the stored key.
					const key = readSecret(this.o.secretFile)
					this.noteFailure(c, r.code)
					if (key) {
						const again = await this.call('activate', {
							licenseKey: key,
							machineHash: this.o.machineHash,
						})
						if (again.kind === 'answer') {
							this.store(again)
							this.o.audit('license-activated', again.check.payload.customer.id)
							return { changed: true, state: this.state() }
						}
					}
					return { changed: false, state: this.state(), error: r.code }
				}
				const code = r.kind === 'error' ? r.code : r.kind === 'refused' ? 'refused' : 'unreachable'
				this.noteFailure(c, code, r.kind === 'error' ? r.retryAfterSec : undefined)
				return { changed: false, state: this.state(), error: code }
			},
			{ changed: false, state: this.state() } as {
				changed: boolean
				state: ServiceState
				error?: string
			},
		)
	}

	private noteFailure(c: ServiceCache, code: string, retryAfterSec?: number): void {
		writeCache(this.o.cacheFile, {
			...c,
			lastAttemptAt: this.o.now(),
			lastError: code,
			failures: c.failures + 1,
			...(retryAfterSec ? { retryNotBefore: this.o.now() + retryAfterSec * 1000 } : {}),
		})
		this.o.audit('license-refresh-failed', code)
	}

	/** Tell the service to free the seat. A best effort: it never blocks anything. */
	release(): Promise<{ released: boolean }> {
		return this.guard(
			async () => {
				const c = this.read()
				if (!c) return { released: false }
				const r = await this.call('release', {
					activationId: c.activationId,
					machineHash: this.o.machineHash,
				})
				const released = r.kind === 'answer'
				if (released) this.o.audit('license-released')
				return { released }
			},
			{ released: false },
		)
	}
}
