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
	PLAN_MODE_REFUSAL,
	SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
	STRICT_MODE_REFUSAL,
	type ToolReviewPrompt,
	UNKNOWN_PROGRAM_UNATTENDED_REFUSAL,
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

	it('is refused by a deny rule without anyone being asked, and recorded as refused', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts, file, audit } = await readOutside({
			outsideRootAccess: 'review',
			rules: [{ type: 'deny_by_name', toolNames: ['read'] }],
			resumeHandler: (registry) => createReviewHandler({ mode: 'prompt', prompt, registry }),
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(texts.join('\n')).toMatch(/Blocked by the authorization gate/)
		expect(texts.join('\n')).not.toContain('OUTSIDE_CONTENT')
		// Refused by a rule is still a crossing asked about and refused: the
		// all-denied batch records it like the mixed and reviewed ones do.
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'outside_root_access',
				tool: 'read',
				resource: file,
				outcome: 'refused',
				reason: expect.stringMatching(/Blocked by the authorization gate/),
			}),
		)
	})

	it('is asked about in plan mode, which is for reading, and read once approved', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts, file, audit } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'plan', prompt, registry }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(texts.join('\n')).not.toContain(PLAN_MODE_REFUSAL)
		expect(texts.join('\n')).toContain('OUTSIDE_CONTENT')
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'outside_root_access',
				resource: file,
				outcome: 'approved',
			}),
		)
	})

	it('is refused, unasked, in strict mode, which no rule can open to it', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { texts } = await readOutside({
			outsideRootAccess: 'review',
			resumeHandler: (registry) => createReviewHandler({ mode: 'strict', prompt, registry }),
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(texts.join('\n')).toContain(STRICT_MODE_REFUSAL)
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

	it('is refused as a change, unasked, in plan mode when the call writes', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'plan', prompt, exempt: (n) => n === 'read' })
		const decision = await handler({
			type: 'tool_review',
			checkpointId: 'c',
			toolCalls: [
				{
					id: 'w1',
					name: 'write',
					input: { path: '/mnt/c/Users/x.txt', content: 'x' },
					isDestructive: false,
					escalation: { outsidePaths: ['/mnt/c/Users/x.txt'] },
				},
				{
					id: 'r1',
					name: 'read',
					input: { path: '/mnt/c/Users/y.txt' },
					isDestructive: false,
					escalation: { outsidePaths: ['/mnt/c/Users/y.txt'] },
				},
			],
		} as never)

		expect(prompt).not.toHaveBeenCalled()
		expect(decision).toEqual({ action: 'reject_tools', feedback: PLAN_MODE_REFUSAL })
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
	readonly rules?: AuthorizationRule[]
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
		...(input.rules
			? {
					authorizationGate: {
						enabled: true,
						allowReadOnlyTools: false,
						denyDangerousPatterns: false,
						logDecisions: false,
						rules: input.rules,
					},
				}
			: {}),
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

	it('is refused by a deny rule without anyone being asked, and recorded as refused', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text, sandbox, audit } = await escapeThroughQuery({
			sandboxEscape: 'review',
			rules: [{ type: 'deny_by_name', toolNames: ['bash'] }],
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt }),
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(text).toMatch(/Blocked by the authorization gate/)
		expect(text).not.toContain('HOST_RAN')
		expect(sandbox.exec).not.toHaveBeenCalled()
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'sandbox_escape',
				tool: 'bash',
				outcome: 'refused',
				reason: expect.stringMatching(/Blocked by the authorization gate/),
			}),
		)
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

/**
 * A security review of the command-substitution fix (668557ae) found that a
 * `deny` rule written against a command's real name (`"git push*": deny`)
 * never sees one produced by a substitution or a variable
 * (`$(echo git) push`), since the name never appears as such anywhere in
 * the call's text. The kernel now escalates any bash call whose lexed
 * command's own program-name word expands, the same unconditional lane a
 * sandbox escape already gets: no allow rule, remembered grant or
 * `auto`/unattended mode approves it, and a `deny` rule still refuses it
 * outright.
 */
async function unknownProgramThroughQuery(input: {
	readonly command: string
	readonly resumeHandler: ResumeHandler
	readonly rules?: AuthorizationRule[]
}) {
	const base = await mkdtemp(join(tmpdir(), 'namzu-unknown-program-'))
	dirs.push(base)
	const tools = new ToolRegistry()
	tools.register(BashTool)
	const call: MockTurn = {
		toolCalls: [{ id: 'b1', name: 'bash', args: { command: input.command } }],
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
		...(input.rules
			? {
					authorizationGate: {
						enabled: true,
						allowReadOnlyTools: false,
						denyDangerousPatterns: false,
						logDecisions: false,
						rules: input.rules,
					},
				}
			: {}),
		resumeHandler: input.resumeHandler,
		sessionId: sessionId as SessionId,
		sessionLog,
		...ids,
	} as QueryParams)
	return { text: toolTexts(result.messages).join('\n'), audit: await auditOf(sessionLog) }
}

describe('a command whose own program name is decided at runtime', () => {
	it('is never approved by auto mode with nobody to ask: the batch is refused', async () => {
		const { text, audit } = await unknownProgramThroughQuery({
			command: '$(echo echo) HOST_RAN',
			resumeHandler: createReviewHandler({ mode: 'auto' }),
		})

		expect(text).toContain(UNKNOWN_PROGRAM_UNATTENDED_REFUSAL)
		expect(text).not.toContain('HOST_RAN')
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'unknown_program',
				tool: 'bash',
				outcome: 'refused',
				reason: UNKNOWN_PROGRAM_UNATTENDED_REFUSAL,
			}),
		)
	})

	it('is not approved by an allow rule covering the tool, and asks instead', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text, audit } = await unknownProgramThroughQuery({
			command: '$(echo echo) HOST_RAN',
			rules: [{ type: 'allow_by_name', toolNames: ['bash'] }],
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.unknownProgram).toMatch(
			/decided at runtime: \$\(echo echo\)/,
		)
		expect(text).toContain('HOST_RAN')
		expect(audit).toContainEqual(
			expect.objectContaining({ action: 'unknown_program', tool: 'bash', outcome: 'approved' }),
		)
	})

	it('is refused by a deny rule without anyone being asked, even though the pattern never sees the real name', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text, audit } = await unknownProgramThroughQuery({
			command: '$(echo echo) HOST_RAN',
			rules: [{ type: 'deny_by_name', toolNames: ['bash'] }],
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt }),
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(text).toMatch(/Blocked by the authorization gate/)
		expect(text).not.toContain('HOST_RAN')
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'unknown_program',
				tool: 'bash',
				outcome: 'refused',
				reason: expect.stringMatching(/Blocked by the authorization gate/),
			}),
		)
	})

	it('is asked about, names why, and runs once a person approves', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text } = await unknownProgramThroughQuery({
			command: '$(echo echo) HOST_RAN',
			resumeHandler: createReviewHandler({ mode: 'prompt', prompt }),
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(text).toContain('HOST_RAN')
	})

	it('is not escalated by an ordinary, argument-level expansion — only the program name', async () => {
		// Argument-level expansion alone must not flood reviews: `echo` is
		// literal, `$(date)` is only an argument.
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const { text } = await unknownProgramThroughQuery({
			command: 'echo $(date)',
			rules: [{ type: 'allow_by_name', toolNames: ['bash'] }],
			resumeHandler: createReviewHandler({ mode: 'auto', prompt }),
		})

		// Allowed by the rule, approved by auto, never asked: no escalation.
		expect(prompt).not.toHaveBeenCalled()
		expect(text).not.toContain(UNKNOWN_PROGRAM_UNATTENDED_REFUSAL)
	})

	it('treats a literal program name as ordinary, whatever its arguments do', async () => {
		const { text } = await unknownProgramThroughQuery({
			command: 'echo HOST_RAN',
			resumeHandler: createReviewHandler({ mode: 'auto' }),
		})

		expect(text).toContain('HOST_RAN')
	})

	// A second review found the escalation only ever looked at the lexed
	// command's literal head word, so a re-exec wrapper with its own
	// mandatory argument (`env VAR=value`, `nice -n 10`, `timeout 5`) or a
	// chain of several put the real program one or more words past the
	// head and slipped through unescalated. `resolveScriptPrograms`
	// (`packages/sdk/src/authorization/program.ts`) unwraps the wrapper
	// with its real option grammar instead of assuming the program sits
	// right after the wrapper's own name.
	it.each([
		['env $(echo echo) HOST_RAN', 'env, no leading assignment'],
		['env NODE_ENV=production $(echo echo) HOST_RAN', 'env with a VAR=value pair first'],
		['nice -n 10 $(echo echo) HOST_RAN', 'nice with -n VALUE'],
		['timeout 5 $(echo echo) HOST_RAN', 'timeout, whose duration is mandatory'],
		['command $(echo echo) HOST_RAN', 'the `command` builtin'],
		['exec $(echo echo) HOST_RAN', 'the `exec` builtin'],
		['sudo env nice -n 5 $(echo echo) HOST_RAN', 'a chain of three wrappers'],
	])('is escalated behind a re-exec wrapper: %s (%s)', async (command) => {
		const { text } = await unknownProgramThroughQuery({
			command,
			resumeHandler: createReviewHandler({ mode: 'auto' }),
		})

		expect(text).toContain(UNKNOWN_PROGRAM_UNATTENDED_REFUSAL)
		expect(text).not.toContain('HOST_RAN')
	})

	it('is escalated for eval, source and the dot builtin, which run text as code, not a program by name', async () => {
		for (const command of [
			'eval "$(echo echo HOST_RAN)"',
			'source /tmp/does-not-exist-either-way.sh',
		]) {
			const { text } = await unknownProgramThroughQuery({
				command,
				resumeHandler: createReviewHandler({ mode: 'auto' }),
			})
			expect(text, command).toContain(UNKNOWN_PROGRAM_UNATTENDED_REFUSAL)
			expect(text, command).not.toContain('HOST_RAN')
		}
	})

	it('is escalated once an earlier command in the same call poisons PATH for the rest', async () => {
		const { text } = await unknownProgramThroughQuery({
			command: 'export PATH=$(echo /tmp/evil); echo HOST_RAN',
			resumeHandler: createReviewHandler({ mode: 'auto' }),
		})

		expect(text).toContain(UNKNOWN_PROGRAM_UNATTENDED_REFUSAL)
		expect(text).not.toContain('HOST_RAN')
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
