import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import { CompactionConfigSchema } from '../../config/runtime.js'
import {
	type ResidentLearningState,
	hashResidentSkill,
	projectResidentLearning,
} from '../../manager/resident/learning.js'
import type { ResidentState } from '../../manager/resident/store.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { drainQuery } from '../../runtime/query/index.js'
import { runCompactionCheck } from '../../runtime/query/iteration/phases/compaction.js'
import type { IterationContext } from '../../runtime/query/iteration/phases/context.js'
import { PromptCache } from '../../runtime/query/prompt-cache.js'
import { PromptBuilder } from '../../runtime/query/prompt.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createProjectInstructionMessage,
	createSystemMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PLAN_MODE_DOCTRINE } from '../coding-agent-doctrine.js'
import { PromptContributionRegistry } from '../contributions.js'
import {
	type ResidentStepPromptOptions,
	createResidentStepContributions,
} from '../resident-step.js'

const OUTPUT = 'Finish with the host receipt containing disposition and retained evidence.'
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function state(overrides: Partial<ResidentState> = {}): ResidentState {
	return {
		tenantId: 'bc1544a4-3cab-4e24-86c2-01874d5f0c39',
		agentKey: 'reviewer',
		identity: 'A repository reviewer.',
		objective: 'Check both remaining acceptance criteria in the authorized fixture.',
		revision: 4,
		stepsAdmitted: 2,
		phase: 'running',
		wakeAt: null,
		reason: 'The second acceptance criterion is now available.',
		summary: 'The first criterion passed with receipt ALPHA-471. Verify the second criterion.',
		claimId: 'c110ae82-43e4-43c1-a7ad-3ad8d8f89d75',
		...overrides,
	}
}

function registry(options: Partial<ResidentStepPromptOptions> = {}): PromptContributionRegistry {
	const result = new PromptContributionRegistry()
	for (const contribution of createResidentStepContributions({
		state: state(),
		outputInstructions: OUTPUT,
		...options,
	}))
		result.register(contribution)
	return result
}

function segments(options: Partial<ResidentStepPromptOptions> = {}) {
	return new PromptBuilder({
		tools: new ToolRegistry(),
		systemPrompt: 'You are the host assistant.',
		contributions: registry(options),
	}).buildSegmented()
}

function learning(): ResidentLearningState {
	const evidence = { key: 'approved-1', source: 'host:test', reason: 'Approved fixture guidance.' }
	const candidate = {
		name: 'checked-identifiers',
		description: 'Retain exact evidence identifiers.',
		body: 'Keep exact receipt identifiers and distinguish reported evidence from fresh observations.',
	}
	const hash = hashResidentSkill(candidate)
	return {
		revision: 1,
		identity: { text: 'An assistant that checks source evidence.', evidence },
		preferences: [{ key: 'report-style', value: 'Name acceptance criteria explicitly.', evidence }],
		skills: [
			{
				...candidate,
				hash,
				evidence,
				verification: {
					baselineHash: 'none',
					candidateHash: hash,
					evidenceDigest: 'a'.repeat(64),
					verificationTasks: 5,
					confirmationTasks: 5,
				},
			},
		],
		lastChange: evidence,
	}
}

describe('resident context separates stable guidance from the admitted snapshot', () => {
	it('keeps changing evidence outside the static prefix while retaining the whole objective', () => {
		const first = segments()
		const next = segments({
			state: state({
				stepsAdmitted: 3,
				summary: 'Both criteria are checked; receipt BETA-822 needs reporting.',
				reason: 'Report the finished verification.',
			}),
		})
		expect(next.static).toBe(first.static)
		expect(first.static).toContain(OUTPUT)
		expect(first.static).toContain('You are the host assistant.')
		expect(first.static).not.toContain('ALPHA-471')
		expect(first.dynamic).toContain('ALPHA-471')
		expect(next.dynamic).toContain('BETA-822')
		expect(next.dynamic).not.toContain('ALPHA-471')
		for (const prompt of [first, next]) expect(prompt.dynamic).toContain(state().objective)
		expect(JSON.parse(next.dynamic.split('\n\n')[1] ?? '')).toMatchObject({
			identity: state().identity,
			admission: 3,
			wakeReason: 'Report the finished verification.',
		})
	})

	it('describes read-only authority without imposing the interactive plan reply', () => {
		const readOnly = segments({ readOnly: true })
		expect(readOnly.static).toContain('Do not change files, persistent memory or external state.')
		expect(readOnly.static).toContain('Read-only objectives may be completed')
		expect(readOnly.static).toContain(OUTPUT)
		expect(readOnly.static).not.toContain('Then stop and wait')
		expect(readOnly.static).not.toContain('task_create')
		expect(readOnly.static).not.toContain('wakeAfterMs')
		expect(segments().static).not.toContain('## Read-only invocation')
		// The ordinary coding-agent contract remains independently available.
		expect(PLAN_MODE_DOCTRINE).toContain('Then stop and wait')
	})

	it('captures caller state, learning, skills and output instructions before later mutation', () => {
		const admitted = { ...state() }
		const profile = learning()
		const preference = { ...profile.preferences[0]!, value: 'Captured preference.' }
		const mutableLearning = { ...profile, preferences: [preference] }
		const options = {
			state: admitted,
			learning: mutableLearning,
			skillsContext: 'Captured skill context.',
			outputInstructions: OUTPUT,
		}
		const contributions = registry(options)
		const before = contributions.list().map((part) => part.render({}))
		admitted.summary = 'A later invocation must not leak.'
		preference.value = 'A later preference must not leak.'
		options.skillsContext = 'A later skill must not leak.'
		options.outputInstructions = 'A later response contract must not leak.'
		expect(contributions.list().map((part) => part.render({}))).toEqual(before)
		expect(contributions.render('dynamic', {}).join('\n')).toContain('Captured preference.')
		expect(contributions.render('dynamic', {}).join('\n')).toContain('Captured skill context.')
	})

	it('projects approved learning with the existing bound and explicit omission count', () => {
		const profile = learning()
		const large = {
			...profile,
			preferences: Array.from({ length: 20 }, (_, index) => ({
				key: `preference-${index}`,
				value: 'p'.repeat(1_000),
				evidence: profile.lastChange,
			})),
		}
		for (const current of [profile, large]) {
			const projection = projectResidentLearning(current, {
				maxChars: 12_000,
				skillNames: current.skills.map((skill) => skill.name),
			})
			const prompt = segments({ learning: current })
			expect(prompt.dynamic).toContain(projection.text)
			expect(prompt.static).not.toContain(current.identity!.text)
			if (projection.omitted)
				expect(prompt.dynamic).toContain(`${projection.omitted} learning entries were omitted`)
			else expect(prompt.dynamic).toContain(current.skills[0]!.body)
		}
	})

	it('refreshes a changed response contract or permission boundary through a shared cache', () => {
		const cache = new PromptCache({
			agentId: 'resident',
			projectId: 'f036bdfb-609f-4796-9f01-36423ebc2f94' as ProjectId,
		})
		const tools = new ToolRegistry()
		const before = cache.getSystemPromptSegmented({ tools, contributions: registry() })
		const after = cache.getSystemPromptSegmented({
			tools,
			contributions: registry({
				readOnly: true,
				outputInstructions: 'Return the new host receipt.',
			}),
		})
		expect(before.static).toContain(OUTPUT)
		expect(after.static).toContain('Return the new host receipt.')
		expect(after.static).toContain('## Read-only invocation')
		expect(after.static).not.toContain(OUTPUT)
	})
})

it('preserves resident state and project policy when older conversation is compacted', async () => {
	const prompt = segments({ learning: learning(), readOnly: true })
	const policy = createProjectInstructionMessage('Project policy: preserve the audit ledger.', [
		'AGENTS.md',
	])
	const messages: Message[] = [
		createSystemMessage(prompt.static, 'cache'),
		createSystemMessage(prompt.dynamic, 'ephemeral'),
		policy,
	]
	for (let index = 0; index < 8; index++) {
		messages.push(
			createUserMessage(`Old investigation ${index}: ${'x'.repeat(200)}`),
			createAssistantMessage(`Old result ${index}: ${'y'.repeat(200)}`),
		)
	}
	const before = messages.length
	const compactionConfig = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		contextWindowTokens: 100,
		clearToolResults: false,
	})
	const manager = new WorkingStateManager(compactionConfig)
	manager.addDecision('Checked the current acceptance receipt.')
	await runCompactionCheck({
		runConfig: { tokenBudget: 0 },
		compactionConfig,
		workingStateManager: manager,
		log: NOOP_LOGGER,
		runMgr: {
			id: 'f732fe15-0558-4154-b4e4-42033ead15ed' as RunId,
			currentIteration: 3,
			messages,
			clearLastPromptTokens: () => {},
			accumulateUsage: () => {},
		},
		emitEvent: async () => {},
	} as unknown as IterationContext)
	expect(messages.length).toBeLessThan(before)
	expect(messages.some((message) => String(message.content).includes('[COMPACTED CONTEXT]'))).toBe(
		true,
	)
	expect(messages[0]?.content).toBe(prompt.static)
	expect(messages[1]?.content).toBe(prompt.dynamic)
	expect(messages).toContainEqual(policy)
})

it('keeps the admitted objective, evidence and project policy through every query iteration', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-resident-context-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'inspect-1', name: 'inspect_receipt', rawArguments: '{}' }] },
			{ toolCalls: [{ id: 'inspect-2', name: 'inspect_receipt', rawArguments: '{}' }] },
			{ text: 'The fixture checks passed with fresh receipt BETA-822.' },
		],
	})
	const tools = new ToolRegistry()
	let inspections = 0
	tools.register({
		name: 'inspect_receipt',
		description: 'Read the current acceptance receipt.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: `BETA-822 observation ${++inspections}` }),
	})
	const run = await drainQuery({
		provider,
		tools,
		workingDirectory,
		systemPrompt: 'You are the host assistant.',
		promptContributions: registry({ readOnly: true }),
		projectInstructionContext: {
			prepareInitialSnapshot: () =>
				createProjectInstructionMessage('Project policy: preserve both acceptance criteria.', [
					'AGENTS.md',
				]),
			observeToolResult: () => undefined,
		},
		messages: [createUserMessage('Continue the authorized review.')],
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 5 },
		agentId: 'resident-reviewer',
		agentName: 'Resident reviewer',
		tenantId: state().tenantId as TenantId,
		sessionId: '5b7539bd-5049-44a7-bcda-0f70d922ed98' as SessionId,
		topicId: 'a821c608-6455-46fd-b370-21873e04c74c' as TopicId,
		projectId: 'f036bdfb-609f-4796-9f01-36423ebc2f94' as ProjectId,
	})
	// Real query iterations and tool results: a first-iteration-only trailing
	// contribution would lose ALPHA-471 on the second request.
	expect(inspections).toBe(2)
	expect(provider.requests).toHaveLength(3)
	for (const request of provider.requests) {
		const text = JSON.stringify(request.messages)
		for (const retained of [state().objective, 'ALPHA-471', 'Project policy:', OUTPUT])
			expect(text).toContain(retained)
		const system = request.messages.filter((message) => message.role === 'system')
		expect(system[0]?.content).not.toContain('ALPHA-471')
		expect(system[1]?.content).toContain('ALPHA-471')
	}
	expect(run.messages.some((message) => String(message.content).includes('BETA-822'))).toBe(true)
})
