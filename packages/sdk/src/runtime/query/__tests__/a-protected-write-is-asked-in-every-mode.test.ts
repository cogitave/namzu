import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { forgetCarriedDirectories, recordDirectory } from '../../../tools/builtins/bash-cwd.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { AuthorizationRule } from '../../../types/authorization/index.js'
import type { TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import {
	DANGEROUS_REMOVAL_UNATTENDED_REFUSAL,
	OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
	PROTECTED_PATH_UNATTENDED_REFUSAL,
	type ReviewMode,
	STRICT_MODE_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * Two floors and one boundary, through `query()`:
 *
 * - a write to a protected path (a git hook, a shell rc file, editor or tool
 *   configuration, the project's `.namzu`) is a question in every mode, `auto`
 *   and a rule that allows the tool included, and a refusal with nobody to ask;
 * - a shell line that removes something catastrophic is the same, whatever
 *   order its flags are in;
 * - a shell line that names a path outside the roots is the existing outside
 *   boundary, now that the line's paths are read.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
	forgetCarriedDirectories()
})

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

function toolTexts(messages: readonly Message[]): string {
	return messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
		.join('\n')
}

async function project() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-floor-'))
	dirs.push(cwd)
	await mkdir(join(cwd, '.git', 'hooks'), { recursive: true })
	await mkdir(join(cwd, 'src'), { recursive: true })
	return cwd
}

async function runCall(input: {
	readonly tool: 'write' | 'bash'
	readonly args: Record<string, unknown>
	readonly mode: ReviewMode
	readonly prompt?: ToolReviewPrompt
	readonly rules?: AuthorizationRule[]
	readonly denyDangerousPatterns?: boolean
	readonly outsideRootAccess?: 'review'
	readonly cwd?: string
	readonly carriedDirectory?: string
	readonly extraCalls?: readonly {
		id: string
		name: 'bash' | 'write'
		args: Record<string, unknown>
	}[]
}) {
	const cwd = input.cwd ?? (await project())
	const tools = testToolset(input.tool === 'write' ? WriteFileTool : BashTool)
	const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
	const call: MockTurn = {
		toolCalls: [{ id: 'c1', name: input.tool, args: input.args }, ...(input.extraCalls ?? [])],
		finishReason: 'tool_calls',
	}
	const sessionId = generateSessionId()
	if (input.carriedDirectory) {
		const capture = join(cwd, 'cwd-capture')
		await writeFile(capture, input.carriedDirectory)
		await recordDirectory(sessionId, capture, { workingDirectory: cwd })
	}
	const sessionLog = new InMemorySessionLog({ sessionId })
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		toolsets: [tools],
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 4,
		},
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('do it')],
		workingDirectory: cwd,
		...(input.outsideRootAccess ? { outsideRootAccess: input.outsideRootAccess } : {}),
		...(input.rules || input.denyDangerousPatterns
			? {
					authorizationGate: {
						enabled: true,
						allowReadOnlyTools: false,
						denyDangerousPatterns: input.denyDangerousPatterns ?? false,
						logDecisions: false,
						rules: input.rules ?? [],
					},
				}
			: {}),
		resumeHandler: createReviewHandler({
			mode: input.mode,
			...(input.prompt ? { prompt: input.prompt } : {}),
			registry,
		}),
		sessionId,
		sessionLog,
		...ids,
	} as QueryParams)
	const read = await sessionLog.readAll()
	const audit = read.entries
		.map((entry) => entry.record as unknown as Record<string, unknown>)
		.filter((record) => record.type === 'audit')
	return { cwd, text: toolTexts(result.messages), audit }
}

const hook = {
	path: '.git/hooks/pre-commit',
	content: '#!/bin/sh\necho planted\n',
}

describe('a write to a protected path', () => {
	it('is asked about under auto when a person is there, and names the path', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({
			kind: 'reject',
			feedback: 'no',
		}))
		const { cwd, audit } = await runCall({
			tool: 'write',
			args: hook,
			mode: 'auto',
			prompt,
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual({
			protectedPaths: [join(cwd, '.git', 'hooks', 'pre-commit')],
		})
		expect(existsSync(join(cwd, hook.path))).toBe(false)
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'protected_path_write',
				tool: 'write',
				resource: join(cwd, '.git', 'hooks', 'pre-commit'),
				outcome: 'refused',
			}),
		)
	})

	it('is written once a person approves, and the approval is on the record', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { cwd, audit } = await runCall({
			tool: 'write',
			args: hook,
			mode: 'auto',
			prompt,
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(existsSync(join(cwd, hook.path))).toBe(true)
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'protected_path_write',
				outcome: 'approved',
			}),
		)
	})

	it('is refused with nobody to ask, in auto', async () => {
		const { cwd, text } = await runCall({
			tool: 'write',
			args: hook,
			mode: 'auto',
		})

		expect(text).toContain(PROTECTED_PATH_UNATTENDED_REFUSAL)
		expect(existsSync(join(cwd, hook.path))).toBe(false)
	})

	it('is still asked about where a rule allows the tool by name', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'write',
			args: hook,
			mode: 'auto',
			prompt,
			rules: [{ type: 'allow_by_name', toolNames: ['write'] }],
		})

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is not covered by an earlier approve-all', async () => {
		const remembered = { all: true }
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		const cwd = await project()
		const tools = testToolset(WriteFileTool)
		const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			registry,
			remembered,
		})
		const result = await handler({
			type: 'tool_review',
			toolCalls: [
				{
					id: 'c1',
					name: 'write',
					input: hook,
					isDestructive: false,
					authorization: { decision: 'review' },
					escalation: { protectedPaths: [join(cwd, hook.path)] },
				},
			],
		} as never)

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(result.action).toBe('reject_tools')
	})

	it('is refused, unasked, in strict mode', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text } = await runCall({
			tool: 'write',
			args: hook,
			mode: 'strict',
			prompt,
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(text).toContain(STRICT_MODE_REFUSAL)
	})

	it('is asked about in accept-edits too', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({ tool: 'write', args: hook, mode: 'accept-edits', prompt })

		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('leaves an ordinary write alone: no question under auto', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		const { cwd } = await runCall({
			tool: 'write',
			args: { path: 'src/a.txt', content: 'x' },
			mode: 'auto',
			prompt,
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(existsSync(join(cwd, 'src', 'a.txt'))).toBe(true)
	})
})

describe('a shell line that writes a protected path', () => {
	it.each([
		['a redirection into a git hook', 'echo run > .git/hooks/post-commit'],
		['an append to a shell rc file in the home directory', 'echo alias >> ~/.bashrc'],
		['tee into the project config', 'echo {} | tee namzu.config.json'],
		['cp onto a protected file', 'cp payload .envrc'],
		['sed -i on a protected file', "sed -i 's/a/b/' .gitconfig"],
		['touch under .vscode', 'touch .vscode/tasks.json'],
	])('is asked about under auto: %s', async (_name, command) => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({ tool: 'bash', args: { command }, mode: 'auto', prompt })

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.protectedPaths?.length).toBe(1)
	})

	it('is refused with nobody to ask, and nothing runs', async () => {
		const { cwd, text } = await runCall({
			tool: 'bash',
			args: { command: 'echo run > .git/hooks/post-commit' },
			mode: 'auto',
		})

		expect(text).toContain(PROTECTED_PATH_UNATTENDED_REFUSAL)
		expect(existsSync(join(cwd, '.git', 'hooks', 'post-commit'))).toBe(false)
	})

	it('does not ask about reading the same files', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'bash',
			args: { command: 'cat .git/config' },
			mode: 'auto',
			prompt,
		})

		expect(prompt).not.toHaveBeenCalled()
	})
})

describe('a shell line that removes something catastrophic', () => {
	it.each([
		'rm -fr /',
		'rm -r -f /',
		'rm --recursive --force /',
		'rm -rf ~',
		'rm -rf $HOME',
		'rm -rf ..',
	])(
		'is refused with nobody to ask, in auto, where the old pattern let it by: %s',
		async (command) => {
			const { text } = await runCall({
				tool: 'bash',
				args: { command },
				mode: 'auto',
				denyDangerousPatterns: true,
			})

			expect(text).toContain(DANGEROUS_REMOVAL_UNATTENDED_REFUSAL)
		},
	)

	it('is asked about, with the reason, when a person is there', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		const { audit } = await runCall({
			tool: 'bash',
			args: { command: 'rm -rf "$BUILD/"' },
			mode: 'auto',
			prompt,
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.dangerousRemoval).toMatch(
			/\$BUILD is empty/,
		)
		expect(audit).toContainEqual(
			expect.objectContaining({
				action: 'dangerous_removal',
				outcome: 'refused',
			}),
		)
	})

	it('still stops the spelling the old pattern stopped, by the gate and without a question', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const { text } = await runCall({
			tool: 'bash',
			args: { command: 'rm -rf /' },
			mode: 'auto',
			prompt,
			denyDangerousPatterns: true,
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(text).toMatch(/Blocked by the authorization gate/)
	})

	it('leaves an ordinary removal alone', async () => {
		const cwd = await project()
		await mkdir(join(cwd, 'build'))
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'bash',
			args: { command: 'rm -rf build' },
			mode: 'auto',
			prompt,
			cwd,
		})

		expect(prompt).not.toHaveBeenCalled()
		expect(existsSync(join(cwd, 'build'))).toBe(false)
	})
})

describe('a shell line that names a path outside the roots', () => {
	it('is asked about, every time, on a turn that reviews outside paths', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'bash',
			args: { command: 'cat /etc/hosts' },
			mode: 'auto',
			prompt,
			outsideRootAccess: 'review',
		})

		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.outsidePaths).toEqual(['/etc/hosts'])
	})

	it('is refused with nobody to ask', async () => {
		const { text } = await runCall({
			tool: 'bash',
			args: { command: 'echo x > ~/.namzu-test-never-written' },
			mode: 'auto',
			outsideRootAccess: 'review',
		})

		expect(text).toContain(OUTSIDE_ROOTS_UNATTENDED_REFUSAL)
	})

	it('is not looked at on a turn that did not ask for review, as before', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'bash',
			args: { command: 'cat /etc/hosts' },
			mode: 'auto',
			prompt,
		})

		expect(prompt).not.toHaveBeenCalled()
	})

	it('does not ask about a path inside the working directory', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))
		await runCall({
			tool: 'bash',
			args: { command: 'cat src/a.txt; ls .; echo x > src/out.txt' },
			mode: 'auto',
			prompt,
			outsideRootAccess: 'review',
		})

		expect(prompt).not.toHaveBeenCalled()
	})
})

describe('carried bash cwd authorization', () => {
	it.skipIf(process.platform === 'win32')(
		'refuses a relative protected write from the carried cwd even in bypass',
		async () => {
			const cwd = await project()
			const carriedDirectory = join(cwd, '.git', 'hooks')
			const result = await runCall({
				tool: 'bash',
				args: { command: 'echo planted > pre-commit' },
				mode: 'bypass',
				cwd,
				carriedDirectory,
			})
			expect(result.text).toContain(PROTECTED_PATH_UNATTENDED_REFUSAL)
			expect(existsSync(join(carriedDirectory, 'pre-commit'))).toBe(false)
			expect(result.audit).toContainEqual(
				expect.objectContaining({
					action: 'protected_path_write',
					resource: join(carriedDirectory, 'pre-commit'),
					outcome: 'refused',
				}),
			)
		},
	)
})

describe('bash review directory is pinned for a prepared batch', () => {
	it.skipIf(process.platform === 'win32')(
		'refuses a later call when an earlier cd changed its reviewed directory',
		async () => {
			const cwd = await project()
			const result = await runCall({
				tool: 'bash',
				// A mutation keeps this call on the serial chain: read-only `cd`
				// may run beside the write and would not establish the order tested.
				args: { command: 'echo changed > cwd-marker && cd .git/hooks' },
				extraCalls: [{ id: 'c2', name: 'bash', args: { command: 'echo planted > pre-commit' } }],
				mode: 'auto',
				cwd,
			})
			expect(result.text).toContain('Shell working directory changed after this call was reviewed')
			expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
			expect(existsSync(join(cwd, 'pre-commit'))).toBe(false)
		},
	)
})
