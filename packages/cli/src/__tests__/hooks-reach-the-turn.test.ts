/**
 * A hook in the config reaches the plugin manager the turn runs with, and
 * decides there.
 *
 * The chain is config → AgentSessionOptions.hooks → the lifecycle manager
 * the session builds (with no plugins installed) → query()'s
 * `pluginManager`, whose `executeHooks` is what the executor calls before a
 * tool. So this drives a real `send()` and then asks the manager the turn
 * received the same question the executor would.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import type { Message, PluginLifecycleManager } from '@namzu/sdk'

import type { HooksConfig } from '../config/schema.js'
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
	root = mkdtempSync(join(tmpdir(), 'namzu-hooks-'))
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

async function managerFor(hooks: HooksConfig | undefined) {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd: root,
		...(hooks ? { hooks } : {}),
	})
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages)) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return queryCalls[0]?.pluginManager as PluginLifecycleManager | undefined
}

describe('hooks from the config', () => {
	it('reach the turn even with plugins off, and a pre_tool_use hook exiting 2 blocks the call', async () => {
		const manager = await managerFor({
			pre_tool_use: [{ matcher: 'bash', command: 'echo "no shell for you" >&2; exit 2' }],
		})
		if (!manager) throw new Error('the session ran with no plugin manager, so no hook could run')

		const blocked = await manager.executeHooks('pre_tool_use', {
			runId: 'run_x' as never,
			toolName: 'bash',
			toolInput: { command: 'rm -rf /' },
		})
		expect(blocked).toEqual([{ action: 'skip', reason: 'no shell for you' }])

		const other = await manager.executeHooks('pre_tool_use', {
			runId: 'run_x' as never,
			toolName: 'read',
			toolInput: { path: 'a' },
		})
		expect(other, 'the matcher keeps the hook off other tools').toEqual([{ action: 'continue' }])
	})

	it('give the turn no manager at all when none are configured and plugins are off', async () => {
		expect(await managerFor(undefined)).toBeUndefined()
	})
})
