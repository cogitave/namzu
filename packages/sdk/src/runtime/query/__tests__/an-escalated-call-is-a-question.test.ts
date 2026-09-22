import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { BashTool, SANDBOX_ESCAPE_NOT_APPROVED } from '../../../tools/builtins/bash.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import type { AuthorizationRule } from '../../../types/authorization/index.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { Sandbox, SandboxProvider } from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import {
	OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
	SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * Two boundaries a turn can be asked to cross, each turned from a refusal
 * into a question — and each question answerable only by what it names:
 *
 * - a file tool's path outside the working directory, on a turn with no
 *   sandbox and `outsideRootAccess: 'review'`;
 * - a shell command outside the sandbox, on a sandboxed turn with
 *   `sandboxEscape: 'review'`, which only a confirmation BY ID releases.
 *
 * Run through `query()`, because the guarantee is the composition: the
 * executor finds the escalation, the review phase refuses to let a rule, a
 * grant or a blanket approval answer it, and the tool is handed exactly
 * what was approved.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function layout() {
	const base = await mkdtemp(join(tmpdir(), 'namzu-escalation-'))
	dirs.push(base)
	const cwd = join(base, 'project')
	const outside = join(base, 'outside')
	await mkdir(cwd)
	await mkdir(outside)
	const file = join(outside, 'notes.txt')
	await writeFile(file, 'OUTSIDE_CONTENT')
	return { cwd, file, outside }
}

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

function toolTexts(messages: readonly Message[]): string[] {
	return messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
}

async function auditOf(log: InMemorySessionLog) {
	const read = await log.readAll()
	return read.entries
		.map((entry) => entry.record as unknown as Record<string, unknown>)
		.filter((record) => record.type === 'audit')
}

async function readOutside(input: {
	/** Given the registry, so the shipped exemption (read-only is not asked about) is in force. */
	readonly resumeHandler: (tools: ToolRegistry) => ResumeHandler
	readonly outsideRootAccess?: 'refuse' | 'review'
	readonly rules?: AuthorizationRule[]
}) {
	const { cwd, file } = await layout()
	const tools = new ToolRegistry()
	tools.register(ReadFileTool)
	const call: MockTurn = {
		toolCalls: [{ id: 'r1', name: 'read', args: { path: file } }],
		finishReason: 'tool_calls',
	}
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		tools,
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('read it')],
		workingDirectory: cwd,
		...(input.outsideRootAccess ? { outsideRootAccess: input.outsideRootAccess } : {}),
		...(input.rules
			? {
					authorizationGate: {
						enabled: true,
						allowReadOnlyTools: true,
						denyDangerousPatterns: true,
						logDecisions: false,
						rules: input.rules,
					},
				}
			: {}),
		resumeHandler: input.resumeHandler(tools),
		sessionId,
		sessionLog,
		...ids,
	} as QueryParams)
	return { texts: toolTexts(result.messages), file, audit: await auditOf(sessionLog) }
}

describe('a path outside the working directory, on a host turn', () => {
	it('is asked about rather than refused, and read once approved', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts, file, audit } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		// `read` is read-only and review-exempt; it was asked about anyway,
		// and the request named the path it reaches.
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual({ outsidePaths: [file] })
		expect(texts.join('\n')).toContain('OUTSIDE_CONTENT')
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'outside_root_access',
				tool: 'read',
				resource: file,
				outcome: 'approved',
			}),
		)
	})

	it('is not read when the person declines', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const { texts } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
	})

	it('is still asked about where an allow rule covers the tool', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const { texts } = await readOutside({
			outsideRootAccess: 'review',
			rules: [{ type: 'allow_by_name', toolNames: ['read'] }],
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
	})

	it('is refused by a deny rule without anyone being asked', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts } = await readOutside({
			outsideRootAccess: 'review',
			rules: [{ type: 'deny_by_name', toolNames: ['read'] }],
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(texts.join('\n')).toMatch(/Blocked by the authorization gate/)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
	})

	it('is written, as a new file, once approved', async () => {
		// The approved path becomes a root of its own for that call; for a file
		// that does not exist yet, that root does not exist either, and the
		// containment check has to canonicalize it rather than refuse it.
		const { cwd, outside } = await layout()
		const target = join(outside, 'created.txt')
		const tools = new ToolRegistry()
		tools.register(WriteFileTool)
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const sessionId = generateSessionId()
		const sessionLog = new InMemorySessionLog({ sessionId })
		const result = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'w1', name: 'write', args: { path: target, content: 'NEW_FILE' } }],
						finishReason: 'tool_calls',
					},
					{ text: 'done' },
				],
			}),
			tools,
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('write it')],
			workingDirectory: cwd,
			outsideRootAccess: 'review',
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt, registry: tools }),
			sessionId,
			sessionLog,
			...ids,
		} as QueryParams)

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual({ outsidePaths: [target] })
		expect(toolTexts(result.messages).join('\n')).not.toMatch(/escapes the working directory/)
		expect(await readFile(target, 'utf8')).toBe('NEW_FILE')
	})

	it('is refused, and recorded as refused, when the person declines', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const { file, audit } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'outside_root_access',
				tool: 'read',
				resource: file,
				outcome: 'refused',
			}),
		)
		expect(audit.some((r) => r.outcome === 'approved')).toBe(false)
	})

	it('is refused, not approved, by auto mode with nobody to ask', async () => {
		const { texts, file, audit } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'auto', registry }),
		})

		expect(texts.join('\n')).toContain(OUTSIDE_ROOTS_UNATTENDED_REFUSAL)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'outside_root_access',
				resource: file,
				outcome: 'refused',
			}),
		)
	})

	it('is asked about under auto mode and a remembered approve-all when a person is there', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const { texts } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) =>
				createReviewHandler({ mode: 'auto', prompt, registry, remembered: { all: true } }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
	})

	it('stays a refusal, naming the way to widen it, when the turn did not ask for review', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts } = await readOutside({
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(prompt).not.toHaveBeenCalled()
		const [text] = texts
		expect(text).toMatch(/escapes the working directory/)
		expect(text).toMatch(/add the directory to the session/)
		expect(text).not.toMatch(/may only reach/)
	})
})

function fakeSandbox(): Sandbox {
	return {
		id: '51281012-1dd1-444d-98b8-487422669dff' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: 'SANDBOX_RAN',
			stderr: '',
			timedOut: false,
		})),
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.alloc(0)),
		listFiles: vi.fn(async () => []),
		destroy: vi.fn(async () => {}),
	} as unknown as Sandbox
}

async function escapeThroughQuery(input: {
	readonly resumeHandler: ResumeHandler
	readonly sandboxEscape?: 'refuse' | 'review'
}) {
	const base = await mkdtemp(join(tmpdir(), 'namzu-escape-'))
	dirs.push(base)
	const sandbox = fakeSandbox()
	const tools = new ToolRegistry()
	tools.register(BashTool)
	const call: MockTurn = {
		toolCalls: [
			{
				id: 'b1',
				name: 'bash',
				args: { command: 'printf HOST_RAN', dangerously_disable_sandbox: true },
			},
		],
		finishReason: 'tool_calls',
	}
	const sessionId = generateSessionId()
	const sessionLog = new InMemorySessionLog({ sessionId })
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		tools,
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('run it')],
		workingDirectory: base,
		...(input.sandboxEscape ? { sandboxEscape: input.sandboxEscape } : {}),
		sandboxProvider: {
			id: 'sandbox-test',
			name: 'Sandbox test',
			environment: 'basic',
			create: async () => sandbox,
		} satisfies SandboxProvider,
		resumeHandler: input.resumeHandler,
		sessionId: sessionId as SessionId,
		sessionLog,
		...ids,
	} as QueryParams)
	return {
		text: toolTexts(result.messages).join('\n'),
		sandbox,
		audit: await auditOf(sessionLog),
	}
}

describe('a command outside the sandbox', () => {
	it('is never approved by auto mode with nobody to ask: the batch is refused', async () => {
		const { text, sandbox, audit } = await escapeThroughQuery({
			sandboxEscape: 'review',
			resumeHandler: createReviewHandler({ mode: 'auto' }),
		})

		expect(text).toContain(SANDBOX_ESCAPE_UNATTENDED_REFUSAL)
		expect(text).not.toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
		expect(audit.some((r) => r.outcome === 'approved')).toBe(false)
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'sandbox_escape',
				tool: 'bash',
				outcome: 'refused',
				reason: SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
			}),
		)
	})

	it('is recorded as refused when the person answers no', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'not now' }))
		const { text, sandbox, audit } = await escapeThroughQuery({
			sandboxEscape: 'review',
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(text).not.toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'sandbox_escape',
				tool: 'bash',
				outcome: 'refused',
				reason: 'not now',
			}),
		)
	})

	it('is asked about under auto mode and a remembered approve-all when a person is there', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text, sandbox, audit } = await escapeThroughQuery({
			sandboxEscape: 'review',
			resumeHandler: createReviewHandler({ mode: 'auto', prompt, remembered: { all: true } }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual({ sandboxEscape: true })
		expect(text).toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
		expect(audit).toContainEqual(
			expect.objectContaining({ action: 'sandbox_escape', tool: 'bash', outcome: 'approved' }),
		)
	})

	it('is refused when a policy approves the batch without confirming the escape by id', async () => {
		const blanket: ResumeHandler = async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' }
		const { text, sandbox, audit } = await escapeThroughQuery({
			sandboxEscape: 'review',
			resumeHandler: blanket,
		})

		expect(text).toMatch(/needs a person to confirm it for this call/)
		expect(text).not.toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
		expect(audit).toContainEqual(
			expect.objectContaining({ action: 'sandbox_escape', tool: 'bash', outcome: 'refused' }),
		)
	})

	it('runs unasked only where the operator allowed unattended escapes', async () => {
		const { text } = await escapeThroughQuery({
			sandboxEscape: 'review',
			resumeHandler: createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' }),
		})

		expect(text).toContain('HOST_RAN')
	})

	it('is refused by the tool itself on a turn that does not allow escapes', async () => {
		const blanket: ResumeHandler = async (request) =>
			request.type === 'tool_review'
				? { action: 'approve_tools', confirmedEscalations: ['b1'] }
				: { action: 'continue' }
		const { text, sandbox } = await escapeThroughQuery({ resumeHandler: blanket })

		expect(text).toContain(SANDBOX_ESCAPE_NOT_APPROVED)
		expect(text).not.toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
	})
})

describe('an "approve all" given for ordinary calls', () => {
	it('never covers a later path outside the working directory', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve-all' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, exempt: (n) => n === 'read' })
		const request = { type: 'tool_review', checkpointId: 'c' } as const

		expect(
			await handler({
				...request,
				toolCalls: [{ id: '1', name: 'bash', input: { command: 'ls' }, isDestructive: false }],
			} as never),
		).toEqual({ action: 'approve_tools' })
		// Ordinary calls after it go through unasked...
		await handler({
			...request,
			toolCalls: [{ id: '2', name: 'bash', input: { command: 'pwd' }, isDestructive: false }],
		} as never)
		expect(prompt).toHaveBeenCalledTimes(1)
		// ...a path outside does not.
		prompt.mockResolvedValueOnce({ kind: 'reject', feedback: 'no' })
		const outside = await handler({
			...request,
			toolCalls: [
				{
					id: '3',
					name: 'read',
					input: { path: '/home/someone/.ssh/id_rsa' },
					isDestructive: false,
					escalation: { outsidePaths: ['/home/someone/.ssh/id_rsa'] },
				},
			],
		} as never)
		expect(prompt).toHaveBeenCalledTimes(2)
		expect(outside).toMatchObject({ action: 'reject_tools' })
	})
})
