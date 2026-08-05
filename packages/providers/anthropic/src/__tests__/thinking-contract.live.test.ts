import { describe, expect, it } from 'vitest'

import {
	resolveEffort,
	resolveThinkingBody,
	resolveThinkingCapability,
} from '../thinking-capability.js'

/**
 * The capability table, checked against the wire it describes.
 *
 * `thinking-capability.ts` encodes which thinking modes and which `effort`
 * levels each model accepts. Every version of that table so far was
 * transcribed from documentation, and the last transcription was wrong twice —
 * it modelled `effort` as a boolean when the accepted levels are a set, so
 * `xhigh` on a 4.6 and `max` on a 4.5 were forwarded to a wire that rejects an
 * unknown level rather than clamping it.
 *
 * A table about a wire is only as good as the wire says it is. These tests ask.
 *
 * Skipped without a key. Deliberately narrow: two current models, cheap
 * requests (`max_tokens: 1`), and only the rows that would silently rot.
 */

const KEY = process.env.ANTHROPIC_API_KEY

/** Cheap and current: one adaptive-only model, one manual-only model. */
const ADAPTIVE_MODEL = process.env.NAMZU_WIRE_TEST_MODEL ?? 'claude-sonnet-5'
const CAPPED_MODEL = 'claude-opus-5'
const MANUAL_MODEL = 'claude-haiku-4-5'

async function send(model: string, extra: Record<string, unknown>): Promise<string | true> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'x-api-key': KEY as string,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: 1,
			messages: [{ role: 'user', content: 'hi' }],
			...extra,
		}),
	})
	if (res.ok) return true
	const body: unknown = await res.json().catch(() => ({}))
	return (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`
}

describe.skipIf(!KEY)('the effort levels the table claims are the ones the wire takes', () => {
	it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
		'%s is accepted on a current model, and the table says so',
		async (level) => {
			const capability = resolveThinkingCapability(ADAPTIVE_MODEL)
			expect(capability.effort, `table omits ${level}`).toContain(level)

			const resolved = resolveEffort(level, { type: 'adaptive' }, capability)
			expect(resolved, 'resolver dropped a level the table allows').toBe(level)

			const result = await send(ADAPTIVE_MODEL, {
				thinking: { type: 'adaptive' },
				output_config: { effort: level },
			})
			expect(result).toBe(true)
		},
		120_000,
	)

	it('drops effort on a model that takes none, and the wire agrees it would have failed', async () => {
		const capability = resolveThinkingCapability(MANUAL_MODEL)
		expect(capability.effort).toEqual([])
		expect(resolveEffort('high', { type: 'enabled' }, capability)).toBeUndefined()

		// The half that matters: had the resolver NOT dropped it, this is what
		// the wire would have said. A table claiming "no effort here" is only
		// worth something if sending effort really does fail.
		const result = await send(MANUAL_MODEL, { output_config: { effort: 'high' } })
		expect(result).not.toBe(true)
	}, 120_000)
})

describe.skipIf(!KEY)('the thinking body the resolver builds is one the wire accepts', () => {
	it('adaptive, on a model the table calls adaptive-only', async () => {
		const capability = resolveThinkingCapability(ADAPTIVE_MODEL)
		expect(capability.adaptive).toBe(true)

		const body = resolveThinkingBody({ type: 'adaptive' }, capability)
		expect(await send(ADAPTIVE_MODEL, { thinking: body })).toBe(true)
	}, 120_000)

	it('rewrites a manual intent rather than sending one the model refuses', async () => {
		// The resolver turns `enabled` into `adaptive` where manual is rejected.
		// If it did not, this is the request that would go out — so both halves
		// are asserted: what we send is accepted, and what we avoided is not.
		const capability = resolveThinkingCapability(ADAPTIVE_MODEL)
		const body = resolveThinkingBody({ type: 'enabled', budgetTokens: 2048 }, capability)
		expect(body).toEqual({ type: 'adaptive' })

		expect(await send(ADAPTIVE_MODEL, { thinking: body })).toBe(true)
		expect(
			await send(ADAPTIVE_MODEL, { thinking: { type: 'enabled', budget_tokens: 2048 } }),
		).not.toBe(true)
	}, 120_000)

	it('caps effort with thinking off only where the wire actually caps it', async () => {
		// Both directions, because the first version of this rule was too wide.
		const capped = resolveThinkingCapability(CAPPED_MODEL)
		const disabledOnCapped = resolveThinkingBody({ type: 'disabled' }, capped)
		expect(resolveEffort('max', disabledOnCapped, capped)).toBeUndefined()
		expect(resolveEffort('high', disabledOnCapped, capped)).toBe('high')
		expect(
			await send(CAPPED_MODEL, { thinking: disabledOnCapped, output_config: { effort: 'max' } }),
		).not.toBe(true)

		// …and a model the wire does NOT cap keeps the level the caller asked for.
		const open = resolveThinkingCapability(ADAPTIVE_MODEL)
		const disabledOnOpen = resolveThinkingBody({ type: 'disabled' }, open)
		expect(resolveEffort('max', disabledOnOpen, open)).toBe('max')
		expect(
			await send(ADAPTIVE_MODEL, { thinking: disabledOnOpen, output_config: { effort: 'max' } }),
		).toBe(true)
	}, 120_000)
})
