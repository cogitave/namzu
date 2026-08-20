/**
 * The TUI owns a user/assistant-only model history and asks the real session
 * to compact it between turns. A helper-level test cannot prove that
 * `createAgentSession().compact` reaches that host-shaped path: the mounted
 * App test used a fake session whose compact method manufactured a summary,
 * while the real planner refused every history without a leading system
 * message.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAssistantMessage, createUserMessage } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gateway: {} as unknown,
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

const detectedAnthropic = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'a-model',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as never

const workDirs: string[] = []

afterEach(() => {
	for (const dir of workDirs.splice(0)) removeTempDir(dir)
})

describe('manual compaction reaches a real agent session', () => {
	it('compacts the user/assistant-only history the TUI passes', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-manual-compact-session-'))
		workDirs.push(cwd)
		const preferences = {
			version: 3,
			providers: [{ id: 'anthropic' }],
		} as Preferences
		const session = await createAgentSession(preferences, detectedAnthropic, { cwd })
		const oldFact = 'REAL_SESSION_OWNS_THIS_EARLY_FACT'
		const messages = [
			createUserMessage(oldFact),
			createAssistantMessage('acknowledged'),
			createUserMessage('turn two'),
			createAssistantMessage('answer two'),
			createUserMessage('turn three'),
			createAssistantMessage('answer three'),
			createUserMessage('turn four'),
			createAssistantMessage('answer four'),
		]

		try {
			const result = await session.compact(messages)

			expect(session.hasProvider).toBe(true)
			expect(result).not.toBeNull()
			if (!result) return
			expect(result.messages[0]).toEqual(result.summary)
			expect(result.summary.role).toBe('system')
			expect(result.summary.retain).toBe(true)
			expect(String(result.summary.content)).toContain(oldFact)
			expect(result.shed).toBeGreaterThan(0)
		} finally {
			await session.close()
		}
	})
})
