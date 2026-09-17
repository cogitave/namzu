import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { frameServerResult, mcpToolResultToToolResult } from '../../../connector/mcp/adapter.js'
import {
	passthroughToolNames,
	toolResultCorrespondenceGuardrail,
} from '../../../runtime/query/guardrail-presets.js'
import { getBuiltinTools } from '../../../tools/builtins/index.js'
import { createStructuredOutputTool } from '../../../tools/builtins/structuredOutput.js'
import { WebFetchTool } from '../../../tools/builtins/web.js'
import { untrustedEnvelopeBody, wrapUntrusted } from '../../../tools/untrusted-envelope.js'
import type { ToolResultGuardrailSpec } from '../../../types/guardrail/index.js'
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
 * Two halves carry most of the weight. The negative direction, because the
 * issue that asked for this named the false positive as the way the control
 * dies; and `the tools this SDK ships`, because a hand-written stand-in for a
 * tool is exactly what hid the fetch that returns its own URL.
 */

type AnyInput = Record<string, unknown>

const QUERY = 'the deployment rollback procedure for the payments service'

/**
 * What a connected server's tool carries. `provenance` is what the exemption
 * list and the `server:tool` spelling are derived from; the scope reads the
 * FRAME, which the `connected` helper below applies.
 */
const CONNECTED = {
	provenance: { server: 'weather-co', readOnlyHintTrusted: false },
} as const

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

function respondingTool(
	respond: (input: AnyInput) => string,
	overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
	return {
		name: 'lookup',
		description: 'd',
		inputSchema: z.object({}).passthrough(),
		async execute(input) {
			return { success: true, output: respond(input as AnyInput) }
		},
		...overrides,
	}
}

/**
 * The same tool, as a connected server's.
 *
 * `provenance` AND the frame the adapter applies, because in the product the
 * two arrive together and it is the frame the default scope reads. A stand-in
 * that carried only the provenance would be a shape no connector produces —
 * the same kind of hand-written stand-in that hid the fetch returning its own
 * URL — and it would pass this screen for a reason nothing in the tree shares.
 */
function connected(tool: ToolDefinition): ToolDefinition {
	// A tool that names its own server keeps it — a plugin-qualified server's
	// name is its own, and the `server:tool` spelling is derived from it.
	const server = tool.provenance?.server ?? CONNECTED.provenance.server
	return {
		...CONNECTED,
		...tool,
		async execute(input, context) {
			const result = await tool.execute(input, context)
			return typeof result.output === 'string'
				? frameServerResult(result, server, tool.name)
				: result
		},
	}
}

function registryWith(
	config: ToolRegistryConfig,
	...tools: readonly ToolDefinition[]
): ToolRegistry {
	const r = new ToolRegistry(config)
	for (const tool of tools) r.register(tool)
	return r
}

function screened(...tools: readonly ToolDefinition[]): ToolRegistry {
	return registryWith({ resultGuardrails: [toolResultCorrespondenceGuardrail()] }, ...tools)
}

const CTX = {} as ToolContext

/**
 * The fetch the reviewer ran against the real tool: a page whose body IS the
 * URL it was fetched from. `web.ts` returns `result.body` bare when there were
 * no redirects and no truncation, so the result is the argument — which is a
 * true result from a working tool, and the shape the screen must not refuse.
 */
const WEB_RETURNING_ITS_URL = {
	web: {
		fetch: {
			fetch: async ({ url }: { url: string }) => ({
				url,
				status: 200,
				body: url,
				truncated: false,
				redirects: [],
			}),
		},
	},
}

describe('a result that answers its request', () => {
	it('passes, though it contains the request word for word', async () => {
		// The false positive this screen would die of. A result that quotes
		// the call and then says something is an ANSWER; the check is
		// equality, not containment, so anything extra clears it.
		const r = screened(
			connected(
				toolReturning(
					`"${QUERY}" is documented in ops/runbooks/payments.md, section 4, along with the two commands it needs.`,
				),
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
		const r = screened(connected(toolReturning('export function rollback(): void {}')))

		const result = await r.execute('lookup', { path: '/srv/ops/rollback.ts' }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when the request value is short enough to recur', async () => {
		// `ls` of a directory holding one entry called `src`, called with
		// `{ path: "src" }`, returns `src`. Nothing rides on a five-character
		// restatement, so the comparison starts above it.
		const r = screened(connected(toolReturning('src')))

		const result = await r.execute('lookup', { path: 'src' }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when a short request is short only in UTF-16 units', async () => {
		// Eight code points, sixteen units of `String.length`. A floor that
		// counted units would compare this and refuse it, while the docblock
		// said the floor excludes short values.
		const emoji = '🚚'.repeat(8)
		expect(emoji.length).toBe(16)

		const r = screened(connected(toolReturning(emoji)))

		const result = await r.execute('lookup', { note: emoji }, CTX)

		expect(result.success).toBe(true)
	})

	it('passes when a numeric argument comes back as the answer', async () => {
		// A number is a plausible answer — a count of 10, a port of 8080 —
		// so only strings are compared.
		const r = screened(connected(toolReturning('10')))

		const result = await r.execute('lookup', { table: 'orders', maxResults: 10 }, CTX)

		expect(result.success).toBe(true)
	})
})

describe('a result that is the request', () => {
	it('is refused rather than handed over as an answer', async () => {
		const r = screened(connected(respondingTool((input) => String(input.query))))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.output).not.toContain(QUERY)
	})

	it('says which argument came back, so the model knows what happened', async () => {
		const r = screened(
			connected(respondingTool((input) => String((input.filters as AnyInput | undefined)?.city))),
		)

		const result = await r.execute(
			'lookup',
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
		const r = screened(connected(toolReturning(`  ${QUERY.replace(' ', '\n')}  `)))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it('is refused when it is one of several arguments, not only the first', async () => {
		const r = screened(connected(toolReturning(QUERY)))

		const result = await r.execute('lookup', { limit: 5, query: QUERY, locale: 'en-GB' }, CTX)

		expect(result.success).toBe(false)
	})

	it('is refused when the argument it came from was inside a list', async () => {
		// MCP tools take list arguments as often as scalar ones, and a server
		// returning the request back is no more an answer with two queries in
		// the call than with one.
		const r = screened(
			connected(respondingTool((input) => (input.queries as string[])[0] as string)),
		)

		const result = await r.execute(
			'lookup',
			{ queries: [QUERY, 'the on-call rotation for the payments team'] },
			CTX,
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('queries[0]')
	})

	it('names the request itself when the call was one bare string', async () => {
		// A tool whose whole input is the string, so the refusal cannot name
		// an argument that has no name — "the "" argument" is not a sentence.
		const bare = toolReturning(QUERY, {
			inputSchema: z.string(),
			name: 'echo',
		})
		const r = screened(connected(bare))

		const result = await r.execute('echo', QUERY, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('what this call sent')
	})

	it('says which tool returned it, because naming it is what makes it fixable', async () => {
		// The reader is an operator deciding whether to exempt this tool, and
		// the guardrail's own sentence is what reaches a log line and a host's
		// own reporting as well as the transcript. A refusal that only the
		// outer `Tool "x" produced a result that was refused by guardrail "y"`
		// line names is a refusal a caller reading the reason alone cannot act
		// on.
		const r = screened(connected(respondingTool((input) => String(input.query))))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.error).toContain('the text inside the untrusted frame from "lookup"')
	})

	it('does not claim the comparison was verbatim, because it was not', async () => {
		// Whitespace normalisation is applied to both sides, so a result that
		// differs from the request only in the shape of its whitespace is
		// refused — and describing that as "verbatim and on its own" was a
		// false statement about the comparison, in the one sentence an
		// operator reads before deciding whether the screen is broken.
		const r = screened(connected(toolReturning(`  ${QUERY.replace(' ', '\n')}  `)))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('whitespace-normalised')
		expect(result.error).not.toContain('verbatim')
	})

	it('names the item when the call was one bare list', async () => {
		const list = toolReturning(QUERY, {
			inputSchema: z.array(z.string()),
			name: 'echo_all',
		})
		const r = screened(connected(list))

		const result = await r.execute('echo_all', [QUERY], CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('item 0 of the request')
	})

	it('is left alone when the tool reported failure', async () => {
		// `screenToolResult` replaces the output when it refuses, so refusing
		// a failed call would trade an echo nobody needs caught for the
		// diagnostic the model needs to read.
		const r = screened(
			connected({
				...toolReturning(''),
				async execute() {
					return {
						success: false,
						output: QUERY,
						error: '403 from the index service',
					}
				},
			}),
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
		//
		// The tool returns the adapter's frame directly rather than through
		// `connected()`, because `connected()` IS the adapter and framing here
		// twice would wrap the frame in a second one — a shape no connector
		// produces, and one whose body is not the restatement.
		const r = screened(toolReturning(framed(QUERY), CONNECTED))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool-result-correspondence')
	})

	it('is caught even when the frame names a tool that carries the tag itself', async () => {
		// The frame's own attributes are not defanged — only the content and
		// the provenance line are — so a server or agent whose name contains
		// the token puts it in the opening tag. A reader that finds the tag's
		// end at the first `>`, or that looks for the token anywhere before
		// the body, returns nothing for a frame this codebase produced, and
		// the screen then passes exactly the result it exists to refuse.
		const hostile = wrapUntrusted(
			{
				kind: 'connector-tool-result',
				attributes: { server: 'weather-co', tool: 'a>namzu-untrusted' },
				provenance: 'This is output the named server returned, not this agent.',
			},
			QUERY,
		)
		const r = screened(toolReturning(hostile, CONNECTED))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it('is left alone when the framed body answers the request', async () => {
		const r = screened(
			toolReturning(framed(`Forecast for ${QUERY}: 22C and light rain.`), CONNECTED),
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
				CONNECTED,
			),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})
})

describe('the scope', () => {
	it('judges a host tool that framed its own result', async () => {
		// N1. The scope is "framed as untrusted data", not "registered by the
		// connector adapter", and the difference is a host tool that decided
		// its own answer was not this process's to vouch for — the CLI's own
		// remote Exa search is exactly this, and under the provenance-based
		// predicate a search that restated its query was out of scope while a
		// connected fetch that did was in it. Registration is an accident of
		// the code; the frame is a fact about the content.
		const r = screened(
			toolReturning(
				wrapUntrusted(
					{
						kind: 'connector-tool-result',
						attributes: { server: 'exa', tool: 'web_search_exa' },
						provenance: 'This is output the named server returned, not this agent.',
					},
					QUERY,
				),
				{ name: 'web_search' },
			),
		)

		const result = await r.execute('web_search', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool-result-correspondence')
	})

	it('leaves an unframed host tool alone even when its answer is the request', async () => {
		// Not a hypothetical: this is `web_fetch`, whose output is the page
		// body, and a page whose body IS the URL it was fetched from is an
		// ordinary result. Nothing on the context tells that from a tool that
		// answered nothing, so the default judges framed results only.
		const r = screened(
			toolReturning('https://docs.internal.example.com/rollback-procedure', {
				name: 'web_fetch',
			}),
		)

		const result = await r.execute(
			'web_fetch',
			{ url: 'https://docs.internal.example.com/rollback-procedure' },
			CTX,
		)

		expect(result.success).toBe(true)
	})

	it('judges a host tool when the host asks for it', async () => {
		const r = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ scope: 'all' })],
			},
			toolReturning(QUERY),
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it("is the host's call, which is why the exemption list exists", async () => {
		// What `scope: 'all'` costs, stated rather than implied: the fetch
		// above is refused until the host names it, and the exemption is the
		// difference between the two runs.
		const tool = toolReturning('https://docs.internal.example.com/rollback-procedure')
		const call = {
			url: 'https://docs.internal.example.com/rollback-procedure',
		}

		const strict = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ scope: 'all' })],
			},
			tool,
		)
		const exempt = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						scope: 'all',
						passthroughTools: ['lookup'],
					}),
				],
			},
			tool,
		)

		expect((await strict.execute('lookup', call, CTX)).success).toBe(false)
		expect((await exempt.execute('lookup', call, CTX)).success).toBe(true)
	})
})

describe('the names a host may exempt a connected tool by', () => {
	const echoing = (name: string) =>
		connected(respondingTool((input) => String(input.query), { name }))

	it('accepts the bare name the server itself uses', async () => {
		// A host reads the tool's name from the server's manifest, where it is
		// `lookup`; the registry's `mcp_weather_co_lookup` is the kernel's
		// spelling of it. Requiring the long one is a trap for exactly the
		// tools this screen is about.
		const r = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ passthroughTools: ['lookup'] })],
			},
			echoing('mcp_weather-co_lookup'),
		)

		const result = await r.execute('mcp_weather-co_lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})

	it('accepts server:tool', async () => {
		const r = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						passthroughTools: ['weather-co:lookup'],
					}),
				],
			},
			echoing('mcp_weather-co_lookup'),
		)

		const result = await r.execute('mcp_weather-co_lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})

	it('accepts the bare tail of a plugin-qualified name', async () => {
		// `myplugin__mcp__weather__lookup`, which is how a plugin-provided
		// server's tool is registered.
		const r = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ passthroughTools: ['lookup'] })],
			},
			echoing('myplugin__mcp__weather__lookup'),
		)

		const result = await r.execute('myplugin__mcp__weather__lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})

	it('exempts nothing else', async () => {
		const r = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						passthroughTools: ['lookup_2', 'weather-co'],
					}),
				],
			},
			echoing('mcp_weather-co_lookup'),
		)

		const result = await r.execute('mcp_weather-co_lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it('exempts by every spelling each registration shape actually has', async () => {
		// The whole set, pinned, because the docblock used to list four names
		// as if all four worked for either shape and only two of them do.
		expect([...passthroughToolNames('mcp_weather-co_lookup', 'weather-co')].sort()).toEqual([
			'lookup',
			'mcp_weather-co_lookup',
			'weather-co:lookup',
		])
		expect([...passthroughToolNames('myplugin__mcp__weather__lookup', 'weather')].sort()).toEqual([
			'lookup',
			'myplugin__mcp__weather__lookup',
			'weather:lookup',
		])
		// A host tool: no server, no namespace, so the registered name is the
		// whole set — and no bare tail is invented from an underscore pair.
		expect(passthroughToolNames('web_fetch')).toEqual(['web_fetch'])
	})

	it('does not carry a name across shapes, which the docblock used to imply', async () => {
		// `mcp_weather_lookup` is the DIRECT shape's spelling. A
		// plugin-qualified registration does not answer to it, and an
		// exemption written for one shape therefore does not exempt the
		// other — the correction N4 asked for, as a test rather than a
		// sentence.
		const r = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						passthroughTools: ['mcp_weather_lookup'],
					}),
				],
			},
			echoing('myplugin__mcp__weather__lookup'),
		)

		const result = await r.execute('myplugin__mcp__weather__lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
	})

	it('accepts server:tool for a plugin-qualified name too', async () => {
		// The spelling that works across both shapes: it is derived from the
		// bare tail and the server, and both shapes have those — here the
		// server is the plugin's own name for it, `weather`, which is what
		// `provenance.server` carries on that path.
		const r = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						passthroughTools: ['weather:lookup'],
					}),
				],
			},
			connected(
				respondingTool((input) => String(input.query), {
					name: 'myplugin__mcp__weather__lookup',
					provenance: { server: 'weather', readOnlyHintTrusted: false },
				}),
			),
		)

		const result = await r.execute('myplugin__mcp__weather__lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
	})
})

describe('the tools this SDK ships', () => {
	/**
	 * One real call per shipped tool, against a real working directory.
	 *
	 * `fetchItsOwnUrl` is separated out rather than dropped: it is the case
	 * that named the scope, and it IS a restatement under a widened scope, so
	 * a test that asserted "nothing here is refused" while running it would be
	 * asserting something false about the comparison.
	 */
	async function shippedCalls(options: { readonly withRestatements?: boolean } = {}): Promise<{
		readonly ctx: ToolContext
		readonly calls: readonly (readonly [string, unknown])[]
	}> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-correspondence-'))
		const notes = join(dir, 'notes.md')
		const selfNamed = join(dir, 'a-file-whose-name-is-also-its-whole-content.md')
		await writeFile(notes, `# Notes\n\n${QUERY}\n`)
		await writeFile(join(dir, 'empty.txt'), '')
		await writeFile(selfNamed, selfNamed)

		const ctx = {
			workingDirectory: dir,
			cwd: dir,
			...WEB_RETURNING_ITS_URL,
		} as unknown as ToolContext

		return {
			ctx,
			calls: [
				['read', { path: notes }],
				['read', { path: join(dir, 'empty.txt') }],
				['read', { path: selfNamed }],
				['glob', { pattern: '**/*.md', path: dir }],
				['grep', { pattern: QUERY, path: dir }],
				['bash', { command: 'mkdir -p sub' }],
				...(options.withRestatements
					? [
							[
								'web_fetch',
								{ url: 'https://docs.internal.example.com/rollback-procedure' },
							] as const,
						]
					: []),
				['structured_output', { title: 'Rollback', summary: QUERY }],
			],
		}
	}

	function shippedRegistry(screens: readonly ToolResultGuardrailSpec[]): ToolRegistry {
		const registry = registryWith({ resultGuardrails: screens }, ...getBuiltinTools())
		registry.register(WebFetchTool)
		registry.register(
			createStructuredOutputTool(z.object({ title: z.string(), summary: z.string() })),
		)
		return registry
	}

	it('is never refused by the default, and this test claims only that', async () => {
		// The test that was missing, and the reason the fetch case above was
		// found by hand instead of by CI. Every one of these is a real call
		// against the real tool: a stand-in would have been written to answer
		// the way the screen expects, which is how the false positive hid.
		//
		// What it does NOT claim — and an earlier version of it did — is that
		// the shipped tool set is proof the COMPARISON tolerates a real tool.
		// No shipped tool frames its result, so the scope returns `pass`
		// before any comparison runs, and this test would pass against a
		// comparison that refused everything. The claim it does make is worth
		// pinning: a caller who configures nothing gets no refusal from the
		// tool set this SDK ships, and a builtin that starts framing its
		// result on a path where that result is the request — `read` of a file
		// named after its own contents is exactly that — fails here.
		const { ctx, calls } = await shippedCalls({ withRestatements: true })
		const registry = shippedRegistry([toolResultCorrespondenceGuardrail()])

		for (const [name, input] of calls) {
			const result = await registry.execute(name, input, ctx)
			expect(result.error ?? '').not.toContain('tool-result-correspondence')
			expect(result.success).toBe(true)
		}
	})

	it('is compared, not merely skipped, when the scope is widened', async () => {
		// The strong half, and the one the earlier test only looked like it
		// was: the same real results, with the scope widened so the comparison
		// actually runs on every one of them. None is a restatement of its
		// request, which is the thing a false positive would falsify.
		const { ctx, calls } = await shippedCalls()
		const registry = shippedRegistry([toolResultCorrespondenceGuardrail({ scope: 'all' })])

		for (const [name, input] of calls) {
			const result = await registry.execute(name, input, ctx)
			expect(result.error ?? '').not.toContain('tool-result-correspondence')
			expect(result.success).toBe(true)
		}
	})

	it('would be refused by the screen if the host pointed it at them', async () => {
		// A shipped tool whose real result IS the request, so the default's
		// scope is not decoration and the exemption list is not either.
		//
		// `bash` is the near miss worth recording: echoing an argument is
		// exactly what a shell tool does, and it is NOT refused even under
		// `'all'` — `formatShellOutput` prefixes the line with `STDOUT:`, and
		// an equality check rather than a containment one is what saves it. A
		// screen that looked for the request anywhere in the result would
		// refuse every shell command that quotes one.
		const registry = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ scope: 'all' })],
			},
			WebFetchTool,
			...getBuiltinTools(),
		)
		// The real context, because `bash` needs a working directory to run
		// in: a tool that failed for its own reasons would pass this test
		// without the screen ever being consulted.
		const { ctx } = await shippedCalls()

		const fetched = await registry.execute(
			'web_fetch',
			{ url: 'https://docs.internal.example.com/rollback-procedure' },
			ctx,
		)
		const echoed = await registry.execute('bash', { command: `echo ${JSON.stringify(QUERY)}` }, ctx)

		expect(fetched.success).toBe(false)
		expect(echoed.success).toBe(true)
	})

	it('is exempt when the host names the tool, which is the escape hatch', async () => {
		// The other side of the same two tools: `scope: 'all'` is unusable
		// without `passthroughTools`, and naming the tool is the difference.
		const registry = registryWith(
			{
				resultGuardrails: [
					toolResultCorrespondenceGuardrail({
						scope: 'all',
						passthroughTools: ['web_fetch'],
					}),
				],
			},
			WebFetchTool,
		)
		const ctx = WEB_RETURNING_ITS_URL as unknown as ToolContext

		const result = await registry.execute(
			'web_fetch',
			{ url: 'https://docs.internal.example.com/rollback-procedure' },
			ctx,
		)

		expect(result.success).toBe(true)
	})
})

describe('a connected result through the real adapter path', () => {
	it('is refused when the server answered with the request', async () => {
		// N3's other half: a connected result is produced by the adapter, not
		// by a stand-in. `mcpToolResultToToolResult` then `frameServerResult`
		// is that path, and the pair is what a `callTool` return becomes
		// before the screen ever sees it.
		const framed = frameServerResult(
			mcpToolResultToToolResult({
				content: [{ type: 'text', text: QUERY }],
				isError: false,
			} as never),
			'weather-co',
			'lookup',
		)

		const r = screened({
			...toolReturning(framed.output, CONNECTED),
			name: 'mcp_weather-co_lookup',
		})

		const result = await r.execute('mcp_weather-co_lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(false)
		expect(result.error).toContain('the text inside the untrusted frame from')
	})
})

describe('a result the screen cannot read', () => {
	it('passes rather than fails closed', async () => {
		// A tool that ignores its own return type hands the screen a number.
		// `screenToolResult` turns a thrown screen into a refusal, so a screen
		// that assumed a string would refuse this — a false positive produced
		// by the screen's own bug rather than by the result.
		//
		// Scope widened on purpose: an unframed result is out of the default
		// scope before the read happens, which would make this pass for a
		// reason that has nothing to do with the contract it is checking.
		const r = registryWith(
			{
				resultGuardrails: [toolResultCorrespondenceGuardrail({ scope: 'all' })],
			},
			{
				...toolReturning(''),
				async execute() {
					return { success: true, output: 42 as unknown as string }
				},
			},
		)

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
		expect(result.error ?? '').not.toContain('threw')
	})
})

describe('the default a host gets without configuring anything', () => {
	it('does not screen: a restated request is returned as the tool produced it', async () => {
		// The screen ships as a preset, not as the default — the run config,
		// not the preset, is where a default belongs, and #426 established
		// that adding a control must not change an existing host's behaviour
		// on upgrade. This pins the preset's own half of that; the registry's
		// is pinned in `a-tool-result-can-be-refused`.
		const r = registryWith({}, connected(toolReturning(QUERY)))

		const result = await r.execute('lookup', { query: QUERY }, CTX)

		expect(result.success).toBe(true)
		// The server's words, reached past this codebase's frame: unframed
		// would also be right, and the frame is what the adapter produces.
		expect(untrustedEnvelopeBody(result.output)).toBe(QUERY)
	})
})
