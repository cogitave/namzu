import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../../../authorization/gate.js'
import { SkillGrantSet } from '../../../../authorization/skill-grant.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import { SkillTool } from '../../../../tools/builtins/skill.js'
import { WriteFileTool } from '../../../../tools/builtins/write-file.js'
import type { AuthorizationGateConfig } from '../../../../types/authorization/index.js'
import type { HITLDecisionRequest, ResumeHandler } from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import { PLAN_MODE_REFUSAL } from '../../../../types/permission/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type {
	SkillRegistryRef,
	ToolContext,
	ToolDefinition,
	ToolRegistryContract,
} from '../../../../types/tool/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import {
	type ReviewMode,
	STRICT_MODE_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../../review-policy.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * A loaded skill's `allowed-tools`, end to end through a turn's review.
 *
 * The owner's report: a skill was loaded, and the model stopped using `bash`
 * and tried to do everything through what the skill described. The field was
 * read as a restriction. These pin what it is instead — a pre-approval for
 * the rest of the turn that never removes a tool, never outranks the
 * operator, and never outlives the turn.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = 'a4f0c1de-2b3c-4d5e-8f60-718293a4b5c6' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

function fakeTool(name: string, readOnly: boolean, extra: Partial<ToolDefinition> = {}) {
	return {
		name,
		category: readOnly ? 'filesystem' : 'shell',
		isReadOnly: () => readOnly,
		isDestructive: () => false,
		isConcurrencySafe: () => readOnly,
		...extra,
	} as unknown as ToolDefinition
}

const DEFINITIONS: Record<string, ToolDefinition> = {
	skill: SkillTool as unknown as ToolDefinition,
	bash: fakeTool('bash', false, { commandArgument: 'command' }),
	read: fakeTool('read', true),
	grep: fakeTool('grep', true),
	// The shipped tool, not a fake: `write` is destructive for every input,
	// which is exactly what makes a skill's `Write` grant nothing.
	write: WriteFileTool as unknown as ToolDefinition,
}

const SKILLS: Record<string, { allowedTools: string; dirPath: string }> = {
	// The owner's shape: two read tools, bash not mentioned.
	reader: { allowedTools: 'Read Grep', dirPath: '/skills/reader' },
	'git-status': {
		allowedTools: 'Read Bash(git status *)',
		dirPath: '/skills/git-status',
	},
}

function skillRegistry(): SkillRegistryRef {
	return {
		async load(name) {
			const found = SKILLS[name]
			if (!found) return undefined
			return {
				skill: {
					metadata: {
						name,
						description: 'd',
						allowedTools: found.allowedTools,
					},
					body: `Instructions for ${name}.`,
					dirPath: found.dirPath,
				},
			}
		},
		names: () => Object.keys(SKILLS),
	}
}

const gateConfig = (partial: Partial<AuthorizationGateConfig> = {}): AuthorizationGateConfig => ({
	enabled: true,
	rules: [],
	allowReadOnlyTools: true,
	denyDangerousPatterns: true,
	logDecisions: false,
	...partial,
})

interface Turn {
	ctx: IterationContext
	executed: {
		name: string
		input: unknown
		allowedTools?: readonly string[]
	}[]
	messages: Message[]
	seen: HITLDecisionRequest[]
	audits: unknown[]
	grants: SkillGrantSet
}

/** One turn: its own executor and its own grant set, as `query()` builds them. */
function turn(opts: {
	handler: ResumeHandler
	gate?: AuthorizationGateConfig
}): Turn {
	const executed: Turn['executed'] = []
	const messages: Message[] = []
	const seen: HITLDecisionRequest[] = []
	const audits: unknown[] = []
	const log = makeLogger()
	const grants = new SkillGrantSet()
	const tools = {
		get: vi.fn((name: string) => DEFINITIONS[name]),
		execute: vi.fn(async (name: string, input: unknown, context: ToolContext) => {
			executed.push({
				name,
				input,
				...(context.allowedTools ? { allowedTools: context.allowedTools } : {}),
			})
			if (name === 'skill') return SkillTool.execute(input as { name: string }, context)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn((name: string) => name in DEFINITIONS),
		listNames: vi.fn(() => Object.keys(DEFINITIONS)),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract
	const toolExecutor = new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			skills: skillRegistry(),
			skillGrants: grants,
		},
		new ActivityStore(TURN_ID, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		}),
		async () => {},
		log,
	)
	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: new AbortController(),
		recorder: {
			id: TURN_ID,
			messages,
			pushMessage: (m: Message) => {
				messages.push(m)
			},
			setStopReason: vi.fn(),
			markCancelled: vi.fn(),
			recordAudit: vi.fn(async (entry: unknown) => {
				audits.push(entry)
			}),
		},
		checkpointMgr: {
			create: async () => ({ id: '4d1c2b3a-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }),
		},
		emitEvent: async () => {},
		drainPending: async function* () {},
		resumeHandler: async (request: HITLDecisionRequest) => {
			seen.push(request)
			return opts.handler(request)
		},
		verificationGate: new AuthorizationGate(opts.gate ?? gateConfig(), log),
		skillGrants: grants,
	} as unknown as IterationContext
	return { ctx, executed, messages, seen, audits, grants }
}

let callSeq = 0
function response(...calls: { name: string; input: unknown }[]): ChatCompletionResponse {
	return {
		id: `resp_${callSeq}`,
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: calls.map((c) => ({
				id: `call_${++callSeq}`,
				type: 'function' as const,
				function: { name: c.name, arguments: JSON.stringify(c.input) },
			})),
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

async function run(t: Turn, resp: ChatCompletionResponse) {
	const gen = runToolReview(t.ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

const loadSkill = (name: string) => response({ name: 'skill', input: { name } })
const bash = (command: string) => response({ name: 'bash', input: { command } })

function policy(mode: ReviewMode, skillGrants?: 'honour' | 'ignore') {
	const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
	const handler = createReviewHandler({
		mode,
		prompt,
		registry: { get: (name: string) => DEFINITIONS[name] },
		...(skillGrants ? { skillGrants } : {}),
	})
	return { prompt, handler }
}

const lastText = (t: Turn) => t.messages.map((m) => String(m.content)).join('\n')

describe("the owner's scenario: a skill with `allowed-tools: Read Grep`", () => {
	it('leaves bash callable and reviewed exactly as before', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })

		expect(await run(t, loadSkill('reader'))).toBe('executed')
		expect(lastText(t)).toContain('Pre-approved for the rest of this turn: read, grep')
		expect(lastText(t)).toContain('Every other tool remains available')
		expect(prompt).not.toHaveBeenCalled()

		expect(await run(t, bash('ls -la'))).toBe('executed')

		// Still reviewed: a person was asked, as for any bash call.
		expect(prompt).toHaveBeenCalledTimes(1)
		const asked = t.seen.at(-1)
		expect(asked?.type === 'tool_review' && asked.toolCalls[0]?.skillGrant).toBeUndefined()
		// And not narrowed: the call ran under the turn's unrestricted list.
		const ran = t.executed.find((e) => e.name === 'bash')
		expect(ran).toBeDefined()
		expect(ran?.allowedTools).toBeUndefined()
	})
})

describe('Bash(git status *) pre-approves exactly that', () => {
	it('runs `git status -s` without a prompt, and records who granted it', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		expect(await run(t, bash('git status -s'))).toBe('executed')

		expect(prompt).not.toHaveBeenCalled()
		expect(t.executed.map((e) => e.name)).toContain('bash')
		expect(t.audits).toContainEqual({
			what: { action: 'tool_call', tool: 'bash' },
			outcome: 'approved',
			reason:
				'pre-approved by the allowed-tools of skill "git-status" for this turn; nobody was asked',
		})
	})

	it("asks anyway under a policy set to ignore skills' grants", async () => {
		const { prompt, handler } = policy('prompt', 'ignore')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		await run(t, bash('git status -s'))

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('still asks about `git push`', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		await run(t, bash('git push'))

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('asks about a batch where one call is covered and one is not', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		await run(
			t,
			response(
				{ name: 'bash', input: { command: 'git status' } },
				{ name: 'write', input: { path: 'a', content: 'b' } },
			),
		)

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('pre-approves nothing in the batch that loaded the skill', async () => {
		// That batch was reviewed before the skill was read.
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })

		await run(
			t,
			response(
				{ name: 'skill', input: { name: 'git-status' } },
				{ name: 'bash', input: { command: 'git status' } },
			),
		)

		expect(prompt).toHaveBeenCalledTimes(1)
	})
})

describe('what outranks a skill', () => {
	it('an operator deny rule', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({
			handler,
			gate: gateConfig({
				rules: [
					{
						type: 'argument_pattern',
						toolNames: ['bash'],
						argument: 'command',
						pattern: 'git status',
						decision: 'deny',
					},
				],
			}),
		})
		await run(t, loadSkill('git-status'))

		expect(await run(t, bash('git status -s'))).toBe('rejected')

		expect(t.executed.map((e) => e.name)).not.toContain('bash')
		expect(prompt).not.toHaveBeenCalled()
		expect(lastText(t)).toContain('Blocked by the authorization gate')
	})

	it('an operator ask rule', async () => {
		const { prompt, handler } = policy('prompt')
		const t = turn({
			handler,
			gate: gateConfig({
				rules: [
					{
						type: 'custom_pattern',
						pattern: '^bash$',
						target: 'name',
						decision: 'review',
					},
				],
			}),
		})
		await run(t, loadSkill('git-status'))

		await run(t, bash('git status'))

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('plan mode', async () => {
		const { prompt, handler } = policy('plan')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		expect(await run(t, bash('git status'))).toBe('rejected')

		expect(t.executed.map((e) => e.name)).not.toContain('bash')
		expect(prompt).not.toHaveBeenCalled()
		expect(lastText(t)).toContain(PLAN_MODE_REFUSAL)
	})

	it('strict mode', async () => {
		const { handler } = policy('strict')
		const t = turn({ handler })
		await run(t, loadSkill('git-status'))

		expect(await run(t, bash('git status'))).toBe('rejected')

		expect(t.executed.map((e) => e.name)).not.toContain('bash')
		expect(lastText(t)).toContain(STRICT_MODE_REFUSAL)
	})
})

describe('how long a grant lives, and who holds it', () => {
	it('ends with the turn: the next turn asks again', async () => {
		// `query()` builds one set per turn; a new turn is a new set.
		const { prompt, handler } = policy('prompt')
		const first = turn({ handler })
		await run(first, loadSkill('git-status'))
		await run(first, bash('git status'))
		expect(prompt).not.toHaveBeenCalled()

		const next = turn({ handler })
		await run(next, bash('git status'))

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(next.grants.size).toBe(0)
	})

	it('is not inherited by a delegated turn, even one borrowing the same handler', async () => {
		// A child runs its own turn with its own set. The handler the parent
		// lends it approves only calls the CHILD's review marked.
		const { prompt, handler } = policy('prompt')
		const parent = turn({ handler })
		await run(parent, loadSkill('git-status'))

		const child = turn({ handler })
		await run(child, bash('git status'))

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('comes only from a skill the host loaded: an unregistered skill grants nothing', async () => {
		// The CLI loads project skills only in a folder the operator trusted;
		// a skill the host never registered cannot be loaded, so it cannot
		// grant. Stands in for an untrusted folder's `.namzu/skills`.
		const { prompt, handler } = policy('prompt')
		const t = turn({ handler })

		await run(t, loadSkill('from-an-untrusted-folder'))
		expect(lastText(t)).toContain('No skill named "from-an-untrusted-folder"')
		expect(t.grants.size).toBe(0)

		await run(t, bash('git status'))
		expect(prompt).toHaveBeenCalledTimes(1)
	})
})
