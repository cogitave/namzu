/**
 * `open_url`: what it says, where it is mounted, and that it is reviewed.
 *
 * - it hands only http(s) to the opener and reports a started launcher as
 *   launched, never as "the page appeared";
 * - the TUI and `exec` mount it; `exec --json`, `drain`, ACP, a scheduled run,
 *   a resident worker and every sub-agent do not;
 * - in `prompt` mode a call to it is put to the user like any outward action.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Toolset } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { PermissionDecision, PermissionRequest, SendOptions } from '../../tui/agent.js'
import type { DetectedProvider, Preferences } from '../providers/index.js'
import { OPEN_URL_TOOL_NAME, createOpenUrlTool } from './open-url.js'

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

let capturedBuildTools: (() => readonly Toolset[]) | null = null
vi.mock('../subagents/runtime.js', () => ({
	createSubagentRuntime: async (opts: { buildTools: () => readonly Toolset[] }) => {
		capturedBuildTools = opts.buildTools
		return {
			gatewayForTurn: async () => ({}) as never,
			completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
			releaseTurn: async () => {},
			agentTool: {
				name: 'Agent',
				description: 'stub',
				inputSchema: { type: 'object', properties: {} },
				execute: async () => ({ success: true, output: '' }),
			},
			waitForTaskTool: {
				name: 'wait_for_task',
				description: 'stub',
				inputSchema: { type: 'object', properties: {} },
				execute: async () => ({ success: true, output: '' }),
			},
			allowedAgentIds: [],
		}
	},
}))

const preferences = {
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

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) {
			if (name === '__tests__' || name === '__fixtures__') continue
			out.push(...sources(path))
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
	}
	return out
}

let cwd: string
beforeEach(() => {
	queryCalls.length = 0
	capturedBuildTools = null
	cwd = mkdtempSync(join(tmpdir(), 'namzu-open-url-'))
})
afterEach(() => {
	removeTempDir(cwd)
})

async function run(open: (url: string) => boolean, url: string) {
	const tool = createOpenUrlTool(open)
	return tool.execute(tool.inputSchema.parse({ url }) as never, {} as never)
}

describe('open_url', () => {
	it('hands an https address to the opener and says only that the browser was launched', async () => {
		const open = vi.fn(() => true)
		const result = await run(open, 'https://example.com/?a=1&b=2')
		expect(open).toHaveBeenCalledWith('https://example.com/?a=1&b=2')
		expect(result.success).toBe(true)
		expect(result.output).toContain(
			"Opened https://example.com/?a=1&b=2 in the user's default browser: the launcher started.",
		)
		expect(result.output).toMatch(/No platform reports whether the tab itself appeared/)
	})

	it('refuses anything that is not http(s) without calling the opener', async () => {
		const open = vi.fn(() => true)
		for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'calc.exe']) {
			const result = await run(open, url)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/Only http:\/\/ and https:\/\//)
		}
		expect(open).not.toHaveBeenCalled()
	})

	it('reports honestly when no launcher could start', async () => {
		const result = await run(() => false, 'https://example.com/')
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/No browser launcher is available/)
	})

	it('is an outward, reviewed action: network, not read-only', () => {
		const tool = createOpenUrlTool(() => true)
		expect(tool.category).toBe('network')
		expect(tool.permissions).toContain('network_access')
		expect(tool.isReadOnly?.({ url: 'https://example.com/' } as never)).toBe(false)
	})
})

describe('where open_url is mounted', () => {
	it('only the TUI and exec ask for it', () => {
		const mounting = sources(SRC)
			.filter((file) => /openUrl:\s*true/.test(readFileSync(file, 'utf8')))
			.map((file) => relative(SRC, file).replaceAll('\\', '/'))
			.sort()
		expect(mounting).toEqual(['commands/exec.ts', 'tui/App.tsx'])
		for (const surface of [
			'commands/exec-json.ts',
			'commands/drain.ts',
			'commands/acp.ts',
			'schedule/fire/fire.ts',
			'integrations/resident/session-step.ts',
		]) {
			expect(readFileSync(join(SRC, surface), 'utf8')).not.toMatch(/openUrl|createOpenUrlTool/)
		}
	})

	it('a session asking for it has it; one that does not, and every sub-agent, lack it', async () => {
		const { createAgentSession } = await import('../../tui/agent.js')
		const headless = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			expect(headless.toolNames()).not.toContain(OPEN_URL_TOOL_NAME)
		} finally {
			await headless.close()
		}
		const session = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
			openUrl: true,
		})
		try {
			expect(session.toolNames()).toContain(OPEN_URL_TOOL_NAME)
			const child = (capturedBuildTools as unknown as () => readonly Toolset[])()
				.flatMap((ts) => ts.tools())
				.map((tool) => tool.name)
			expect(child).toContain('read')
			expect(child).not.toContain(OPEN_URL_TOOL_NAME)
		} finally {
			await session.close()
		}
	})

	it('in prompt mode a call to it is put to the user', async () => {
		const { createAgentSession } = await import('../../tui/agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
			openUrl: true,
		})
		const onPermission = vi.fn<(request: PermissionRequest) => Promise<PermissionDecision>>(
			async () => ({ kind: 'approve' }),
		)
		try {
			for await (const _event of session.send(
				[{ role: 'user', content: 'open example.com', timestamp: 0 }],
				{ onPermission, permissionMode: 'prompt' } as SendOptions,
			)) {
				// drain
			}
			const handler = queryCalls.at(-1)?.resumeHandler as (request: unknown) => Promise<unknown>
			await handler({
				type: 'tool_review',
				sessionId: '019a0000-0000-7000-8000-00000000a0a1',
				turnId: '64e436d8-4c5f-46f7-b3fb-35ca1a31a891',
				checkpointId: '45a5d18a-3a8a-48a4-9274-bd2a85ba7e18',
				toolCalls: [
					{
						id: 'call_open',
						name: OPEN_URL_TOOL_NAME,
						input: { url: 'https://example.com/' },
						isDestructive: false,
					},
				],
			})
			expect(onPermission).toHaveBeenCalledTimes(1)
		} finally {
			await session.close()
		}
	})
})
