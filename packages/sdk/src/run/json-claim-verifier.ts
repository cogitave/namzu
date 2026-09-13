import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { RunId } from '../types/ids/index.js'
import type { AnswerReviewContext } from '../types/run/answer-review.js'

/** Numbers are restricted to safe integers; use strings for exact decimal values. */
export type JsonClaimValue = string | number | boolean | null

export interface JsonClaimRequirement {
	readonly id: string
	/** Host-selected source identifier, never an address supplied by the candidate. */
	readonly source: string
	/** RFC 6901 pointer to a scalar in the complete JSON document. */
	readonly pointer: string
	/** Optional postcondition in addition to candidate/source equality. */
	readonly expected?: JsonClaimValue
}

export interface JsonClaimReadRequest {
	readonly scope: string
	readonly runId: RunId
	readonly iteration: number
	readonly requestId: string
	readonly startedAt: number
	/** Remaining total allowance. The host must bound capture, not only the returned buffer. */
	readonly maxBytes: number
	readonly signal: AbortSignal
}

export interface JsonClaimObservation {
	readonly scope: string
	readonly runId: RunId
	readonly iteration: number
	readonly requestId: string
	readonly source: string
	readonly observedAt: number
	readonly complete: boolean
	readonly kind: 'current' | 'historical'
	readonly bytes: Uint8Array
}

export interface JsonClaimReceipt {
	readonly scope: string
	readonly runId: RunId
	readonly iteration: number
	readonly claims: Readonly<Record<string, JsonClaimValue>>
	readonly observations: readonly {
		readonly source: string
		readonly requestId: string
		readonly observedAt: number
		readonly bytes: number
		readonly sha256: string
	}[]
}

export type JsonClaimVerdict =
	| { readonly accept: true; readonly receipt: JsonClaimReceipt }
	| { readonly accept: false; readonly feedback: string }

export interface JsonClaimVerifierOptions {
	/** Host-owned authorization scope, including the admitted revision/claim where applicable. */
	readonly scope: string
	readonly runId: RunId
	readonly requirements: readonly JsonClaimRequirement[]
	/**
	 * Trusted, read-only adapter. Enforce access, capture bounds and cancellation;
	 * observe during this call. A matching envelope is not authentication against
	 * a dishonest adapter. Do not replay an action or relabel an archive as current.
	 */
	readonly observe: (source: string, request: JsonClaimReadRequest) => Promise<JsonClaimObservation>
	/** Total captured source bytes per verification; default 1 MiB, at most 8 MiB. */
	readonly maxBytes?: number
	/** Whole verification deadline; default 2 seconds, at most 30 seconds. */
	readonly timeoutMs?: number
}

export interface JsonClaimVerifier {
	/** False while an observer is outstanding, including after timeout/cancellation. */
	isDrained(): boolean
	/** No success cache. Every call observes the configured sources again. */
	verify(
		claims: unknown,
		context: Pick<AnswerReviewContext, 'runId' | 'iteration' | 'signal'>,
	): Promise<JsonClaimVerdict>
}

function scalar(value: unknown): value is JsonClaimValue {
	return (
		value === null ||
		typeof value === 'boolean' ||
		(typeof value === 'string' && value.length <= 2_000) ||
		(typeof value === 'number' && Number.isSafeInteger(value))
	)
}

function reject(reason: string): JsonClaimVerdict {
	return {
		accept: false,
		feedback: `Claim verification failed: ${reason} Do not claim verified completion. Correct the claims using a permitted observation, or report that completion is unavailable.`,
	}
}

function pointerParts(pointer: string): string[] {
	if (pointer === '') return []
	if (!pointer.startsWith('/') || pointer.length > 512 || /~(?:[^01]|$)/u.test(pointer))
		throw new Error('Invalid JSON claim pointer.')
	return pointer
		.slice(1)
		.split('/')
		.map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function select(document: unknown, parts: readonly string[]): unknown {
	let value = document
	for (const part of parts) {
		if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
		if (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(part)) return undefined
		value = (value as Record<string, unknown>)[part]
	}
	return value
}

/**
 * Compare explicit candidate fields with fresh, host-authorized JSON observations.
 * This does not judge prose or prove the broader task complete. A receipt describes
 * observation time, not an atomic snapshot or continuing truth after the read.
 */
export function createJsonClaimVerifier(options: JsonClaimVerifierOptions): JsonClaimVerifier {
	const { scope, runId, observe } = options
	const maxBytes = options.maxBytes ?? 1_048_576
	const timeoutMs = options.timeoutMs ?? 2_000
	if (
		typeof scope !== 'string' ||
		!scope ||
		scope.length > 2_000 ||
		typeof runId !== 'string' ||
		!runId ||
		typeof observe !== 'function'
	)
		throw new Error('JSON claim verification requires a scope, run ID and observer.')
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 8_388_608 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 30_000
	)
		throw new Error('Invalid JSON claim verification bounds.')
	if (!options.requirements.length || options.requirements.length > 32)
		throw new Error('JSON claim verification requires 1–32 requirements.')
	const ids = new Set<string>()
	const requirements = options.requirements.map((item) => {
		if (
			!/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/u.test(item.id) ||
			ids.has(item.id) ||
			typeof item.source !== 'string' ||
			!item.source ||
			item.source.length > 512 ||
			typeof item.pointer !== 'string' ||
			(Object.hasOwn(item, 'expected') && !scalar(item.expected))
		)
			throw new Error('Invalid or duplicate JSON claim requirement.')
		ids.add(item.id)
		return { ...item, parts: pointerParts(item.pointer) }
	})
	let active = false
	let pending = 0
	return {
		isDrained: () => !active && pending === 0,
		async verify(claims, context) {
			context.signal?.throwIfAborted()
			if (
				context.runId !== runId ||
				!Number.isSafeInteger(context.iteration) ||
				context.iteration < 0
			)
				return reject('The review belongs to a different run or invalid iteration.')
			if (active || pending) return reject('A previous observation has not drained.')
			if (
				!claims ||
				typeof claims !== 'object' ||
				Array.isArray(claims) ||
				Object.keys(claims).length !== requirements.length ||
				Object.keys(claims).some((id) => !ids.has(id))
			)
				return reject('Supply exactly the configured claim IDs and scalar values.')
			const values: Record<string, JsonClaimValue> = Object.create(null)
			for (const item of requirements) {
				if (!Object.hasOwn(claims, item.id)) return reject('A required claim is missing.')
				const value = (claims as Record<string, unknown>)[item.id]
				if (!scalar(value)) return reject(`Claim ${item.id} is not a supported scalar.`)
				values[item.id] = value
			}
			active = true
			const controller = new AbortController()
			const expiresAt = performance.now() + timeoutMs
			const ensureActive = () => {
				// A synchronous adapter can delay timers; late bytes still cannot pass.
				if (performance.now() >= expiresAt) controller.abort(new Error('Verification timed out.'))
				controller.signal.throwIfAborted()
			}
			const onAbort = () => controller.abort(context.signal?.reason)
			context.signal?.addEventListener('abort', onAbort, { once: true })
			const timer = setTimeout(
				() => controller.abort(new Error('Verification timed out.')),
				timeoutMs,
			)
			const observations: JsonClaimReceipt['observations'][number][] = []
			let remaining = maxBytes
			let removeAbort: (() => void) | undefined
			try {
				for (const source of new Set(requirements.map((item) => item.source))) {
					ensureActive()
					if (remaining < 1) return reject('The source byte allowance is exhausted.')
					const request = Object.freeze({
						scope,
						runId,
						iteration: context.iteration,
						requestId: randomUUID(),
						startedAt: Date.now(),
						maxBytes: remaining,
						signal: controller.signal,
					})
					pending++
					const work = Promise.resolve()
						.then(() => {
							ensureActive()
							return observe(source, request)
						})
						.finally(() => {
							pending--
						})
					const aborted = new Promise<never>((_, fail) => {
						const listener = () => fail(controller.signal.reason)
						controller.signal.addEventListener('abort', listener, { once: true })
						removeAbort = () => controller.signal.removeEventListener('abort', listener)
					})
					const observation = await Promise.race([work, aborted])
					removeAbort?.()
					ensureActive()
					if (
						!observation ||
						observation.scope !== scope ||
						observation.runId !== runId ||
						observation.iteration !== context.iteration ||
						observation.requestId !== request.requestId ||
						observation.source !== source ||
						observation.complete !== true ||
						observation.kind !== 'current' ||
						!Number.isSafeInteger(observation.observedAt) ||
						observation.observedAt < request.startedAt ||
						observation.observedAt > Date.now() ||
						!(observation.bytes instanceof Uint8Array)
					)
						return reject('The observation is incomplete, historical or outside this review scope.')
					if (observation.bytes.byteLength > remaining)
						return reject('A source exceeded the byte allowance.')
					const bytes = Buffer.from(observation.bytes)
					remaining -= bytes.byteLength
					const document: unknown = JSON.parse(
						new TextDecoder('utf-8', { fatal: true }).decode(bytes),
					)
					for (const item of requirements.filter((item) => item.source === source)) {
						const actual = select(document, item.parts)
						if (!scalar(actual) || actual !== values[item.id])
							return reject(`Claim ${item.id} does not match the selected source field.`)
						if (Object.hasOwn(item, 'expected') && actual !== item.expected)
							return reject(`Claim ${item.id} does not satisfy the configured postcondition.`)
					}
					observations.push({
						source,
						requestId: request.requestId,
						observedAt: observation.observedAt,
						bytes: bytes.byteLength,
						sha256: createHash('sha256').update(bytes).digest('hex'),
					})
				}
				ensureActive()
				return {
					accept: true,
					receipt: { scope, runId, iteration: context.iteration, claims: values, observations },
				}
			} catch {
				context.signal?.throwIfAborted()
				return reject(
					'A current source could not be fully observed and parsed within the deadline.',
				)
			} finally {
				clearTimeout(timer)
				removeAbort?.()
				context.signal?.removeEventListener('abort', onAbort)
				controller.abort()
				active = false
			}
		},
	}
}
