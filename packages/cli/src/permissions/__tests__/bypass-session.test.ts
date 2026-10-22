/**
 * What `--yolo` does to the calls the owner kept being asked about.
 *
 * A real kernel turn with a scripted model: the model asks for one shell
 * command, the CLI's own review handler decides it in `bypass` (what `--yolo`
 * now means), and the test counts the questions put to a person and the
 * commands that ran. Nothing here calls a model or waits on a clock.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	BashTool,
	MockLLMProvider,
	type SessionId,
	type TenantId,
	ToolManager,
	type TopicId,
	createUserMessage,
	query,
	toolset,
} from '@namzu/sdk'
import type { ProjectId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type PermissionFn, makeResumeHandler } from '../../tui/agent.js'
import type { PermissionMode } from '../mode.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

/** One turn: the model asks for `command`, and whatever happens, ends. */
async function run(
	command: string,
	mode: PermissionMode,
	answer: 'approve' | 'reject' = 'reject',
	giveRoots = true,
) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-bypass-session-'))
	dirs.push(cwd)
	mkdirSync(join(cwd, 'sub'))
	const execute = vi.fn(async () => ({ success: true, output: 'ran' }))
	const shell = toolset('shell', [{ ...BashTool, execute }])
	const registry = new ToolManager({ toolsets: [shell], messages: () => [] })
	const asked = vi.fn<PermissionFn>(async () =>
		answer === 'approve' ? { kind: 'approve' } : { kind: 'reject', feedback: 'no' },
	)
	const handler = makeResumeHandler(
		{ all: false },
		asked,
		mode,
		() => false,
		{},
		undefined,
		undefined,
		{
			...(giveRoots ? { roots: () => [cwd], registry } : {}),
		},
	)
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'bash', args: { command } }] }, { text: 'done' }],
	})
	for await (const _event of query({
		provider,
		toolsets: [shell],
		messages: [createUserMessage('go')],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
			permissionMode: 'auto',
		},
		agentId: 'agent_shell',
		agentName: 'Shell',
		workingDirectory: cwd,
		sessionId: '052b7785-2bcc-458a-8184-76dfbdbfdf58' as SessionId,
		topicId: '458174d9-b54f-43a9-9ccc-c3d87be14190' as TopicId,
		projectId: '8e2b818f-eb63-4f6e-a416-18b311dcb61c' as ProjectId,
		tenantId: '36da1973-021d-40d5-9a72-7ba4084729de' as TenantId,
		// The CLI's own gate: dangerous patterns are refused before any mode.
		authorizationGate: {
			enabled: true,
			rules: [],
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		// As the CLI runs: a path outside the roots is a question, not a refusal.
		outsideRootAccess: 'review',
		resumeHandler: handler,
	} as never)) {
		// drain
	}
	return { asked, execute, provider }
}

describe('a --yolo session', () => {
	it.each([
		['a path outside the folder', 'cat /tmp/x'],
		['a program the line does not name', '$CMD build'],
		['a write after cd into a folder inside the root', 'cd sub && echo hi > f'],
	])('runs %s without asking anyone', async (_label, command) => {
		const { asked, execute } = await run(command, 'bypass')

		expect(asked).not.toHaveBeenCalled()
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('still asks before removing the home directory', async () => {
		const { asked, execute } = await run('rm -rf ~', 'bypass')

		expect(asked).toHaveBeenCalledTimes(1)
		expect(execute).not.toHaveBeenCalled()
	})

	it('refuses a dangerous command outright, without asking', async () => {
		const { asked, execute, provider } = await run('sudo ls', 'bypass')

		expect(asked).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests.at(-1)?.messages)).toMatch(/blocked|denied|refused/i)
	})

	it('would have asked about the first two under the old reading of the flag', async () => {
		// The kernel's `auto` is what `--yolo` used to mean: it asks about a path
		// outside the folder and a program it cannot name. This pins the difference.
		const outside = await run('cat /tmp/x', 'auto', 'approve')
		const unnamed = await run('$CMD build', 'auto', 'approve')

		expect(outside.asked).toHaveBeenCalled()
		expect(unnamed.asked).toHaveBeenCalled()
	})
})

describe('accept-edits and the folders the session works in', () => {
	it('runs simple file commands inside the roots without asking, once the policy is told the roots', async () => {
		for (const command of ['mkdir out', 'touch sub/a.txt', 'cp sub/a.txt sub/b.txt']) {
			const { asked, execute } = await run(command, 'accept-edits')

			expect(asked, command).not.toHaveBeenCalled()
			expect(execute, command).toHaveBeenCalledTimes(1)
		}
	})

	it('asks about the same commands when the roots are not passed on', async () => {
		const { asked } = await run('mkdir out', 'accept-edits', 'approve', false)

		expect(asked).toHaveBeenCalledTimes(1)
	})

	it('asks when a command names a path outside the roots', async () => {
		const { asked, execute } = await run('touch /tmp/outside.txt', 'accept-edits')

		expect(asked).toHaveBeenCalledTimes(1)
		expect(execute).not.toHaveBeenCalled()
	})
})
