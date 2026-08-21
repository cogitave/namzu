/** A turn-scoped permission mode reaches the real AgentSession review handler. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
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

const review = {
	type: 'tool_review',
	runId: 'run_permission_mode',
	checkpointId: 'cp_permission_mode',
	toolCalls: [
		{
			id: 'call_write',
			name: 'write',
			input: { path: 'out.txt', content: 'changed' },
			isDestructive: true,
		},
	],
} as const

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-permission-mode-'))
})

afterEach(() => {
	removeTempDir(cwd)
})

async function sendWith(options: SendOptions): Promise<void> {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
	try {
		for await (const _event of session.send(
			[{ role: 'user', content: 'change the file', timestamp: 0 }],
			options,
		)) {
			// drain the real AgentSession boundary
		}
	} finally {
		await session.close()
	}
}

describe('the TUI permission-mode hop', () => {
	it('lets a per-turn strict mode reject without asking the human', async () => {
		const onPermission = vi.fn<(request: PermissionRequest) => Promise<PermissionDecision>>(
			async () => ({ kind: 'approve' }),
		)

		await sendWith({
			onPermission,
			permissionMode: 'strict',
		} as SendOptions)

		const handler = queryCalls[0]?.resumeHandler as
			| ((request: unknown) => Promise<unknown>)
			| undefined
		expect(queryCalls[0]?.runConfig).toMatchObject({ permissionMode: 'auto' })
		expect(handler, 'createAgentSession did not install a resume handler').toBeTypeOf('function')
		expect(await handler?.(review)).toEqual({
			action: 'reject_tools',
			feedback:
				'Refused: this run only permits tools an explicit rule allows, and no rule covers this call. Asking again will not change it — either the operator adds a rule, or this has to be done another way.',
		})
		expect(onPermission).not.toHaveBeenCalled()
	})
})
