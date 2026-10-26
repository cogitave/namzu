/**
 * The terminal's opt-in to asking about one call at a time has to reach the
 * kernel. `query` is replaced so the test sees exactly what a turn is handed.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PerCallReviewConfig } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'
import type { PermissionFn } from '../agent.js'

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

let workDir: string
let stateRoot: string

beforeEach(() => {
	queryCalls.length = 0
	workDir = mkdtempSync(join(tmpdir(), 'namzu-per-call-cwd-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-per-call-state-'))
})

afterEach(() => {
	removeTempDir(workDir)
	removeTempDir(stateRoot)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
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

async function turn(input: {
	readonly onPermission?: PermissionFn
	readonly perCallReview?: PerCallReviewConfig
	readonly reviewHold?: { readonly reason: string }
}): Promise<Record<string, unknown>> {
	const { createAgentSession } = await import('../agent.js')
	const sessions = await openSessions(workDir, { stateRoot })
	const session = await createAgentSession(prefs, detected, {
		cwd: workDir,
		stateRoot,
		scope: {
			sessionId: await startConversation(sessions),
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		},
	})
	try {
		for await (const _ of session.send([{ role: 'user', content: 'go', timestamp: 0 }], {
			...(input.onPermission ? { onPermission: input.onPermission } : {}),
			...(input.perCallReview ? { perCallReview: input.perCallReview } : {}),
			...(input.reviewHold ? { reviewHold: input.reviewHold } : {}),
		})) {
			// The query mock captures the params.
		}
	} finally {
		await session.close()
	}
	return queryCalls[0] as Record<string, unknown>
}

describe('asking about one call at a time reaches the kernel', () => {
	const perCallReview: PerCallReviewConfig = {}
	const onPermission: PermissionFn = async () => ({ kind: 'approve' })

	it('hands the turn the host config when there is a person to ask', async () => {
		const params = await turn({ onPermission, perCallReview })
		expect(params.perCallReview).toBe(perCallReview)
	})

	it('hands the turn nothing when the host did not ask for it', async () => {
		const params = await turn({ onPermission })
		expect(params.perCallReview).toBeUndefined()
	})

	it('hands the turn nothing when nobody can be asked', async () => {
		const params = await turn({ perCallReview })
		expect(params.perCallReview).toBeUndefined()
	})

	it('hands a held turn nothing: a scheduled run parks what needs a person', async () => {
		const params = await turn({
			onPermission,
			perCallReview,
			reviewHold: { reason: 'scheduled' },
		})
		expect(params.perCallReview).toBeUndefined()
	})
})
