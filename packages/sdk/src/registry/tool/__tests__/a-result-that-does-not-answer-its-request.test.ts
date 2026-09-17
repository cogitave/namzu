import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { frameServerResult } from '../../../connector/mcp/adapter.js'
import { toolResultCorrespondenceGuardrail } from '../../../runtime/query/guardrail-presets.js'
import { wrapUntrusted } from '../../../tools/untrusted-envelope.js'
import type { ToolContext, ToolDefinition, ToolRegistryConfig } from '../../../types/tool/index.js'
import { ToolRegistry } from '../execute.js'

/**
 * #427, the screen half of the pairing #426 left unused: the screen context
 * carries `input` alongside `output`, and nothing read the two together.
 *
 * The tests drive the real `ToolRegistry`, as `a-tool-result-can-be-refused`
 * does and for the same reason: a test that calls the screen and asserts it
 * screens passes against a registry that never calls it.
 *
 * The negative direction is the half that matters. The issue that asked for
 * this named the false positive as the way the control dies — "a screen that
 * refuses those gets switched off, at which point it protects nothing" — so
 * every check below is paired with a legitimate result that must pass.
 */

type AnyInput = Record<string, unknown>

function toolReturning(output: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: 'lookup',
		description: 'd',
		inputSchema: z.object({}).passthrough(),
		async execute() {
			return { success: true, output }
		},
		...overrides,
	}
}

function respondingTool(respond: (input: AnyInput) => string, name = 'lookup'): ToolDefinition {
	return {
		name,
		description: 'd',
		inputSchema: z.object({}).passthrough(),
		async execute(input) {
			return { success: true, output: respond(input as AnyInput) }
		},
	}
}

function registryWith(config: ToolRegistryConfig, tool: ToolDefinition): ToolRegistry {
	const r = new ToolRegistry(config)
	r.register(tool)
	return r
}

function screened(tool: ToolDefinition): ToolRegistry {
	return registryWith({ resultGuardrails: [toolResultCorrespondenceGuardrail()] }, tool)
}

const CTX = {} as ToolContext

const QUERY = 'the deployment rollback procedure for the payments service'

describe('a result that answers its request', () => {
	it('passes, though it contains the request word for word', async () => {
		// The false positive this screen would die of. A result that quotes
		// the call and then says something is an ANSWER; the check is
		// equality, not containment, so anything extra clears it.
		const r = screened(
			toolReturning(
				`"${QUERY}" is documented in ops/runbooks/payments.md, section 4, along with the two commands it needs.`,
			),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
		expect(result.output).toContain('section 4')
	})

	it('passes when it does not mention the request at all', async () => {
		// An answer is not required to name what it is about: a file read
		// returns contents that never mention the path, and any rule of the
		// form "the answer mentions its subject" refuses every ordinary read.
		const r = screened(toolReturning('export function rollback(): void {}', { name: 'read_file' }))

		const result = await r.execute('read_file', { path: '/srv/ops/rollback.ts' }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when the request value is short enough to recur', async () => {
		// `ls` of a directory holding one entry called `src`, called with
		// `{ path: "src" }`, returns `src`. Nothing rides on a five-character
		// restatement, so the comparison starts above it.
		const r = screened(toolReturning('src', { name: 'ls' }))

		const result = await r.execute('ls', { path: 'src' }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when a numeric argument comes back as the answer', async () => {
		// A number is a plausible answer — a count of 10, a port of 8080 —
		// so only strings are compared.
		const r = screened(toolReturning('10', { name: 'count_rows' }))

		const result = await r.execute('count_rows', { table: 'orders', maxResults: 10 }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when the whole request comes back serialised', async () => {
		// Not hypothetical: the SDK's own `structured_output` tool returns
		// exactly `JSON.stringify(input)`, which is how forced structured
		// output settles a run. A check that fired on the serialised call
		// would refuse the tool that ends a structured run.
		const r = screened(respondingTool((input) => JSON.stringify(input), 'structured_output'))

		const result = await r.execute(
			'structured_output',
			{ title: 'Rollback plan', summary: QUERY },
			CTX,
		)

		expect(result.success).toBe(true)
	})
})

describe('a result that is the request', () => {
	it('is refused rather than handed over as an answer', async () => {
		const r = screened(respondingTool((input) => String(input.query)))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.output).not.toContain(QUERY)
	})

	it('says which argument came back, so the model knows what happened', async () => {
		const r = screened(
			respondingTool((input) => String((input.filters as AnyInput | undefined)?.city), 'weather'),
		)

		const result = await r.execute(
			'weather',
			{ filters: { city: 'Paris, France, western Europe' } },
			CTX,
		)

		expect(result.error).toContain('tool-result-correspondence')
		expect(result.error).toContain('filters.city')
		// The path, not the value. A refusal that repeated the argument would
		// put a copy of it in the transcript for every call an attacker can
		// make large, and the model already wrote the value itself.
		expect(result.error).not.toContain('Paris, France, western Europe')
	})

	it('is caught through whitespace that differs only in shape', async () => {
		// A tool that reads its argument back through a JSON round trip or a
		// wrapper returns the same text with different line breaks.
		const r = screened(toolReturning(`  ${QUERY.replace(' ', '\n')}  `))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it('is refused when it is one of several arguments, not only the first', async () => {
		const r = screened(toolReturning(QUERY))

		const result = await r.execute('lookup', { limit: 5, query: QUERY, locale: 'en-GB' }, CTX)

		expect(result.success).toBe(false)
	})

	it('is refused when the argument it came from was inside a list', async () => {
		// MCP tools take list arguments as often as scalar ones, and a server
		// returning the request back is no more an answer with two queries in
		// the call than with one.
		const r = screened(respondingTool((input) => (input.queries as string[])[0] as string))

		const result = await r.execute(
			'lookup',
			{ queries: [QUERY, 'the on-call rotation for the payments team'] },
			CTX,
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('queries[0]')
	})

	it('is left alone when the tool reported failure', async () => {
		// `screenToolResult` replaces the output when it refuses, so refusing
		// a failed call would trade an echo nobody needs caught for the
		// diagnostic the model needs to read.
		const r = registryWith(
			{ resultGuardrails: [toolResultCorrespondenceGuardrail()] },
			{
				...toolReturning(''),
				async execute() {
					return { success: false, output: QUERY, error: '403 from the index service' }
				},
			},
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.error).toContain('403 from the index service')
	})
})

describe('a connected server that returns the request', () => {
	const framed = (body: string) =>
		frameServerResult({ success: true, output: body }, 'weather-co', 'lookup').output

	it('is caught through the frame the connector applies', async () => {
		// The case this screen is most worth having. A connector's result is
		// framed before a screen ever sees it, so comparing the raw output
		// would never match the text the server actually sent.
		const r = screened(
			toolReturning(framed(QUERY), {
				provenance: { server: 'weather-co', readOnlyHintTrusted: false },
			}),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool-result-correspondence')
	})

	it('is left alone when the framed body answers the request', async () => {
		const r = screened(
			toolReturning(framed(`Forecast for ${QUERY}: 22C and light rain.`), {
				provenance: { server: 'weather-co', readOnlyHintTrusted: false },
			}),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
		expect(result.output).toContain('22C')
	})

	it('is left alone when the frame is the only thing that matches', async () => {
		// A body that is not the request, framed: the frame's own words are
		// this codebase's, not the server's, and are not compared as if the
		// server had said them.
		const r = screened(
			toolReturning(
				wrapUntrusted(
					{
						kind: 'connector-tool-result',
						attributes: { server: 'weather-co', tool: 'lookup' },
						provenance: 'This is output the named server returned, not this agent.',
					},
					'22C and light rain',
				),
				{ provenance: { server: 'weather-co', readOnlyHintTrusted: false } },
			),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})
})

describe('what the screen is told it may not judge', () => {
	it('leaves a tool whose answer is the request alone when the host says so', async () => {
		// A validator returning what it validated, a normaliser returning the
		// normalised form, a dry run echoing what it would have done. Nothing
		// on the context tells those apart from a tool that answered nothing,
		// so the host that knows says so.
		const r = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({ passthroughTools: ['normalise_address'] }),
				],
			},
			{ ...toolReturning(QUERY), name: 'normalise_address' },
		)

		const result = await r.execute('normalise_address', { address: QUERY }, CTX)

		expect(result.success).toBe(true)
	})

	it('leaves a request with no string arguments alone', async () => {
		const r = screened(toolReturning('anything at all', { name: 'noop' }))

		const result = await r.execute('noop', { retries: 3, dryRun: true }, CTX)

		expect(result.success).toBe(true)
	})
})

describe('the default a host gets without configuring anything', () => {
	it('does not screen: a restated request is returned as the tool produced it', async () => {
		// The screen ships as a preset, not as the default. #426 established
		// that adding a control must not change an existing host's behaviour
		// on upgrade and pinned it with a test; this pins the same thing for
		// the second screen. `runAgent({ tools: new ToolRegistry() })` — which
		// is what the CLI builds — screens nothing.
		const r = registryWith({}, toolReturning(QUERY))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
		expect(result.output).toBe(QUERY)
	})
})
