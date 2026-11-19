import { readFileSync, rmSync } from 'node:fs'
import { atomicWrite } from '../store.js'
import type { AnswerPayload } from './answer.js'

/**
 * What Namzu keeps for a service licence, per extension and per OS user: the signed answer and its
 * bookkeeping (`license.json`) and the key the person typed (`license-secret.json`, never returned by
 * any method). The licence state is computed from this file and the clock only, never from the network.
 */

export const DAY = 86_400_000
export const CLOCK_SLACK_MS = DAY

export interface ServiceCache {
	schema: 1
	kind: 'service'
	activationId: string
	/** The signed envelope exactly as received (the extension may verify it with its own copy of the key). */
	envelope: string
	/** The payload of that envelope, already checked; `validUntil` is the clamped value. */
	payload: AnswerPayload
	validUntil: number
	receivedAt: number
	lastAttemptAt: number
	lastError?: string
	/** Consecutive failed refresh attempts, for the retry schedule. */
	failures: number
	/** A rate-limited answer's wait: nothing is tried before this time. */
	retryNotBefore?: number
}

export type ServiceState =
	| { state: 'needs-license' }
	| { state: 'ok'; payload: AnswerPayload; validUntil: number }
	| { state: 'license-grace'; payload: AnswerPayload; daysLeft: number }
	| {
			state: 'license-expired'
			reason: 'expired' | 'grace-over' | 'clock' | 'released'
	  }
	| {
			state: 'license-revoked'
			reason: 'revoked' | 'suspended'
			message: string | null
	  }

export function readCache(file: string): ServiceCache | undefined {
	try {
		const j = JSON.parse(readFileSync(file, 'utf8')) as ServiceCache
		return j && j.schema === 1 && j.kind === 'service' && typeof j.envelope === 'string'
			? j
			: undefined
	} catch {
		return undefined
	}
}

export function writeCache(file: string, c: ServiceCache): void {
	atomicWrite(file, `${JSON.stringify(c, null, 2)}\n`, 0o600)
}

export function readSecret(file: string): string | undefined {
	try {
		const k = (JSON.parse(readFileSync(file, 'utf8')) as { licenseKey?: unknown }).licenseKey
		return typeof k === 'string' && k.length > 0 ? k : undefined
	} catch {
		return undefined
	}
}

export function writeSecret(file: string, licenseKey: string): void {
	atomicWrite(file, `${JSON.stringify({ licenseKey })}\n`, 0o600)
}

export function dropCache(files: readonly string[]): void {
	for (const f of files) rmSync(f, { force: true })
}

export function computeState(input: {
	cache: ServiceCache | undefined
	offlineGraceDays: number
	now: number
	highWater?: number
}): ServiceState {
	const { cache, now } = input
	if (!cache) return { state: 'needs-license' }
	const p = cache.payload
	if (input.highWater !== undefined && now < input.highWater - CLOCK_SLACK_MS)
		return { state: 'license-expired', reason: 'clock' }
	switch (p.status) {
		case 'revoked':
		case 'suspended':
			return { state: 'license-revoked', reason: p.status, message: p.message }
		case 'expired':
			return { state: 'license-expired', reason: 'expired' }
		case 'released':
			return { state: 'needs-license' }
		default:
			break
	}
	const ends = Date.parse(p.expires)
	if (!Number.isNaN(ends) && now >= ends) return { state: 'license-expired', reason: 'expired' }
	if (now < cache.validUntil) return { state: 'ok', payload: p, validUntil: cache.validUntil }
	const graceEnd = cache.validUntil + input.offlineGraceDays * DAY
	if (now < graceEnd)
		return {
			state: 'license-grace',
			payload: p,
			daysLeft: Math.max(1, Math.ceil((graceEnd - now) / DAY)),
		}
	return { state: 'license-expired', reason: 'grace-over' }
}

const MIN = 60_000
const RETRY_MS = [1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN]

/** When the next refresh may be tried: the due time, then the retry schedule after a failure. */
export function nextAttemptAt(cache: ServiceCache, refreshHours: number): number {
	const issued = Date.parse(cache.payload.issuedAt)
	const due = (Number.isNaN(issued) ? cache.receivedAt : issued) + refreshHours * 3_600_000
	let at = due
	if (cache.failures > 0) {
		const wait = RETRY_MS[Math.min(cache.failures - 1, RETRY_MS.length - 1)] as number
		at = Math.max(due, cache.lastAttemptAt + wait)
	}
	if (cache.retryNotBefore !== undefined) at = Math.max(at, cache.retryNotBefore)
	return at
}
