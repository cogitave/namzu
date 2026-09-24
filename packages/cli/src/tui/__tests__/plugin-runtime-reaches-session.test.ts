import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createCliPluginRuntime } from '../../integrations/plugins/runtime.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []
const HOOK_RECORD = '__namzuPluginRuntimeReachabilityTest'

afterEach(() => {
	vi.unstubAllGlobals()
	delete (globalThis as Record<string, unknown>)[HOOK_RECORD]
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'deepseek' }],
	subagents: { active: [] },
}

const detected = [
	{
		entry: PROVIDER_REGISTRY.deepseek,
		source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	} as DetectedProvider,
]

function response(chunks: readonly unknown[]): Response {
	return new Response(
		`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
		{ status: 200, headers: { 'content-type': 'text/event-stream' } },
	)
}

function toolCallResponse(): Response {
	return response([
		{
			id: 'chatcmpl-plugin-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: 'call_plugin_skill',
								type: 'function',
								function: {
									name: 'skill',
									arguments: '{"name":"ledger__reconcile"}',
								},
							},
							{
								index: 1,
								id: 'call_search_plugin_tool',
								type: 'function',
								function: {
									name: 'search_tools',
									arguments: '{"query":"ledger audit"}',
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: 'chatcmpl-plugin-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
			usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
		},
	])
}

function pluginToolResponse(): Response {
	return response([
		{
			id: 'chatcmpl-plugin-runtime-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: 'call_plugin_audit',
								type: 'function',
								function: { name: 'ledger__audit', arguments: '{}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: 'chatcmpl-plugin-runtime-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		},
	])
}

function answerResponse(): Response {
	return response([
		{
			id: 'chatcmpl-plugin-answer',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
		},
		{
			id: 'chatcmpl-plugin-answer',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-chat',
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
		},
	])
}

async function projectWithPlugin(manifest: unknown): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-plugin-runtime-'))
	roots.push(cwd)
	const plugin = join(cwd, '.namzu', 'plugins', 'ledger')
	await mkdir(join(plugin, 'skills', 'reconcile'), { recursive: true })
	await writeFile(join(plugin, 'plugin.json'), JSON.stringify(manifest), 'utf8')
	return cwd
}

describe('the CLI owns a real plugin runtime', () => {
	it('observes and changes the live contributions only between invocations', async () => {
		const cwd = await projectWithPlugin({
			name: 'ledger',
			version: '1.0.0',
			description: 'Ledger tools',
			tools: ['tools.mjs'],
			skills: ['skills/reconcile'],
		})
		const root = join(cwd, '.namzu', 'plugins', 'ledger')
		await writeFile(
			join(root, 'tools.mjs'),
			"export const tools = [{ name: 'audit', description: 'audit', async execute() { return { success: true, output: 'ok' }; } }];\n",
		)
		await writeFile(
			join(root, 'skills', 'reconcile', 'SKILL.md'),
			'---\nname: reconcile\ndescription: Reconcile ledger\n---\n\nRead ledger.\n',
		)
		const session = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: ['project'] },
			// Without the built-in skills, the plugin runtime owns the skill tool.
			skills: { builtin: false },
		})
		try {
			expect(session.hasProvider, session.errorHint ?? '').toBe(true)
			const plugins = session.plugins!
			expect(plugins.list()).toEqual([
				expect.objectContaining({
					name: 'ledger',
					status: 'enabled',
					tools: ['ledger__audit'],
					skills: ['ledger__reconcile'],
					rootDir: root,
				}),
			])
			const stream = session
				.send([createUserMessage('held before provider invocation')])
				[Symbol.asyncIterator]()
			await expect(plugins.setEnabled('ledger', false)).rejects.toThrow(/active session operation/)
			await expect(plugins.rememberState('ledger')).rejects.toThrow(/active session operation/)
			expect(plugins.list()[0]?.status).toBe('enabled')
			await stream.return?.()
			await plugins.setEnabled('ledger', false)
			expect(plugins.list()[0]).toMatchObject({
				status: 'disabled',
				tools: [],
				skills: [],
			})
			expect(session.toolNames()).not.toContain('ledger__audit')
			expect(session.toolNames()).not.toContain('skill')
			await plugins.setEnabled('ledger', false)
			await plugins.setEnabled('ledger', true)
			await plugins.setEnabled('ledger', true)
			expect(plugins.list()[0]).toMatchObject({
				status: 'enabled',
				tools: ['ledger__audit'],
				skills: ['ledger__reconcile'],
			})
			expect(session.toolNames()).toContain('skill')
			await expect(plugins.setEnabled('absent', true)).rejects.toThrow(/not loaded/)
		} finally {
			await session.close()
		}
		expect(session.plugins?.list()).toEqual([])
		await expect(session.plugins?.setEnabled('ledger', true)).rejects.toThrow(/closed/i)
	})

	it.skipIf(process.platform === 'win32')(
		'does not follow a project-scope ancestor link outside the trusted cwd',
		async () => {
			const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-plugin-scope-'))
			const outside = await mkdtemp(join(tmpdir(), 'namzu-cli-plugin-outside-'))
			roots.push(cwd, outside)
			const externalPlugin = join(outside, 'plugins', 'outside-plugin')
			await mkdir(externalPlugin, { recursive: true })
			// Generated state and executable project extensions share the `.namzu`
			// ancestor. The runtime must refuse that ancestor when it is redirected
			// outside the trusted cwd; silently treating it as healthy would let both
			// state writes and plugin discovery cross the trust boundary.
			await writeFile(join(externalPlugin, 'plugin.json'), '{"outside":"was read"}', 'utf8')
			await symlink(outside, join(cwd, '.namzu'), 'dir')

			const session = await createAgentSession(preferences, detected, {
				cwd,
				plugins: { enabled: true, allowedScopes: ['project'] },
			})
			try {
				// Generated state no longer lives under `<cwd>/.namzu` at all, so the
				// session has nothing to refuse there and starts. The two crossings
				// the redirect used to threaten are still closed: discovery refuses a
				// project scope that resolves outside the trusted cwd, and nothing is
				// written through the link.
				expect(session.hasProvider).toBe(true)
				expect(JSON.stringify(session.plugins?.list() ?? [])).not.toContain('outside')
			} finally {
				await session.close()
			}
			expect(await readdir(outside)).toEqual(['plugins'])
			expect(await readdir(join(outside, 'plugins'))).toEqual(['outside-plugin'])
		},
	)

	it('rolls back contributions when a later plugin refuses startup', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-cli-plugin-rollback-'))
		roots.push(cwd)
		const plugins = join(cwd, '.namzu', 'plugins')
		const good = join(plugins, 'a-good')
		const bad = join(plugins, 'b-bad')
		await mkdir(good, { recursive: true })
		await mkdir(bad, { recursive: true })
		await writeFile(
			join(good, 'plugin.json'),
			JSON.stringify({
				name: 'good',
				version: '1.0.0',
				description: 'must be rolled back',
				tools: ['tools.mjs'],
			}),
			'utf8',
		)
		await writeFile(
			join(good, 'tools.mjs'),
			"export const tools = [{ name: 'probe', description: 'probe', async execute() { return { success: true, output: 'ok' }; } }];\n",
			'utf8',
		)
		await writeFile(join(bad, 'plugin.json'), '{"definitely":"invalid"}', 'utf8')
		const tools = new ToolRegistry()

		await expect(
			createCliPluginRuntime({ enabled: true, allowedScopes: ['project'] }, tools, cwd),
		).rejects.toThrow(/Plugin runtime could not start/i)
		expect(tools.has('good__probe')).toBe(false)
		expect(tools.has('skill')).toBe(false)
	})

	it('keeps discovery and plugin imports off until enabled exactly', async () => {
		const cwd = await projectWithPlugin({ definitely: 'not a valid manifest' })

		const disabled = await createAgentSession(preferences, detected, { cwd })
		try {
			expect(disabled.hasProvider).toBe(true)
		} finally {
			await disabled.close()
		}
		for (const plugins of [{}, { enabled: false, allowedScopes: ['project'] as const }] as const) {
			const notEnabled = await createAgentSession(preferences, detected, { cwd, plugins })
			try {
				expect(notEnabled.hasProvider).toBe(true)
			} finally {
				await notEnabled.close()
			}
		}
		const discoveryDisabled = await createAgentSession(preferences, detected, {
			cwd,
			plugins: {
				enabled: true,
				autoDiscovery: false,
				allowedScopes: ['project'],
			},
		})
		try {
			expect(discoveryDisabled.hasProvider).toBe(true)
		} finally {
			await discoveryDisabled.close()
		}
		const scopeExcluded = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: [] },
		})
		try {
			expect(scopeExcluded.hasProvider).toBe(true)
		} finally {
			await scopeExcluded.close()
		}

		const enabled = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: ['project'] },
		})
		try {
			expect(enabled.hasProvider).toBe(false)
			expect(enabled.errorHint).toMatch(/Plugin runtime could not start/i)
		} finally {
			await enabled.close()
		}
	})

	it('carries one plugin registry into the prompt, skill tool and lifecycle hooks', async () => {
		const cwd = await projectWithPlugin({
			name: 'ledger',
			version: '1.0.0',
			description: 'ledger workflow',
			tools: ['tools.mjs'],
			skills: ['skills/reconcile'],
			hooks: ['hooks.mjs'],
		})
		const plugin = join(cwd, '.namzu', 'plugins', 'ledger')
		await writeFile(
			join(plugin, 'skills', 'reconcile', 'SKILL.md'),
			'---\nname: reconcile\ndescription: reconcile the exact ledger\n---\n\nPLUGIN_SKILL_BODY_EXACT\n',
			'utf8',
		)
		await writeFile(
			join(plugin, 'tools.mjs'),
			`const inputSchema = {
  safeParse(input) { return { success: true, data: input }; },
  async safeParseAsync(input) { return { success: true, data: input }; },
};
export const tools = [{
  name: 'audit',
  description: 'PLUGIN_TOOL_DISCOVERY_EXACT ledger audit',
  inputSchema,
  modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissions: [],
  async execute() { return { success: true, output: 'PLUGIN_TOOL_OUTPUT_EXACT' }; },
}];
`,
			'utf8',
		)
		await writeFile(
			join(plugin, 'hooks.mjs'),
			`export const hooks = [{ event: 'pre_llm_call', async handler(ctx) { globalThis.${HOOK_RECORD}.push({ event: ctx.event, turnId: ctx.turnId }); return { action: 'continue' }; } }];\n`,
			'utf8',
		)
		const hookEvents: Array<{ event: string; turnId: string }> = []
		;(globalThis as Record<string, unknown>)[HOOK_RECORD] = hookEvents
		const requests: unknown[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)))
				if (requests.length === 1) return toolCallResponse()
				if (requests.length === 2) return pluginToolResponse()
				return answerResponse()
			}),
		)

		const session = await createAgentSession(preferences, detected, {
			cwd,
			plugins: {
				enabled: true,
				allowedScopes: ['project'],
				hookTimeoutMs: 1_000,
			},
		})
		try {
			expect(session.hasProvider).toBe(true)
			const events: unknown[] = []
			for await (const event of session.send([createUserMessage('reconcile it')]))
				events.push(event)

			expect(requests, JSON.stringify(events)).toHaveLength(3)
			expect(JSON.stringify(requests[0])).toContain('ledger__reconcile')
			expect(JSON.stringify(requests[1])).toContain('PLUGIN_SKILL_BODY_EXACT')
			expect(JSON.stringify(requests[1])).toContain('ledger__audit')
			expect(JSON.stringify(requests[2])).toContain('PLUGIN_TOOL_OUTPUT_EXACT')
			expect(hookEvents.map((event) => event.event)).toEqual([
				'pre_llm_call',
				'pre_llm_call',
				'pre_llm_call',
			])
			expect(new Set(hookEvents.map((event) => event.turnId)).size).toBe(1)
		} finally {
			await session.close()
		}
	})

	it('applies the configured hook deadline before provider work', async () => {
		const cwd = await projectWithPlugin({
			name: 'ledger',
			version: '1.0.0',
			description: 'held hook',
			hooks: ['hooks.mjs'],
		})
		const plugin = join(cwd, '.namzu', 'plugins', 'ledger')
		await writeFile(
			join(plugin, 'hooks.mjs'),
			"export const hooks = [{ event: 'pre_llm_call', async handler() { return await new Promise(() => {}); } }];\n",
			'utf8',
		)
		const network = vi.fn<typeof fetch>()
		vi.stubGlobal('fetch', network)
		const session = await createAgentSession(preferences, detected, {
			cwd,
			plugins: { enabled: true, allowedScopes: ['project'], hookTimeoutMs: 5 },
		})

		try {
			const eventsPromise = (async () => {
				const events: Array<{ kind: string; message?: string }> = []
				for await (const event of session.send([createUserMessage('do not reach the provider')])) {
					events.push(event)
				}
				return events
			})()
			// The hook's own deadline is 5ms. This used to race `eventsPromise`
			// against its own real safety timer — first 500ms, then 3000ms
			// once 500ms proved too tight on a loaded CI runner — but raising
			// the number only shrank the window instead of closing it: both
			// bounds compete with the same clock as the turn setup they wait
			// on. A regression that dropped the 5ms deadline (or a turn that
			// never applies it) now hangs and fails on Vitest's own
			// per-test timeout instead of a hand-rolled one racing the same
			// clock.
			const events = await eventsPromise
			expect(events).toContainEqual(
				expect.objectContaining({
					kind: 'error',
					message: expect.stringMatching(/hook timeout/i),
				}),
			)
			expect(network).not.toHaveBeenCalled()
		} finally {
			await session.close()
		}
	})
})
