import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { generateTurnId } from '../../utils/id.js'
import {
	type JsonClaimObservation,
	type JsonClaimReadRequest,
	type JsonClaimVerifierOptions,
	createJsonClaimVerifier,
} from '../json-claim-verifier.js'

const runId = generateTurnId()
const context = { runId, iteration: 2 }
const requirement = { id: 'version', source: 'manifest', pointer: '/version' }
function observation(
	source: string,
	request: JsonClaimReadRequest,
	text = '{"version":"3.0.0"}',
): JsonClaimObservation {
	return {
		...request,
		source,
		kind: 'current',
		complete: true,
		observedAt: Date.now(),
		bytes: Buffer.from(text),
	}
}
function verifier(overrides: Partial<JsonClaimVerifierOptions> = {}) {
	return createJsonClaimVerifier({
		scope: 'tenant/project/claim/revision',
		turnId,
		requirements: [requirement],
		observe: async (source, request) => observation(source, request),
		...overrides,
	})
}

describe('explicit claims require current source evidence', () => {
	it('rejects a late synchronous observer even when the deadline timer could not run', async () => {
		const check = verifier({
			timeoutMs: 2,
			observe: async (source, request) => {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12)
				return observation(source, request)
			},
		})
		expect((await check.verify({ version: '3.0.0' }, context)).accept).toBe(false)
		expect(check.isDrained()).toBe(true)
	})

	it('rejects a stale value, repairs, then rechecks after a source changes', async () => {
		let value = '3.0.0'
		const observe = vi.fn(async (source, request) =>
			observation(source, request, JSON.stringify({ version: value })),
		)
		const check = verifier({ observe })
		expect((await check.verify({ version: '1.0.0' }, context)).accept).toBe(false)
		const accepted = await check.verify({ version: '3.0.0' }, context)
		expect(accepted.accept).toBe(true)
		if (!accepted.accept) throw new Error('Missing receipt')
		expect(accepted.receipt.observations[0]!.sha256).toBe(
			createHash('sha256').update('{"version":"3.0.0"}').digest('hex'),
		)
		value = '4.0.0'
		expect((await check.verify({ version: '3.0.0' }, context)).accept).toBe(false)
		expect(observe).toHaveBeenCalledTimes(3)
		expect(new Set(observe.mock.calls.map((call) => call[1].requestId)).size).toBe(3)
	})

	it('does not equate a correct report with achieving a configured postcondition', async () => {
		const check = verifier({ requirements: [{ ...requirement, expected: '4.0.0' }] })
		expect(await check.verify({ version: '3.0.0' }, context)).toMatchObject({
			accept: false,
			feedback: expect.stringContaining('postcondition'),
		})
	})

	it.each([
		{ scope: 'other tenant' },
		{ runId: generateTurnId() },
		{ iteration: 99 },
		{ requestId: 'old receipt' },
		{ source: 'foreign document' },
		{ complete: false },
		{ kind: 'historical' },
		{ observedAt: 0 },
		{ observedAt: Number.MAX_SAFE_INTEGER },
	])('rejects unusable or foreign observation: %j', async (patch) => {
		const check = verifier({
			observe: async (source, request) =>
				({ ...observation(source, request), ...patch }) as JsonClaimObservation,
		})
		expect((await check.verify({ version: '3.0.0' }, context)).accept).toBe(false)
	})

	it.each([
		{},
		{ version: '3.0.0', extra: true },
		{ version: {} },
		{ version: 1.5 },
		{ version: Number.MAX_SAFE_INTEGER + 1 },
		['3.0.0'],
		null,
	])('rejects malformed claims without reading a source: %j', async (claims) => {
		const observe = vi.fn()
		expect((await verifier({ observe }).verify(claims, context)).accept).toBe(false)
		expect(observe).not.toHaveBeenCalled()
	})

	it('rejects a foreign review before observation', async () => {
		const observe = vi.fn()
		expect(
			(
				await verifier({ observe }).verify(
					{ version: '3.0.0' },
					{ ...context, runId: generateTurnId() },
				)
			).accept,
		).toBe(false)
		expect(observe).not.toHaveBeenCalled()
	})

	it('shares one read among claims, selects own fields and escaped pointers', async () => {
		const observe = vi.fn(async (source, request) =>
			observation(source, request, '{"a/b":{"~":[false]},"version":"3.0.0"}'),
		)
		const check = verifier({
			observe,
			requirements: [requirement, { id: 'flag', source: 'manifest', pointer: '/a~1b/~0/0' }],
		})
		expect((await check.verify({ version: '3.0.0', flag: false }, context)).accept).toBe(true)
		expect(observe).toHaveBeenCalledTimes(1)
		expect(
			(
				await verifier({ requirements: [{ ...requirement, pointer: '/toString' }] }).verify(
					{ version: '3.0.0' },
					context,
				)
			).accept,
		).toBe(false)
	})

	it.each(['not JSON', '{"version":{}}', '{"version":9007199254740993}', '{}'])(
		'rejects unavailable or unsupported selected fields: %s',
		async (text) => {
			expect(
				(
					await verifier({
						observe: async (source, request) => observation(source, request, text),
					}).verify({ version: '3.0.0' }, context)
				).accept,
			).toBe(false)
		},
	)
	it('rejects invalid UTF-8 rather than hashing replacement text', async () => {
		expect(
			(
				await verifier({
					observe: async (source, request) => ({
						...observation(source, request),
						bytes: new Uint8Array([255]),
					}),
				}).verify({ version: '3.0.0' }, context)
			).accept,
		).toBe(false)
	})

	it('shares the byte allowance across sources and stops after exhaustion', async () => {
		const observe = vi.fn(async (source, request) => observation(source, request, '"x"'))
		const check = verifier({
			maxBytes: 3,
			observe,
			requirements: [
				{ id: 'first', source: 'one', pointer: '' },
				{ id: 'second', source: 'two', pointer: '' },
			],
		})
		expect((await check.verify({ first: 'x', second: 'x' }, context)).accept).toBe(false)
		expect(observe).toHaveBeenCalledTimes(1)
		expect((await verifier({ maxBytes: 1 }).verify({ version: '3.0.0' }, context)).accept).toBe(
			false,
		)
	})

	it('revokes timed-out observation and prevents piling up work until it drains', async () => {
		let finish!: (value: JsonClaimObservation) => void
		let captured!: JsonClaimReadRequest
		const observe = vi.fn((_source, request) => {
			captured = request
			return new Promise<JsonClaimObservation>((resolve) => {
				finish = resolve
			})
		})
		const check = verifier({ observe, timeoutMs: 5 })
		expect((await check.verify({ version: '3.0.0' }, context)).accept).toBe(false)
		expect(captured.signal.aborted).toBe(true)
		expect(check.isDrained()).toBe(false)
		expect((await check.verify({ version: '3.0.0' }, context)).accept).toBe(false)
		expect(observe).toHaveBeenCalledTimes(1)
		finish(observation('manifest', captured))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(check.isDrained()).toBe(true)
	})

	it('keeps caller cancellation distinct from rejection, and drains cooperative observers', async () => {
		const controller = new AbortController()
		const reason = new Error('operator stopped')
		const check = verifier({
			observe: async (_source, request) => {
				controller.abort(reason)
				request.signal.throwIfAborted()
				throw new Error('unreachable')
			},
		})
		await expect(
			check.verify({ version: '3.0.0' }, { ...context, signal: controller.signal }),
		).rejects.toBe(reason)
		await Promise.resolve()
		expect(check.isDrained()).toBe(true)
	})

	it('freezes authority against later caller edits and does not disclose source values in rejection', async () => {
		const requirements = [{ ...requirement }]
		const check = verifier({ requirements })
		requirements[0]!.source = 'secret'
		const verdict = await check.verify({ version: 'wrong' }, context)
		expect(verdict).toMatchObject({ accept: false })
		expect(JSON.stringify(verdict)).not.toContain('3.0.0')
	})

	it.each([
		{ requirements: [] },
		{ maxBytes: 0 },
		{ timeoutMs: 0 },
		{ requirements: [requirement, requirement] },
		{ requirements: [{ ...requirement, pointer: '/bad~2' }] },
		{ requirements: [{ ...requirement, expected: 1.2 }] },
	])('rejects invalid host configuration: %j', (options) => {
		expect(() => verifier(options)).toThrow()
	})
})
