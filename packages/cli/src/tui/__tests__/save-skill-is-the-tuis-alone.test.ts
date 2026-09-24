/**
 * `save_skill` is the interactive TUI's alone, and its question is its own:
 *
 * - only the App hands it to a session (`extraTools`), so `exec`, `drain`, a
 *   scheduled run and every sub-agent never have it;
 * - the permission gate does not ask about it in `prompt` or `auto`, because
 *   the tool's own screen asks in every mode — `auto` included; `plan` and
 *   `strict` still refuse it.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolManager, type Toolset } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { PermissionMode } from '../../permissions/mode.js'
import {
	SAVE_SKILL_TOOL_NAME,
	type SaveSkillAnswer,
	buildSaveSkillTool,
} from '../../skills/save.js'
import type { PermissionDecision, PermissionRequest, SendOptions } from '../agent.js'

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
vi.mock('../../integrations/subagents/runtime.js', () => ({
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
let home: string
let confirmations: number

beforeEach(() => {
	queryCalls.length = 0
	capturedBuildTools = null
	confirmations = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-save-session-'))
	home = mkdtempSync(join(tmpdir(), 'namzu-save-session-home-'))
})
afterEach(() => {
	removeTempDir(cwd)
	removeTempDir(home)
})

function saveTool() {
	return buildSaveSkillTool({
		cwd: () => cwd,
		home: () => home,
		sessionId: () => undefined,
		confirm: async (): Promise<SaveSkillAnswer> => {
			confirmations += 1
			return 'cancel'
		},
	})
}

const review = {
	type: 'tool_review',
	sessionId: '019a0000-0000-7000-8000-00000000a0a1',
	turnId: '64e436d8-4c5f-46f7-b3fb-35ca1a31a891',
	checkpointId: '45a5d18a-3a8a-48a4-9274-bd2a85ba7e18',
	toolCalls: [
		{
			id: 'call_save',
			name: SAVE_SKILL_TOOL_NAME,
			input: { name: 'x', description: 'Use when x.', body: 'Do x.' },
			isDestructive: false,
		},
	],
} as const

async function turnWith(mode: PermissionMode, withTool: boolean) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detectedAnthropic(), {
		cwd,
		...(withTool ? { extraTools: [saveTool()] } : {}),
	})
	const onPermission = vi.fn<(request: PermissionRequest) => Promise<PermissionDecision>>(
		async () => ({ kind: 'approve' }),
	)
	try {
		for await (const _event of session.send([{ role: 'user', content: 'save it', timestamp: 0 }], {
			onPermission,
			permissionMode: mode,
		} as SendOptions)) {
			// drain
		}
		return { session, onPermission, call: queryCalls.at(-1) as Record<string, unknown> }
	} finally {
		await session.close()
	}
}

describe('save_skill belongs to the TUI alone', () => {
	it('only the App builds it, and only through extraTools', () => {
		const builders = sources(SRC)
			.filter((file) => /buildSaveSkillTool\(/.test(readFileSync(file, 'utf8')))
			.map((file) => relative(SRC, file).replaceAll('\\', '/'))
			.sort()
		expect(builders).toEqual(['skills/save.ts', 'tui/App.tsx'])
		for (const surface of [
			'commands/exec.ts',
			'commands/exec-json.ts',
			'commands/drain.ts',
			'commands/acp.ts',
			'schedule/fire/fire.ts',
			'integrations/resident/session-step.ts',
		]) {
			expect(readFileSync(join(SRC, surface), 'utf8')).not.toMatch(/save_skill|buildSaveSkillTool/)
		}
	})

	it('a session without it (exec, drain, a scheduled run) and every sub-agent lack it', async () => {
		const { createAgentSession } = await import('../agent.js')
		const headless = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			expect(headless.toolNames()).not.toContain(SAVE_SKILL_TOOL_NAME)
		} finally {
			await headless.close()
		}
		const tui = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
			extraTools: [saveTool()],
		})
		try {
			expect(tui.toolNames()).toContain(SAVE_SKILL_TOOL_NAME)
			// It loads what it saved through the skill tool, next turn.
			expect(tui.toolNames()).toContain('skill')
			const child = (capturedBuildTools as unknown as () => readonly Toolset[])()
				.flatMap((ts) => ts.tools())
				.map((tool) => tool.name)
			expect(child).toContain('read')
			expect(child).not.toContain(SAVE_SKILL_TOOL_NAME)
		} finally {
			await tui.close()
		}
	})

	it.each(['prompt', 'accept-edits', 'auto'] as const)(
		'in %s mode the gate does not ask, and the tool still asks on its own screen',
		async (mode) => {
			const { onPermission, call } = await turnWith(mode, true)
			const handler = call.resumeHandler as (request: unknown) => Promise<unknown>
			expect(await handler(review)).toEqual({ action: 'approve_tools' })
			expect(onPermission).not.toHaveBeenCalled()

			const registry = new ToolManager({
				toolsets: call.toolsets as readonly Toolset[],
				messages: () => [],
			})
			const tool = registry.get(SAVE_SKILL_TOOL_NAME)
			expect(tool).toBeDefined()
			const result = await tool?.execute(
				tool.inputSchema.parse({ name: 'x', description: 'Use when x.', body: 'Do x.' }) as never,
				{} as never,
			)
			expect(confirmations).toBe(1)
			expect(result?.success).toBe(false)
		},
	)

	it.each(['plan', 'strict'] as const)('in %s mode it is refused without asking', async (mode) => {
		const { onPermission, call } = await turnWith(mode, true)
		const handler = call.resumeHandler as (request: unknown) => Promise<{ action: string }>
		expect((await handler(review)).action).toBe('reject_tools')
		expect(onPermission).not.toHaveBeenCalled()
	})
})
