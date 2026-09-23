import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SkillRegistry } from '../../../skills/registry.js'
import { SkillTool } from '../../../tools/builtins/skill.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { PermissionMode } from '../../../types/permission/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { PrepareStep } from '../../../types/session/prepare-step.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Loaded content cannot change the tool surface; only the host can.
 *
 * A skill's `allowed-tools` used to be intersected with the step's list from
 * the batch after the skill was loaded. In staging a skill declared
 * `allowed-tools: skill, read, shell, output verification` — words, not tool
 * names — and every later call to `bash`, `write`, `glob` or
 * `verify_outputs` in that turn was refused: `Tool "bash" is not available
 * on this step. Available: skill, read, shell, output verification`.
 *
 * These run the real query loop, the real registry and the real `skill`
 * tool, and pin the rule from every side: the tool surface the model is
 * offered and the one the executor enforces are the same before and after a
 * skill loads, a skill cannot take a tool away, cannot hand back one the
 * host withheld, and cannot change how a call is authorized.
 */

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

/** The skill from the staging regression, verbatim in its tool list. */
const STAGING_DECLARATION = 'skill, read, shell, output verification'

function skills(allowedTools: string): SkillRegistryRef {
	return {
		load: async (name) =>
			name === 'delivery'
				? {
						skill: {
							metadata: { name: 'delivery', description: 'delivery work', allowedTools },
							body: 'Deliver the work.',
						},
					}
				: undefined,
		names: () => ['delivery'],
	}
}

/**
 * The default toolset the regression took away, plus `read`, with every
 * call that actually ran recorded by name.
 */
function toolset(ran: string[], seen: ToolContext['allowedTools'][] = []): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(SkillTool)
	tools.register(
		defineTool({
			name: 'probe',
			description: 'records the list the executor enforces for this call',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (_input, context) => {
				seen.push(context.allowedTools === undefined ? undefined : [...context.allowedTools])
				return { success: true, output: 'probed' }
			},
		}),
	)
	const shapes: ReadonlyArray<{ name: string; readOnly: boolean }> = [
		{ name: 'read', readOnly: true },
		{ name: 'bash', readOnly: false },
		{ name: 'write', readOnly: false },
		{ name: 'glob', readOnly: true },
		{ name: 'verify_outputs', readOnly: true },
	]
	for (const shape of shapes) {
		tools.register(
			defineTool({
				name: shape.name,
				description: `${shape.name} for the test`,
				inputSchema: z.object({}),
				category: shape.readOnly ? 'analysis' : 'shell',
				permissions: [],
				readOnly: shape.readOnly,
				destructive: false,
				concurrencySafe: shape.readOnly,
				execute: async () => {
					ran.push(shape.name)
					return { success: true, output: `${shape.name} ran` }
				},
			}),
		)
	}
	return tools
}

const loadSkill: MockTurn = {
	toolCalls: [{ id: 'load', name: 'skill', args: { name: 'delivery' } }],
	finishReason: 'tool_calls',
}

const batchOf = (id: string, ...names: string[]): MockTurn => ({
	toolCalls: names.map((name, index) => ({ id: `${id}_${index}`, name, args: {} })),
	finishReason: 'tool_calls',
})

interface RunOptions {
	readonly declared: string
	readonly turns: readonly MockTurn[]
	readonly allowedTools?: string[]
	readonly authorizationGate?: AuthorizationGateConfig
	readonly permissionMode?: PermissionMode
	readonly prepareStep?: PrepareStep
	readonly resumeHandler?: (request: HITLDecisionRequest) => Promise<HITLResumeDecision>
}

async function run(options: RunOptions) {
	const ran: string[] = []
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-surface-'))
	workdirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns: [...options.turns, { text: 'done' }] })
	const turn = await drainQuery({
		provider,
		tools: toolset(ran),
		skillRegistry: skills(options.declared),
		agentId: 'agent_skill_surface',
		agentName: 'Skill Surface Agent',
		messages: [createUserMessage('deliver the work')],
		workingDirectory,
		turnConfig: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 10,
			...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
		...(options.authorizationGate ? { authorizationGate: options.authorizationGate } : {}),
		...(options.resumeHandler ? { resumeHandler: options.resumeHandler } : {}),
		...(options.prepareStep ? { prepareStep: options.prepareStep } : {}),
	})
	const toolResults = provider.requests
		.flatMap((request) => request.messages ?? [])
		.filter((message) => message.role === 'tool')
		.map((message) => String(message.content))
	return { turn, ran, toolResults }
}

/**
 * The skill really loaded. Without this every case below would pass just
 * as well if the load had failed, because a skill that never loaded
 * changes nothing either.
 */
function expectLoaded(toolResults: readonly string[]): void {
	expect(toolResults.join('\n')).toContain('Deliver the work.')
}

const DEFAULT_TOOLS = ['skill', 'read', 'bash', 'write', 'glob', 'verify_outputs']

describe('a loaded skill cannot take a tool away', () => {
	it.each([
		['an unrestricted turn', undefined],
		['a turn with a step list', DEFAULT_TOOLS],
	])(
		'leaves bash, write, glob and verify_outputs callable after the staging skill, in %s',
		async (_label, allowedTools) => {
			const { turn, ran, toolResults } = await run({
				declared: STAGING_DECLARATION,
				...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
				turns: [loadSkill, batchOf('after', 'bash', 'write', 'glob', 'verify_outputs')],
			})

			expect(turn.status, JSON.stringify(turn)).toBe('completed')
			expectLoaded(toolResults)
			expect(toolResults.join('\n')).toContain('It also mentions "shell", "output verification"')
			expect([...ran].sort()).toEqual(['bash', 'glob', 'verify_outputs', 'write'])
			expect(toolResults.join('\n')).not.toMatch(/not available on this step/)
		},
	)

	it('leaves the calls issued alongside the skill alone', async () => {
		// Nothing is adopted, so there is no batch boundary to respect: the
		// sibling calls and the ones after run exactly as they would have.
		const alongside: MockTurn = {
			toolCalls: [...(loadSkill.toolCalls ?? []), { id: 'with_bash', name: 'bash', args: {} }],
			finishReason: 'tool_calls',
		}
		const { ran, toolResults } = await run({
			declared: 'read',
			allowedTools: [...DEFAULT_TOOLS],
			turns: [alongside, batchOf('after', 'write')],
		})

		expectLoaded(toolResults)
		expect(ran).toEqual(['bash', 'write'])
	})

	it('does not narrow even when the skill names only real tools', async () => {
		// The staging skill's words were not the defect; a list that can take
		// tools away is. A perfectly spelled `allowed-tools: read` narrows
		// nothing either.
		const { ran, toolResults } = await run({
			declared: 'read',
			turns: [loadSkill, batchOf('after', 'bash', 'write')],
		})

		expectLoaded(toolResults)
		expect([...ran].sort()).toEqual(['bash', 'write'])
		expect(toolResults.join('\n')).not.toMatch(/not available on this step/)
	})
})

describe('a loaded skill cannot hand back a tool the host withheld', () => {
	it('refuses a withheld tool the skill declares', async () => {
		const { ran, toolResults } = await run({
			declared: 'read, bash, write',
			allowedTools: ['skill', 'read'],
			turns: [loadSkill, batchOf('after', 'bash', 'read')],
		})

		expectLoaded(toolResults)
		expect(ran).toEqual(['read'])
		expect(toolResults.join('\n')).toMatch(/Tool "bash" is not available on this step/)
	})

	it('refuses a tool the step withheld through prepareStep', async () => {
		const { ran, toolResults } = await run({
			declared: 'read, bash, write',
			prepareStep: () => ({ activeTools: ['skill', 'read'] }),
			turns: [loadSkill, batchOf('after', 'bash', 'read')],
		})

		expectLoaded(toolResults)
		expect(ran).toEqual(['read'])
		expect(toolResults.join('\n')).toMatch(/Tool "bash" is not available on this step/)
	})
})

describe('a loaded skill cannot change how a call is authorized', () => {
	/** Operator policy: `bash` is forbidden, `skill` and `read` need no review, the rest is asked about. */
	const gate: AuthorizationGateConfig = {
		enabled: true,
		rules: [
			{ type: 'deny_by_name', toolNames: ['bash'] },
			{ type: 'allow_by_name', toolNames: ['skill', 'read'] },
		],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
	}

	async function underGate(turns: readonly MockTurn[]) {
		const reviewed: string[] = []
		const result = await run({
			declared: 'skill, read, bash, write',
			authorizationGate: gate,
			turns,
			resumeHandler: async (request) => {
				if (request.type !== 'tool_review') return { action: 'continue' }
				reviewed.push(...request.toolCalls.map((call) => call.name))
				return { action: 'approve_tools' }
			},
		})
		return { ...result, reviewed }
	}

	it('keeps a denied tool denied after a skill that declares it', async () => {
		const { turn, ran, toolResults, reviewed } = await underGate([
			loadSkill,
			batchOf('after', 'bash'),
		])

		expect(turn.status, JSON.stringify(turn)).toBe('completed')
		expectLoaded(toolResults)
		expect(ran).not.toContain('bash')
		expect(reviewed).not.toContain('bash')
		expect(toolResults.some((result) => /bash/i.test(result) && /den/i.test(result))).toBe(true)
	})

	it('still asks about a call the skill declares, rather than pre-approving it', async () => {
		// `allowed-tools` elsewhere means "pre-approved". Here a loaded skill
		// is content, and content that can approve calls is an escalation
		// surface; the reviewer is asked exactly as without the skill.
		const withSkill = await underGate([loadSkill, batchOf('after', 'write')])
		const withoutSkill = await underGate([batchOf('after', 'write')])

		expectLoaded(withSkill.toolResults)
		expect(withSkill.reviewed).toEqual(['write'])
		expect(withoutSkill.reviewed).toEqual(['write'])
		expect(withSkill.ran).toEqual(['write'])
	})

	it('keeps plan mode refusing a change the skill declares', async () => {
		const { ran, toolResults } = await run({
			declared: 'skill, read, write',
			permissionMode: 'plan',
			turns: [loadSkill, batchOf('after', 'write')],
		})

		expectLoaded(toolResults)
		expect(ran).not.toContain('write')
		expect(toolResults.join('\n')).toMatch(/plan mode/i)
	})
})

/**
 * The invariant itself, through a real `SKILL.md`, the real frontmatter
 * reader and the real registry: whatever a skill declares, the tools the
 * model is offered and the list the executor enforces are identical before
 * and after it loads.
 */
describe('the tool surface is the same before and after a skill loads', () => {
	const fixtures: ReadonlyArray<readonly [string, readonly string[]]> = [
		['the staging declaration', [`allowed-tools: ${STAGING_DECLARATION}`]],
		['a list of real tool names', ['allowed-tools: read']],
		['an empty value', ['allowed-tools: ""']],
		['disallowed-tools', ['disallowed-tools: bash, write']],
		['both keys', ['allowed-tools: read', 'disallowed-tools: bash']],
		['no tool keys at all', []],
	]

	async function surfaceAround(frontmatter: readonly string[], allowedTools?: string[]) {
		const root = await mkdtemp(join(tmpdir(), 'namzu-skill-surface-files-'))
		workdirs.push(root)
		const dir = join(root, 'delivery')
		await mkdir(dir, { recursive: true })
		await writeFile(
			join(dir, 'SKILL.md'),
			[
				'---',
				'name: delivery',
				'description: delivery work',
				...frontmatter,
				'---',
				'Deliver the work.',
				'',
			].join('\n'),
			'utf8',
		)
		const registry = new SkillRegistry()
		await registry.register(dir)

		const ran: string[] = []
		const seen: ToolContext['allowedTools'][] = []
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-surface-'))
		workdirs.push(workingDirectory)
		const provider = new MockLLMProvider({
			turns: [batchOf('before', 'probe'), loadSkill, batchOf('after', 'probe'), { text: 'done' }],
		})
		const turn = await drainQuery({
			provider,
			tools: toolset(ran, seen),
			skillRegistry: registry,
			agentId: 'agent_skill_surface',
			agentName: 'Skill Surface Agent',
			messages: [createUserMessage('deliver the work')],
			workingDirectory,
			turnConfig: {
				model: 'mock-model',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 10,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			...(allowedTools ? { allowedTools } : {}),
		})
		const offered = provider.requests.map((request) =>
			(request.tools ?? []).map((tool) => tool.function.name).sort(),
		)
		const toolResults = provider.requests
			.flatMap((request) => request.messages ?? [])
			.filter((message) => message.role === 'tool')
			.map((message) => String(message.content))
		return { turn, offered, seen, toolResults }
	}

	for (const [label, frontmatter] of fixtures) {
		it.each([
			['an unrestricted turn', undefined],
			['a turn with a list', ['probe', ...DEFAULT_TOOLS]],
		])(`with ${label}, in %s`, async (_scope, allowedTools) => {
			const { turn, offered, seen, toolResults } = await surfaceAround(
				frontmatter,
				allowedTools ? [...allowedTools] : undefined,
			)

			expect(turn.status, JSON.stringify(turn)).toBe('completed')
			expectLoaded(toolResults)
			// Four requests: before, the load, after it, and the answer. Every
			// one offered the same tools, and every tool the turn started with.
			expect(offered).toHaveLength(4)
			for (const request of offered) expect(request).toEqual(offered[0])
			expect(offered[0]).toEqual(
				expect.arrayContaining(['bash', 'write', 'glob', 'verify_outputs']),
			)
			// And the executor enforced the same list on both sides of the load.
			expect(seen).toHaveLength(2)
			expect(seen[1]).toEqual(seen[0])
		})
	}
})
