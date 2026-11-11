/**
 * While the review of a workflow start is open, the call row above it reads
 * as it does after approval: what the workflow is for, not the raw call. The
 * `workflow` tool joins a turn's tools only when the turn offers it, so the
 * session's presenter has to find its presentation through the workflow host.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'
import { queuedToolRow } from '../queued-calls.js'

let cwd: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-call-row-'))
})
afterEach(() => removeTempDir(cwd))

const SCRIPT =
	"export const meta = { name: 'audit', description: 'Scan, then fix the small things', phases: [{ title: 'Scan' }] }\nreturn 1"

async function open() {
	return createAgentSession(
		{
			version: 3,
			providers: [{ id: 'anthropic' }],
			subagents: { active: [] },
		} as Preferences,
		[
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
			} as unknown as DetectedProvider,
		],
		{ cwd, ephemeral: true },
	)
}

describe('the row of a workflow call that waits for its yes', () => {
	it('names what the workflow is for', async () => {
		const session = await open()
		try {
			const row = queuedToolRow(
				{
					id: 'w1',
					name: 'workflow',
					input: { script: SCRIPT },
					isDestructive: false,
				} as never,
				undefined,
				session.presenter,
				cwd,
				0,
			)
			expect(row?.label).toBe('Workflow(Scan, then fix the small things)')
		} finally {
			await session.close()
		}
	})

	it('prefers the summary the model gave', async () => {
		const session = await open()
		try {
			const row = queuedToolRow(
				{
					id: 'w1',
					name: 'workflow',
					input: { script: SCRIPT, description: 'Tidy two packages' },
					isDestructive: false,
				} as never,
				undefined,
				session.presenter,
				cwd,
				0,
			)
			expect(row?.label).toBe('Workflow(Tidy two packages)')
			expect(row?.label).not.toContain('"script"')
		} finally {
			await session.close()
		}
	})
})
