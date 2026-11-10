import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { forgetCarriedDirectories } from '../../../tools/builtins/bash-cwd.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import {
	PROTECTED_PATH_UNATTENDED_REFUSAL,
	type ReviewMode,
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

/**
 * Creating or deleting a top-level entry of the home folder or the filesystem
 * root is a question in every mode, `bypass` included, and a refusal when
 * nobody can be asked. Inside an existing top-level folder nothing changes.
 * The home folder is a temporary one (`HOME`), so no real folder is touched.
 */

const dirs: string[] = []
let home = ''

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-home-'))
	dirs.push(home)
	await mkdir(join(home, 'projects', 'x'), { recursive: true })
	await writeFile(join(home, 'existing.txt'), 'x')
	await mkdir(join(home, 'olddir'), { recursive: true })
	vi.stubEnv('HOME', home)
})

afterEach(async () => {
	vi.unstubAllEnvs()
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

async function run(input: {
	readonly tool: 'write' | 'bash'
	readonly args: Record<string, unknown>
	readonly mode?: ReviewMode
	readonly cwd?: string
	readonly prompt?: ToolReviewPrompt
}) {
	const cwd = input.cwd ?? join(home, 'projects', 'x')
	const tools = testToolset(input.tool === 'write' ? WriteFileTool : BashTool)
	const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
	const call: MockTurn = {
		toolCalls: [{ id: 'c1', name: input.tool, args: input.args }],
		finishReason: 'tool_calls',
	}
	const sessionId = generateSessionId()
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [call, { text: 'done' }] }),
		toolsets: [tools],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('do it')],
		workingDirectory: cwd,
		outsideRootAccess: 'review',
		resumeHandler: createReviewHandler({
			mode: input.mode ?? 'bypass',
			...(input.prompt ? { prompt: input.prompt } : {}),
			registry,
		}),
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		...ids,
	} as QueryParams)
	return { text: toolTexts(result.messages) }
}

const reject = () => vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject' }))

describe('a shell line that creates or deletes a top-level entry of the home folder', () => {
	it.each([
		['mkdir a new folder', 'mkdir ~/newthing'],
		['mkdir -p below a new folder', 'mkdir -p ~/newthing/sub'],
		['git clone into a new folder', 'git clone https://example.test/r.git ~/repo'],
		['touch a new file', 'touch ~/new.txt'],
		['a redirect into a new file', 'echo hi > ~/new.txt'],
		['a redirect spelled with $HOME', 'echo hi > $HOME/new.txt'],
		['rm -rf an existing folder', 'rm -rf ~/olddir'],
		['rm an existing file', 'rm ~/existing.txt'],
		['mv an existing folder away', 'mv ~/olddir ~/projects/x/'],
		['mv into a new top-level name', 'mv ~/projects/x/a ~/moved'],
		['cp into a new top-level name', 'cp -r ~/projects/x ~/copy'],
	])('is asked about in bypass mode: %s', async (_name, command) => {
		const prompt = reject()
		await run({ tool: 'bash', args: { command }, prompt })
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(
			prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation?.protectedPaths?.length,
		).toBeGreaterThan(0)
	})

	it.each([
		['mkdir newthing'],
		['git clone https://example.test/r.git'],
		['git clone --depth 1 -b main https://example.test/r.git'],
	])(
		'is asked about from a working folder that is the home folder, relative: %s',
		async (command) => {
			const prompt = reject()
			await run({ tool: 'bash', args: { command }, cwd: home, prompt })
			expect(prompt).toHaveBeenCalledTimes(1)
		},
	)

	it('is refused with nobody to ask, and nothing runs', async () => {
		const { text } = await run({ tool: 'bash', args: { command: 'mkdir ~/newthing' } })
		expect(text).toContain(PROTECTED_PATH_UNATTENDED_REFUSAL)
		expect(text).toContain('top-level entry')
		expect(existsSync(join(home, 'newthing'))).toBe(false)
	})

	it('is asked about in the other modes too', async () => {
		for (const mode of ['auto', 'accept-edits'] as const) {
			const prompt = reject()
			await run({ tool: 'bash', args: { command: 'mkdir ~/newthing' }, mode, prompt })
			expect(prompt, mode).toHaveBeenCalledTimes(1)
		}
	})

	it.each([
		['inside an existing top-level folder', 'mkdir ~/projects/x/new'],
		['a new folder two levels down', 'mkdir -p ~/projects/y/z'],
		['a file under the working folder', 'echo hi > out.txt'],
		['a redirect into the temp folder', `echo hi > ${tmpdir()}/namzu-top-level.txt`],
		['rm inside an existing folder', 'rm -rf ~/projects/x/gone'],
		['rm of a top-level name that does not exist', 'rm -f ~/nothing-here'],
		['touching an existing top-level file', 'touch ~/existing.txt'],
		['a path built at runtime', 'mkdir "$SOME_DIR/new"'],
		['a read of the home folder', 'ls ~ && cat ~/existing.txt'],
	])('is not asked about: %s', async (_name, command) => {
		const prompt = reject()
		await run({ tool: 'bash', args: { command }, prompt })
		expect(prompt).not.toHaveBeenCalled()
	})

	it('is not asked about when the turn does not review outside paths', async () => {
		// `outsideRootAccess` absent: the same line is left to the other floors.
		const prompt = reject()
		const cwd = join(home, 'projects', 'x')
		const tools = testToolset(BashTool)
		const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
		const sessionId = generateSessionId()
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'mkdir ~/newthing' } }],
						finishReason: 'tool_calls',
					},
					{ text: 'done' },
				],
			}),
			toolsets: [tools],
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('do it')],
			workingDirectory: cwd,
			resumeHandler: createReviewHandler({ mode: 'bypass', prompt, registry }),
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			...ids,
		} as QueryParams)
		expect(prompt).not.toHaveBeenCalled()
	})
})

describe('a file tool that creates a top-level entry of the home folder', () => {
	it('is asked about when it creates a new file in the home folder', async () => {
		const prompt = reject()
		await run({
			tool: 'write',
			args: { path: join(home, 'new.txt'), content: 'x' },
			cwd: home,
			prompt,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(existsSync(join(home, 'new.txt'))).toBe(false)
	})

	it('is asked about with a relative path from a home working folder', async () => {
		const prompt = reject()
		await run({ tool: 'write', args: { path: 'new.txt', content: 'x' }, cwd: home, prompt })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is refused with nobody to ask', async () => {
		const { text } = await run({
			tool: 'write',
			args: { path: 'new.txt', content: 'x' },
			cwd: home,
		})
		expect(text).toContain(PROTECTED_PATH_UNATTENDED_REFUSAL)
		expect(existsSync(join(home, 'new.txt'))).toBe(false)
	})

	it('is not asked about for a file inside a project folder or one that already exists', async () => {
		for (const [cwd, path] of [
			[join(home, 'projects', 'x'), 'new.txt'],
			[home, 'existing.txt'],
		] as const) {
			const prompt = reject()
			await run({ tool: 'write', args: { path, content: 'x' }, cwd, prompt })
			expect(prompt).not.toHaveBeenCalled()
		}
	})
})

describe('a shell line that creates a top-level entry of the filesystem root', () => {
	it('is asked about, even in bypass mode', async () => {
		const prompt = reject()
		await run({ tool: 'bash', args: { command: 'mkdir /namzu-top-level-test' }, prompt })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is asked about for a new file at the root', async () => {
		const prompt = reject()
		await run({ tool: 'bash', args: { command: 'echo x > /namzu-top-level-test.txt' }, prompt })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is not asked about inside an existing top-level folder', async () => {
		const prompt = reject()
		await run({ tool: 'bash', args: { command: `mkdir ${tmpdir()}/namzu-tl-ok` }, prompt })
		expect(prompt).not.toHaveBeenCalled()
	})
})
