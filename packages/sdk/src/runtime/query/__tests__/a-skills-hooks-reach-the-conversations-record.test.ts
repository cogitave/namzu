import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { SkillTool } from '../../../tools/builtins/skill.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionRecord } from '../../../types/session/index.js'
import type { SkillRegistryRef } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'

/**
 * The `skill` tool's host asks for a skill's hooks to be kept, and the turn
 * writes them into the conversation's own log as an ignorable record that names
 * the skill, its folder, whether its grants were withheld and the call that
 * loaded it.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function registry(resumable: boolean): SkillRegistryRef {
	return {
		names: () => ['guarded'],
		async load(name) {
			if (name !== 'guarded') return undefined
			return {
				skill: {
					metadata: { name: 'guarded', description: 'd', hooksSource: 'hooks:\n  PreToolUse: []' },
					body: 'Run commands.',
					dirPath: '/skills/guarded',
				},
			}
		},
		prepareHooks: () => ({
			withholdGrants: true,
			resumable,
			attach: () => ({ remove: () => undefined }),
		}),
	}
}

async function run(resumable: boolean, turns: MockTurn[]) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-record-'))
	dirs.push(workingDirectory)
	const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
	await drainQuery(
		{
			provider: new MockLLMProvider({ turns }),
			toolsets: [testToolset(SkillTool)],
			skillRegistry: registry(resumable),
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_skill',
			agentName: 'Skill',
			messages: [{ role: 'user', content: 'use the guarded skill' }],
			workingDirectory,
			sessionId: sessionLog.sessionId,
			sessionLog,
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			retry: false,
		} as unknown as QueryParams,
		() => {},
	)
	const records: SessionRecord[] = []
	for await (const { record } of sessionLog.read()) records.push(record)
	return records
}

const useSkill: MockTurn = { toolCalls: [{ name: 'skill', args: { name: 'guarded' } }] }

describe('a skill whose hooks were attached, through a real turn', () => {
	it('is written into the conversation log as an ignorable record, in the turn that loaded it', async () => {
		const records = await run(true, [useSkill, { text: 'done' }])
		const kept = records.filter((record) => record.type === 'skill_hooks_attached')
		expect(kept).toHaveLength(1)
		expect(kept[0]).toMatchObject({
			type: 'skill_hooks_attached',
			ignorable: true,
			skill: 'guarded',
			directory: '/skills/guarded',
			grantsWithheld: true,
		})
		expect((kept[0] as { toolCallId?: string }).toolCallId).toBeTruthy()
		expect(kept[0]?.turnId).toBeDefined()
	})

	it('writes nothing for a skill the host did not ask to keep', async () => {
		const records = await run(false, [useSkill, { text: 'done' }])
		expect(records.filter((record) => record.type === 'skill_hooks_attached')).toHaveLength(0)
	})

	it('writes nothing for a conversation that never loaded a skill', async () => {
		const records = await run(true, [{ text: 'hello' }])
		expect(records.filter((record) => record.type === 'skill_hooks_attached')).toHaveLength(0)
	})
})
