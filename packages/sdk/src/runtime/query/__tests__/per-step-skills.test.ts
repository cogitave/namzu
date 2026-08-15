import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { Skill } from '../../../types/skills/index.js'
import { drainQuery } from '../index.js'

/**
 * A run's skills are fixed at `query()` time and rendered into the cached
 * system prefix, so every skill a run might ever need is paid for on every
 * turn. A phased agent rarely needs them all at once.
 *
 * A peer runtime resolves instructions, model, tools, skills and subagents
 * from context at run time. namzu had the first three; this is the fourth.
 * The fifth is deliberately absent — see the note at the bottom.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

function skill(name: string, body?: string): Skill {
	return {
		metadata: { name, description: `${name} description` },
		dirPath: `/skills/${name}`,
		...(body !== undefined ? { body } : {}),
	}
}

async function run(provider: MockLLMProvider, over: Record<string, unknown> = {}): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-skills-'))
	workdirs.push(dir)
	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		agentId: 'agent_sk',
		agentName: 'Skill Agent',
		workingDirectory: dir,
		sessionId: 'ses_sk' as SessionId,
		topicId: 'thd_sk' as ThreadId,
		projectId: 'prj_sk' as ProjectId,
		tenantId: 'tnt_sk' as TenantId,
		messages: [createUserMessage('go')],
		...over,
	})
}

const sent = (provider: MockLLMProvider, index = 0): string =>
	JSON.stringify(provider.requests.at(index)?.messages ?? [])

describe('a step can put a skill in front of the model', () => {
	it('renders the skill it named', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await run(provider, { prepareStep: () => ({ skills: [skill('search-the-web')] }) })

		expect(sent(provider)).toContain('search-the-web')
	})

	it('sends nothing extra when the step names none', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await run(provider)

		expect(sent(provider)).not.toContain('Available Skills')
	})

	it('treats an empty list as naming none', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await run(provider, { prepareStep: () => ({ skills: [] }) })

		// An empty list is a caller saying "no skills this step", not a
		// request for an empty section header.
		expect(sent(provider)).not.toContain('Available Skills')
	})

	it('carries the step guidance alongside it', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await run(provider, {
			prepareStep: () => ({ system: 'You are researching.', skills: [skill('search-the-web')] }),
		})

		// Both ride the same ephemeral trailing message; neither should
		// displace the other.
		const body = sent(provider)
		expect(body).toContain('You are researching.')
		expect(body).toContain('search-the-web')
	})
})

describe('a step skill does not outlive its step', () => {
	it('is absent from the next step that does not ask for it', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [] as never, text: 'thinking' }, { text: 'done' }],
		})

		await run(provider, {
			prepareStep: ({ stepNumber }: { stepNumber: number }) =>
				stepNumber === 1 ? { skills: [skill('search-the-web')] } : {},
		})

		expect(sent(provider, 0)).toContain('search-the-web')
		if (provider.requests.length > 1) {
			expect(sent(provider, 1)).not.toContain('search-the-web')
		}
	})

	it('does not accumulate across steps', async () => {
		const provider = new MockLLMProvider({
			turns: [{ text: 'still working' }, { text: 'done' }],
		})

		await run(provider, {
			maxIterations: 2,
			prepareStep: () => ({ skills: [skill('search-the-web')] }),
		})

		// Appended for the call, never retained. Were it written into the run's
		// history the section would stack up turn after turn — the same
		// message repeated, growing the prompt and invalidating the cached
		// prefix every iteration.
		const systemCounts = provider.requests.map(
			(r) => (r.messages ?? []).filter((m) => m.role === 'system').length,
		)
		expect(new Set(systemCounts).size).toBe(1)
	})
})

/**
 * Sub-agents are deliberately NOT per-step, and this is the note rather than
 * a test that would pretend otherwise. Which agents `create_task` can reach
 * is baked into that tool's input schema, so varying it per step would
 * rebuild the tool catalogue every turn — a worse prompt-cache trade than
 * moving tools around, for a narrowing a step can already express by
 * withholding `create_task` through `activeTools`.
 */
