import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { SkillRegistry } from '../../../skills/registry.js'
import { testToolset } from '../../../test-support/toolset.js'
import { SkillTool } from '../../../tools/builtins/skill.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { type ReviewMode, type ToolReviewPrompt, createReviewHandler } from '../review-policy.js'

/**
 * The owner's report, through the real `query()`: a skill was loaded and the
 * model stopped using `bash`. `allowed-tools` had been read as a restriction.
 *
 * Driven end to end — a SKILL.md on disk, the kernel's skill registry, the
 * shipped review policy — so what is pinned is the wiring as a host gets it:
 * one grant set per turn, filled by the `skill` tool and read by the review.
 */

let dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs = []
})

async function skillsWith(allowedTools: string): Promise<SkillRegistry> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-skill-grant-e2e-'))
	dirs.push(root)
	const dir = join(root, 'helper')
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'SKILL.md'),
		[
			'---',
			'name: helper',
			'description: Helps',
			`allowed-tools: ${allowedTools}`,
			'---',
			'Run the checks.',
		].join('\n'),
	)
	const registry = new SkillRegistry()
	await registry.register(dir)
	return registry
}

function toolsWithBash(ran: string[]): Toolset {
	return testToolset(
		SkillTool,
		defineTool({
			name: 'bash',
			description: 'run a command',
			inputSchema: z.object({ command: z.string() }),
			category: 'shell',
			permissions: ['shell_execute'],
			commandArgument: 'command',
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input: { command: string }) => {
				ran.push(input.command)
				return { success: true, output: `ran ${input.command}` }
			},
		}),

		defineTool({
			name: 'read',
			description: 'read',
			inputSchema: z.object({}),
			category: 'filesystem',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'read' }),
		}),
	)
}

/**
 * One turn: optionally load the skill, then run `command` through bash, or
 * make `call` instead. `seen` collects what the model was shown each step.
 */
function provider(opts: {
	load: boolean
	command: string
	call?: { name: string; args: Record<string, unknown> }
	seen?: string[]
	script?: MockTurn[]
}) {
	return new MockLLMProvider({
		nextTurn(params, index): MockTurn {
			opts.seen?.push(JSON.stringify(params.messages))
			const script: MockTurn[] = opts.script ?? [
				...(opts.load ? [{ toolCalls: [{ name: 'skill', args: { name: 'helper' } }] }] : []),
				{
					toolCalls: [opts.call ?? { name: 'bash', args: { command: opts.command } }],
				},
				{ text: 'done' },
			]
			return script[index] ?? { text: 'done' }
		},
	})
}

async function turn(opts: {
	tools: Toolset
	skills: SkillRegistry
	load: boolean
	command: string
	mode: ReviewMode
	prompt: ToolReviewPrompt
	call?: { name: string; args: Record<string, unknown> }
	seen?: string[]
	script?: MockTurn[]
	extra?: Pick<Parameters<typeof drainQuery>[0], 'inboundMessages' | 'allowedTools'>
}) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-grant-wd-'))
	dirs.push(workingDirectory)
	return drainQuery({
		provider: provider({
			load: opts.load,
			command: opts.command,
			...(opts.call ? { call: opts.call } : {}),
			...(opts.seen ? { seen: opts.seen } : {}),
			...(opts.script ? { script: opts.script } : {}),
		}),
		...opts.extra,
		toolsets: [opts.tools],
		skillRegistry: opts.skills,
		resumeHandler: createReviewHandler({
			mode: opts.mode,
			prompt: opts.prompt,
			registry: new ToolManager({ toolsets: [opts.tools], messages: () => [] }),
		}),
		authorizationGate: {
			enabled: true,
			rules: [],
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 10,
			maxResponseTokens: 256,
		},
		agentId: 'agent_skill_grant',
		agentName: 'Skill Grant Agent',
		workingDirectory,
		sessionId: '5b7a1c2d-3e4f-4a5b-9c6d-7e8f9a0b1c2d' as SessionId,
		topicId: '6c8b2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e' as TopicId,
		projectId: '7d9c3e4f-5a6b-4c7d-9e8f-9a0b1c2d3e4f' as ProjectId,
		tenantId: '8e0d4f5a-6b7c-4d8e-8f9a-0b1c2d3e4f5a' as TenantId,
		messages: [createUserMessage('use the helper skill')],
	})
}

describe('a loaded skill through the real turn', () => {
	it('`allowed-tools: Read Grep` leaves bash callable and still asked about', async () => {
		const ran: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const result = await turn({
			tools: toolsWithBash(ran),
			skills: await skillsWith('Read Grep'),
			load: true,
			command: 'ls -la',
			mode: 'prompt',
			prompt,
		})

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(ran).toEqual(['ls -la'])
		expect(prompt).toHaveBeenCalledOnce()
	})

	it('`Bash(git status *)` runs `git status -s` without asking, for this turn only', async () => {
		const ran: string[] = []
		const tools = toolsWithBash(ran)
		const skills = await skillsWith('Read Bash(git status *)')
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))

		const first = await turn({
			tools,
			skills,
			load: true,
			command: 'git status -s',
			mode: 'prompt',
			prompt,
		})
		expect(first.status, JSON.stringify(first)).toBe('completed')
		expect(ran).toEqual(['git status -s'])
		expect(prompt).not.toHaveBeenCalled()

		// The next message is a new turn; the grant did not survive it.
		const second = await turn({
			tools,
			skills,
			load: false,
			command: 'git status -s',
			mode: 'prompt',
			prompt,
		})
		expect(second.status, JSON.stringify(second)).toBe('completed')
		expect(prompt).toHaveBeenCalledOnce()
	})

	it('plan mode refuses a call the skill pre-approved', async () => {
		const ran: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		await turn({
			tools: toolsWithBash(ran),
			skills: await skillsWith('Bash(git status *)'),
			load: true,
			command: 'git status',
			mode: 'plan',
			prompt,
		})

		expect(ran).toEqual([])
		expect(prompt).not.toHaveBeenCalled()
	})

	it('`Write` grants nothing, and the model is told so, because every write is reviewed', async () => {
		// The shipped `write` is destructive for every input, and a
		// destructive call is never skill-approved. Telling the model "write
		// is pre-approved" and then prompting anyway would be a promise the
		// review never keeps.
		const tools = testToolset(...toolsWithBash([]).tools(), WriteFileTool)
		const seen: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const result = await turn({
			tools,
			skills: await skillsWith('Read Write'),
			load: true,
			command: '',
			call: { name: 'write', args: { path: 'new.txt', content: 'x' } },
			mode: 'prompt',
			prompt,
			seen,
		})

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(prompt).toHaveBeenCalledOnce()
		const afterLoad = seen[1] ?? ''
		expect(afterLoad).toContain('Pre-approved for the rest of this turn: read.')
		expect(afterLoad).toContain('Ignored allowed-tools entry \\"Write\\"')
		expect(afterLoad).toContain('is destructive and is always reviewed')
	})

	it('a message the operator sends during the turn ends the grant', async () => {
		// The TUI hands a message typed mid-turn to the SAME `query()` through
		// `inboundMessages`. It is a new request, and what the skill
		// pre-approved for the old one must not carry over to it.
		const ran: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const bashCall = { toolCalls: [{ name: 'bash', args: { command: 'git status -s' } }] }
		let queued = false
		const result = await turn({
			tools: toolsWithBash(ran),
			skills: await skillsWith('Bash(git status *)'),
			load: true,
			command: 'git status -s',
			mode: 'prompt',
			prompt,
			script: [
				{ toolCalls: [{ name: 'skill', args: { name: 'helper' } }] },
				bashCall,
				bashCall,
				{ text: 'done' },
			],
			extra: {
				inboundMessages: () => {
					if (queued || ran.length !== 1) return []
					queued = true
					return [createUserMessage('now check the other repository')]
				},
			},
		})

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(ran).toEqual(['git status -s', 'git status -s'])
		// The first call rode on the grant; the one after the new message was asked about.
		expect(prompt).toHaveBeenCalledOnce()
	})

	it('a pattern grant does not cover a line that redirects into a file', async () => {
		const ran: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const result = await turn({
			tools: toolsWithBash(ran),
			skills: await skillsWith('Bash(git status *)'),
			load: true,
			command: 'git status > ~/.bashrc',
			mode: 'prompt',
			prompt,
		})

		expect(result.status, JSON.stringify(result)).toBe('completed')
		expect(prompt).toHaveBeenCalledOnce()
	})

	it('a tool the turn withholds is reported as unavailable, not pre-approved', async () => {
		const seen: string[] = []
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		await turn({
			tools: toolsWithBash([]),
			skills: await skillsWith('Read Bash'),
			load: true,
			command: '',
			call: { name: 'read', args: {} },
			mode: 'prompt',
			prompt,
			seen,
			extra: { allowedTools: ['skill', 'read'] },
		})

		const afterLoad = seen[1] ?? ''
		expect(afterLoad).toContain('Pre-approved for the rest of this turn: read.')
		expect(afterLoad).toContain('Ignored allowed-tools entry \\"Bash\\"')
		expect(afterLoad).toContain('is not available in this turn')
	})
})
