import { describe, expect, it } from 'vitest'

import {
	createComputerUseTool,
	findDraft07Only,
	findStrictSchemaViolations,
	getBuiltinTools,
	renderToolSchema,
	toSchemaDialect,
} from '@namzu/sdk'
import type { ComputerUseHost } from '@namzu/sdk'

/**
 * The test that would have caught both outages.
 *
 * Every other test in this repo renders a schema and asserts something about
 * the object. Both production breakages were schemas that looked fine as
 * objects and were rejected by the wire:
 *
 *   - `edit.insertLine` used `oneOf`, which strict tool use refuses.
 *   - `read.readRange` is a Zod tuple, which renders draft-07 `items: [a, b]`
 *     while this wire requires draft 2020-12 — rejected with `strict` unset,
 *     so a guard scoped to strict never saw it.
 *
 * Neither could fail offline, because neither was wrong offline. So this one
 * talks to the real API.
 *
 * It asks the cheapest question that still exercises schema validation:
 * `max_tokens: 1` and a one-word prompt. Validation happens before generation,
 * so a rejected schema costs nothing and an accepted one costs a single token.
 *
 * Skipped without a key, so CI stays green where none is configured. Run it
 * with:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @namzu/anthropic test
 */

const KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.NAMZU_WIRE_TEST_MODEL ?? 'claude-haiku-4-5'

interface WireResult {
	readonly ok: boolean
	readonly status: number
	readonly message: string
}

/**
 * Statuses that mean "ask again", not "this request is wrong".
 *
 * These tests assert a CONTRACT: that a given schema is or is not expressible
 * on this wire. A 529 says the service is busy and answers nothing about the
 * schema — so reporting it as a contract failure claims something the run did
 * not establish. That happened twice in one day, and both times cost a manual
 * re-run to discover the wire had no opinion.
 *
 * Retried rather than reported inconclusive because a test that sometimes
 * declines to check is a test nobody trusts, and the retry is cheap: these
 * requests set `max_tokens: 1` and are rejected or accepted at validation.
 */
const TRANSIENT = new Set([429, 500, 502, 503, 529])

async function post(body: unknown): Promise<{ ok: boolean; status: number; message: string }> {
	let last = { ok: false, status: 0, message: 'no attempt made' }
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': KEY as string,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		})
		const parsed: unknown = await res.json().catch(() => ({}))
		const message =
			(parsed as { error?: { message?: string } } | null)?.error?.message ??
			(res.ok ? '' : 'unknown')
		last = { ok: res.ok, status: res.status, message }
		if (!TRANSIENT.has(res.status)) return last
		await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt))
	}
	// Exhausted. Returned rather than thrown so the assertion names the status
	// — a bare failure here reads as a rejected schema, which is the confusion
	// this whole helper exists to prevent.
	return last
}

async function offerTools(tools: unknown[]): Promise<WireResult> {
	return post({
		model: MODEL,
		max_tokens: 1,
		messages: [{ role: 'user', content: 'hi' }],
		tools,
	})
}

/** A tool as this driver would put it on the wire. */
function wireTool(name: string, schema: Record<string, unknown>, strict: boolean): unknown {
	return {
		name,
		description: 'contract probe',
		input_schema: toSchemaDialect(schema, '2020-12'),
		...(strict ? { strict: true } : {}),
	}
}

describe.skipIf(!KEY)('every shipped tool is expressible on this wire', () => {
	const computerUseHost = {
		id: 'wire-contract-desktop',
		capabilities: {
			displayServer: 'x11',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: true,
		},
		getDisplayGeometry: async () => ({ width: 1, height: 1, scaleFactor: 1 }),
		execute: async () => ({ type: 'ok' as const }),
	} satisfies ComputerUseHost
	const tools = [...getBuiltinTools(), createComputerUseTool(computerUseHost)]

	it('offers all of them in one request, the way a real run does', async () => {
		// One request with the whole toolset, because that is the shape that
		// broke: the wire rejects the WHOLE request for one bad schema, so a
		// per-tool loop would pass while a real run still died.
		const payload = tools.map((t) =>
			wireTool(
				t.name,
				(t.modelInputSchema as Record<string, unknown> | undefined) ??
					renderToolSchema(t.inputSchema),
				Boolean(t.enforceModelInput),
			),
		)

		const result = await offerTools(payload)
		expect(result.ok, `HTTP ${result.status}: ${result.message}`).toBe(true)
	}, 180_000)

	it.each(tools.map((t) => [t.name, t] as const))(
		'%s alone',
		async (name, tool) => {
			// And individually, so a failure names the tool instead of the batch.
			const schema =
				(tool.modelInputSchema as Record<string, unknown> | undefined) ??
				renderToolSchema(tool.inputSchema)
			const result = await offerTools([wireTool(name, schema, Boolean(tool.enforceModelInput))])
			expect(result.ok, `HTTP ${result.status}: ${result.message}`).toBe(true)
		},
		180_000,
	)
})

describe.skipIf(!KEY)('the dialect conversion is what makes the difference', () => {
	it('rejects the draft-07 tuple and accepts the converted one', async () => {
		// Pins the actual mechanism rather than trusting that conversion helped.
		// If the wire ever starts accepting draft-07 tuples this test says so,
		// and if it ever stops accepting `prefixItems` it says that too.
		const draft07 = {
			type: 'object',
			properties: {
				range: {
					type: 'array',
					minItems: 2,
					maxItems: 2,
					items: [{ type: 'integer' }, { type: 'integer' }],
				},
			},
		}

		const before = await offerTools([{ name: 'probe', description: 'p', input_schema: draft07 }])
		expect(before.ok).toBe(false)
		expect(before.message).toMatch(/2020-12/)

		const after = await offerTools([
			{ name: 'probe', description: 'p', input_schema: toSchemaDialect(draft07, '2020-12') },
		])
		expect(after.ok, `HTTP ${after.status}: ${after.message}`).toBe(true)
	}, 180_000)
})

/**
 * The strict subset, measured rather than read.
 *
 * `findStrictSchemaViolations` carries a deny-list, and the first version of it
 * was derived from prose. It was wrong in both directions: it refused
 * `minLength`/`maxLength`, which this wire accepts, so it would have blocked
 * working tools; and it permitted `prefixItems`, which this wire rejects, so it
 * would have vouched for a broken one. A deny-list nobody probed is a guess in
 * a confident tone.
 *
 * This block is where the list comes from. Each row is one request; a row that
 * changes means the subset moved, and the deny-list has to move with it.
 */
const STRICT_SUBSET: readonly (readonly [string, Record<string, unknown>, boolean])[] = [
	['minLength/maxLength', { type: 'string', minLength: 1, maxLength: 9 }, true],
	['pattern', { type: 'string', pattern: '^a+$' }, true],
	['format', { type: 'string', format: 'uri' }, true],
	['enum', { type: 'string', enum: ['a', 'b'] }, true],
	['anyOf', { anyOf: [{ type: 'integer' }, { const: 'end' }] }, true],
	// `minItems` is a bound on the VALUE, not a rejected keyword: 0 and 1 pass,
	// anything above does not. A blanket denial would refuse the ordinary
	// spelling of a non-empty array.
	['minItems: 0', { type: 'array', items: { type: 'string' }, minItems: 0 }, true],
	['minItems: 1', { type: 'array', items: { type: 'string' }, minItems: 1 }, true],
	['minItems: 2', { type: 'array', items: { type: 'string' }, minItems: 2 }, false],
	['maxItems', { type: 'array', items: { type: 'string' }, maxItems: 3 }, false],
	['uniqueItems', { type: 'array', items: { type: 'string' }, uniqueItems: true }, false],
	['minimum', { type: 'integer', minimum: 0 }, false],
	['oneOf', { oneOf: [{ type: 'integer' }, { const: 'end' }] }, false],
	['not', { not: { type: 'null' } }, false],
	// The one that interacts with the dialect fix: a tuple is unexpressible
	// under strict in EITHER spelling, so converting it only changes the error.
	['prefixItems', { type: 'array', prefixItems: [{ type: 'integer' }] }, false],
]

describe.skipIf(!KEY)('the strict subset is what the deny-list says it is', () => {
	it.each(STRICT_SUBSET.map(([label, schema, accepted]) => [label, schema, accepted] as const))(
		'strict + %s',
		async (label, propSchema, accepted) => {
			const result = await offerTools([
				{
					name: 'probe',
					description: 'p',
					strict: true,
					input_schema: {
						type: 'object',
						properties: { f: propSchema },
						required: ['f'],
						additionalProperties: false,
					},
				},
			])
			expect(result.ok, `${label}: HTTP ${result.status}: ${result.message}`).toBe(accepted)

			// And the offline check has to agree with the wire, which is the
			// whole point of pinning both in one place.
			expect(findStrictSchemaViolations({ properties: { f: propSchema } }).length === 0).toBe(
				accepted,
			)
		},
		180_000,
	)

	it('rejects the draft-07 tuple before it ever gets to the strict question', async () => {
		// Dialect first, subset second. This is why a guard scoped to strict
		// could not have caught `read.readRange`: the tuple is refused with
		// `strict` unset too.
		const tuple = {
			type: 'object',
			properties: { f: { type: 'array', items: [{ type: 'integer' }, { type: 'integer' }] } },
		}
		const result = await offerTools([{ name: 'probe', description: 'p', input_schema: tuple }])

		expect(result.ok).toBe(false)
		expect(result.message).toMatch(/2020-12/)
	}, 180_000)
})

describe.skipIf(!KEY)('the positional shape a bridged tool now emits', () => {
	it('is accepted once converted', async () => {
		// The MCP adapter emits a tuple ONLY where the server pinned the arity
		// and closed the tail, because that renders as bounded `prefixItems`.
		// The narrowness is the design rather than caution: a tool schema this
		// wire refuses fails the WHOLE request instead of degrading one tool,
		// so a faithful conversion it will not take is strictly worse than a
		// lossy one it will.
		//
		// The refusal half of this pair is already asserted above, on the
		// unconverted spelling — so this says something the sweep does not:
		// that the shape we CHOSE to emit is one the wire takes.
		const pinned = {
			type: 'object',
			properties: {
				pair: {
					type: 'array',
					minItems: 2,
					maxItems: 2,
					items: [{ type: 'string' }, { type: 'number' }],
				},
			},
			required: ['pair'],
			additionalProperties: false,
		}

		const result = await offerTools([wireTool('pinned_pair', pinned, false)])
		expect(result.ok, result.message).toBe(true)
	}, 180_000)
})

describe.skipIf(!KEY)('effort is a per-model SET, and this wire says so itself', () => {
	// Through the same retrying helper: a 529 here would read as "this model
	// refuses that level", which is the exact claim these tests exist to make
	// and the exact claim an overloaded service cannot support.
	const withEffort = (model: string, effort: string): Promise<WireResult> =>
		post({
			model,
			max_tokens: 16,
			messages: [{ role: 'user', content: 'Say OK.' }],
			output_config: { effort },
		})

	it('takes all five levels on a model the table says has all five', async () => {
		for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
			const result = await withEffort('claude-sonnet-5', effort)
			expect(result.ok, `${effort}: ${result.message}`).toBe(true)
		}
	}, 180_000)

	it('refuses a level a model lacks, and names the set it has', async () => {
		// The pairing the capability table exists to express: `max` WITHOUT
		// `xhigh`. A boolean could not have said this, and reading the levels
		// as a ladder — where anything taking the top rung takes the one below
		// — gets it backwards. That reading is how a row in that table came to
		// claim a level this wire rejects.
		const refused = await withEffort('claude-sonnet-4-6', 'xhigh')
		expect(refused.ok).toBe(false)
		expect(refused.message).toContain('xhigh')

		const accepted = await withEffort('claude-sonnet-4-6', 'max')
		expect(accepted.ok, accepted.message).toBe(true)
	}, 180_000)
})

describe('what can be checked without a key', () => {
	it('leaves no draft-07-only construct in any shipped tool', () => {
		// The offline half of the same guarantee, so a contributor without a
		// key still gets the signal — just not the proof.
		for (const tool of getBuiltinTools()) {
			const schema =
				(tool.modelInputSchema as Record<string, unknown> | undefined) ??
				renderToolSchema(tool.inputSchema)
			const converted = toSchemaDialect(schema, '2020-12')
			expect(findDraft07Only(converted), tool.name).toEqual([])
		}
	})

	it('still finds one before conversion, so the sweep is not vacuous', () => {
		// `read` renders a Zod tuple. If this ever stops finding anything, the
		// test above has quietly become a tautology.
		const withTuple = getBuiltinTools().filter(
			(t) => !t.modelInputSchema && findDraft07Only(renderToolSchema(t.inputSchema)).length > 0,
		)
		expect(withTuple.map((t) => t.name)).toContain('read')
	})
})
