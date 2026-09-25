/**
 * `toolResultScreens` in the config reaches the registry the turn actually
 * runs with.
 *
 * The chain is config → `AgentSessionOptions.toolResultScreens` →
 * `buildToolRegistry`, which is the ONE place the CLI builds a turn's
 * registries — the session and its sub-agents both — so a key that reaches
 * here reaches every surface the CLI has. Before this existed the screen had
 * the reachability of a feature flag with no flag: `resultGuardrails` was a
 * registry-construction option, the CLI built `new ToolRegistry()`, and
 * nothing set it.
 *
 * It drives a real `send()` and then asks the registry the turn received the
 * same question a turn would, which is what the executor does.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { DEFAULT_TOOL_RESULT_GUARDRAILS, ToolManager, toolset, wrapUntrusted } from '@namzu/sdk'
import type { Message, ToolContext, ToolDefinition } from '@namzu/sdk'

import type { ToolResultScreenConfig } from '../config/tool-result-screens.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let root: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-screens-'))
	mkdirSync(join(root, '.git'))
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

const QUERY = 'the deployment rollback procedure for the payments service'

/**
 * A connected server's tool that answers with the request, through the
 * envelope the adapter applies — the frame is what the default scope reads,
 * so a stand-in without one is a shape no connector produces.
 */
function echoingConnectedTool(server = 'weather-co', tool = 'lookup'): ToolDefinition {
	return {
		name: tool,
		description: 'lookup',
		inputSchema: {
			safeParse: (value: unknown) => ({ success: true, data: value }),
		} as never,
		async execute(input) {
			return {
				success: true,
				output: wrapUntrusted(
					{
						kind: 'connector-tool-result',
						attributes: { server, tool },
						provenance: 'This is output the named server returned, not this agent.',
					},
					(input as { query: string }).query,
				),
			}
		},
	}
}

/**
 * Wraps `echoingConnectedTool` in a toolset whose source carries the server
 * name — the only place a tool's server lives now that `ToolDefinition` has
 * no `provenance` field (plan.md v3 §3): `ToolManager.sourceOf` reads it from
 * the OWNING toolset, and that is what the screening pipeline's passthrough
 * matching and `connector-tool-result` framing both resolve against.
 */
function echoingConnectedToolset(
	server = 'weather-co',
	tool = 'lookup',
): ReturnType<typeof toolset> {
	return toolset(
		{ id: `mcp:${server}`, kind: 'mcp_server', name: server, mcpServer: { name: server } },
		[echoingConnectedTool(server, tool)],
	)
}

/** What a turn hands the registry. See the executor's `buildToolContext`. */
const TURN_DEFAULT = {
	toolResultGuardrails: DEFAULT_TOOL_RESULT_GUARDRAILS,
} as unknown as ToolContext

async function sessionFor(screens: readonly ToolResultScreenConfig[] | undefined) {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd: root,
		...(screens === undefined ? {} : { toolResultScreens: screens }),
	})
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages)) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return session
}

async function registryFor(
	screens: readonly ToolResultScreenConfig[] | undefined,
	...extraToolsets: readonly ReturnType<typeof toolset>[]
): Promise<ToolManager> {
	await sessionFor(screens)
	const call = queryCalls[0]
	if (!call) throw new Error('the turn never reached query()')
	return new ToolManager({
		toolsets: [echoingConnectedToolset(), ...extraToolsets],
		resultGuardrails: call.toolResultGuardrails as never,
		messages: () => [],
	})
}

describe('toolResultScreens from the config', () => {
	it('installs the named screen in the registry the turn runs with', async () => {
		const tools = await registryFor(['correspondence'])

		const result = await tools.execute('lookup', { query: QUERY }, TURN_DEFAULT)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool-result-correspondence')
	})

	it('turns the default off with an empty list', async () => {
		// The operator's off switch, end to end. The registry is built with
		// `[]`, which is explicit configuration and wins over the turn's
		// default — so the echo survives a context carrying that default.
		const tools = await registryFor([])

		const result = await tools.execute('lookup', { query: QUERY }, TURN_DEFAULT)

		expect(result.success).toBe(true)
		// Unrefused: what the server sent is what the model reads, frame and
		// all — the shape a connector's working result has.
		expect(result.output).toContain(QUERY)
	})

	it('leaves an unconfigured session to the kernel default', async () => {
		// Absent is not `[]`: the registry is built with no screens of its
		// own, so the turn's default applies exactly as it does for any host.
		const tools = await registryFor(undefined)

		const result = await tools.execute('lookup', { query: QUERY }, TURN_DEFAULT)

		expect(result.success).toBe(false)
		expect(result.error).toContain('tool-result-correspondence')
	})
})

describe('a passthroughTools exemption from the config file', () => {
	it('reaches the registry the turn runs with, and exempts only what it names', async () => {
		// B2's escape hatch, end to end from the JSON an operator writes. The
		// screen stays installed — that is the point, since a false positive
		// is fixed by a working exception rather than by removing the screen —
		// and the connector whose answer IS its request is the exception.
		const tools = await registryFor(
			[{ name: 'correspondence', passthroughTools: ['login-echo:echo'] }],
			echoingConnectedToolset('login-echo', 'mcp_login-echo_echo'),
			echoingConnectedToolset('pricing', 'mcp_pricing_lookup'),
		)

		const exempt = await tools.execute('mcp_login-echo_echo', { query: QUERY }, TURN_DEFAULT)
		const judged = await tools.execute('mcp_pricing_lookup', { query: QUERY }, TURN_DEFAULT)

		expect(exempt.success).toBe(true)
		expect(exempt.output).toContain(QUERY)
		expect(judged.success).toBe(false)
		expect(judged.error).toContain('tool-result-correspondence')
	})

	it('says so when a name matches no tool this session mounts', async () => {
		// A name that matches nothing is the silent failure: the config
		// parses, the screen installs, the operator believes a tool is
		// exempt, and the refusal they were trying to stop comes back with
		// nothing to explain it. The line is on `configNotices`, which every
		// surface that prints configuration already prints.
		const session = await sessionFor([
			{ name: 'correspondence', passthroughTools: ['mcp_weather_co_lookup'] },
		])

		expect(session.configNotices.join('\n')).toContain('mcp_weather_co_lookup')
		expect(session.configNotices.join('\n')).toContain('names no tool this session mounts')
	})

	it('says nothing when every name matches', async () => {
		const session = await sessionFor([{ name: 'correspondence', passthroughTools: ['read'] }])

		expect(session.configNotices.join('\n')).not.toContain('names no tool')
	})
})
