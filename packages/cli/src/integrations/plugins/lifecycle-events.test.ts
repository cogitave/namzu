/**
 * The host-fired hook events through the real plugin runtime and shell
 * hooks: a model switch, a tool server's question, an added folder, an
 * instruction file and a command that expanded. Each hook is a small script
 * that records what it was sent and answers from what the test wrote.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MCPElicitationRequest } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { createSessionDirectories } from '../../context/directories.js'
import { ProjectInstructionTracker } from '../../context/project-tracker.js'
import type { QuestionFn } from '../../tui/agent.js'
import { elicitThroughQuestions } from '../mcp/elicitation.js'
import {
	directoryAdded,
	elicitationHooks,
	instructionsLoaded,
	postModelSwitch,
	preModelSwitch,
	userPromptExpansion,
} from './lifecycle-events.js'
import { createCliPluginRuntime } from './runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const project = () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-lifecycle-events-'))
	dirs.push(dir)
	return dir
}

/** A hook that saves its stdin to `<dir>/<name>.json` and then prints `reply` (a file) when one exists. */
function recorder(dir: string, name: string): { command: string; saved: () => any } {
	const out = join(dir, `${name}.json`)
	const reply = join(dir, `${name}.reply`)
	return {
		command: `cat > '${out}'; if [ -f '${reply}' ]; then cat '${reply}'; fi; if [ -f '${reply}.exit' ]; then echo "$(cat '${reply}.exit.text')" >&2; exit 2; fi`,
		saved: () => JSON.parse(readFileSync(out, 'utf8')),
	}
}
const reply = (dir: string, name: string, text: string) =>
	writeFileSync(join(dir, `${name}.reply`), text)
const refuse = (dir: string, name: string, text: string) => {
	writeFileSync(join(dir, `${name}.reply.exit`), '')
	writeFileSync(join(dir, `${name}.reply.exit.text`), text)
}

async function runtimeWith(cwd: string, hooks: Record<string, unknown>) {
	const runtime = await createCliPluginRuntime(undefined, cwd, hooks as never, {
		sessionId: () => 'session-1',
	})
	if (!runtime) throw new Error('no runtime')
	return runtime
}

const switchInfo = {
	fromModel: 'a/one',
	toModel: 'b/two',
	requestedModel: 'two',
	source: 'command' as const,
}

describe('pre_model_switch', () => {
	it('is sent both models and what asked, and lets the switch go when it says nothing', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'pre')
		const runtime = await runtimeWith(cwd, { pre_model_switch: [{ command: hook.command }] })
		expect(await preModelSwitch(runtime.manager, 'session-1', switchInfo)).toEqual({
			kind: 'allow',
		})
		expect(hook.saved()).toMatchObject({
			hook_event_name: 'PreModelSwitch',
			from_model: 'a/one',
			to_model: 'b/two',
			requested_model: 'two',
			source: 'command',
		})
	})

	it('refuses with exit 2, and asks the person with an ask answer', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'pre')
		const runtime = await runtimeWith(cwd, { pre_model_switch: [{ command: hook.command }] })
		refuse(cwd, 'pre', 'models are fixed here.')
		expect(await preModelSwitch(runtime.manager, 'session-1', switchInfo)).toEqual({
			kind: 'deny',
			reason: 'models are fixed here.',
		})
		rmSync(join(cwd, 'pre.reply.exit'))
		reply(
			cwd,
			'pre',
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreModelSwitch',
					permissionDecision: 'ask',
					permissionDecisionReason: 'cache is warm',
				},
			}),
		)
		expect(await preModelSwitch(runtime.manager, 'session-1', switchInfo)).toEqual({
			kind: 'ask',
			reason: 'cache is warm',
		})
	})

	it('with no hooks, allows', async () => {
		expect(await preModelSwitch(undefined, 's', switchInfo)).toEqual({ kind: 'allow' })
	})
})

describe('post_model_switch', () => {
	it('hands back what a hook wants the model to read', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'post')
		const runtime = await runtimeWith(cwd, { post_model_switch: [{ command: hook.command }] })
		reply(
			cwd,
			'post',
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PostModelSwitch',
					additionalContext: 'Answer briefly.',
				},
			}),
		)
		expect(await postModelSwitch(runtime.manager, 'session-1', switchInfo)).toBe('Answer briefly.')
		expect(hook.saved()).toMatchObject({ hook_event_name: 'PostModelSwitch', to_model: 'b/two' })
	})
})

describe('elicitation', () => {
	const asked: MCPElicitationRequest = {
		serverName: 'docs',
		message: 'Which space?',
		requestedSchema: { type: 'object', properties: { space: { type: 'string' } } },
	}
	const live = new AbortController().signal
	const noOne: QuestionFn = async () => {
		throw new Error('the person must not be asked')
	}

	it('a hook can answer for the person, so nobody is asked', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'ask')
		const runtime = await runtimeWith(cwd, { elicitation: [{ command: hook.command }] })
		reply(
			cwd,
			'ask',
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'Elicitation',
					action: 'accept',
					content: { space: 'eng' },
				},
			}),
		)
		const handler = elicitThroughQuestions(
			() => noOne,
			() =>
				elicitationHooks(
					() => runtime.manager,
					() => 'session-1',
				),
		)
		expect(await handler(asked, { signal: live })).toEqual({
			action: 'accept',
			content: { space: 'eng' },
		})
		expect(hook.saved()).toMatchObject({
			hook_event_name: 'Elicitation',
			mcp_server_name: 'docs',
			message: 'Which space?',
			mode: 'form',
		})
	})

	it('a refusing hook declines the question', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'ask')
		const runtime = await runtimeWith(cwd, { elicitation: [{ command: hook.command }] })
		refuse(cwd, 'ask', 'no questions today')
		const handler = elicitThroughQuestions(
			() => noOne,
			() =>
				elicitationHooks(
					() => runtime.manager,
					() => 'session-1',
				),
		)
		expect(await handler(asked, { signal: live })).toEqual({ action: 'decline' })
	})

	it("elicitation_result sees the person's answer and may replace it", async () => {
		const cwd = project()
		const hook = recorder(cwd, 'result')
		const runtime = await runtimeWith(cwd, { elicitation_result: [{ command: hook.command }] })
		const person: QuestionFn = async () => ({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [{ questionId: 'f0', selectedOptionIds: [], freeText: 'mine' }],
		})
		reply(
			cwd,
			'result',
			JSON.stringify({
				hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'decline' },
			}),
		)
		const handler = elicitThroughQuestions(
			() => person,
			() =>
				elicitationHooks(
					() => runtime.manager,
					() => 'session-1',
				),
		)
		expect(await handler(asked, { signal: live })).toEqual({ action: 'decline' })
		expect(hook.saved()).toMatchObject({
			hook_event_name: 'ElicitationResult',
			action: 'accept',
			content: { space: 'mine' },
		})
	})

	it('without hooks the person is asked as before', async () => {
		let shown = 0
		const person: QuestionFn = async () => {
			shown += 1
			return { kind: 'skip' }
		}
		const handler = elicitThroughQuestions(() => person)
		expect(await handler(asked, { signal: live })).toEqual({ action: 'decline' })
		expect(shown).toBe(1)
	})
})

describe('directory_added', () => {
	it('fires once a folder is added, with the folder and its source, and reads its matcher', async () => {
		const cwd = project()
		const other = project()
		const hook = recorder(cwd, 'dir')
		const skipped = recorder(cwd, 'dir-skipped')
		const runtime = await runtimeWith(cwd, {
			directory_added: [
				{ command: hook.command, matcher: 'slash_command' },
				{ command: skipped.command, matcher: 'register_repo_root' },
			],
		})
		const list: string[] = []
		const directories = createSessionDirectories(cwd, list, (path) =>
			directoryAdded(runtime.manager, 'session-1', path),
		)
		const result = await directories.add(other, { approve: async () => true })
		expect(result.added).toBe(true)
		expect(hook.saved()).toMatchObject({
			hook_event_name: 'DirectoryAdded',
			directory: result.path,
			source: 'slash_command',
		})
		expect(() => skipped.saved()).toThrow()
	})

	it('does not fire for a folder that was refused', async () => {
		const cwd = project()
		const other = project()
		const hook = recorder(cwd, 'dir')
		const runtime = await runtimeWith(cwd, { directory_added: [{ command: hook.command }] })
		const directories = createSessionDirectories(cwd, [], (path) =>
			directoryAdded(runtime.manager, 'session-1', path),
		)
		expect((await directories.add(other, { approve: async () => false })).added).toBe(false)
		expect(() => hook.saved()).toThrow()
	})
})

describe('instructions_loaded', () => {
	it('fires for each instruction file once, with its kind and why it was read', async () => {
		const cwd = project()
		mkdirSync(join(cwd, '.git'))
		writeFileSync(join(cwd, 'AGENTS.md'), 'Be kind. @notes.md\n')
		writeFileSync(join(cwd, 'notes.md'), 'More.\n')
		const log = join(cwd, 'seen.log')
		const runtime = await runtimeWith(cwd, {
			instructions_loaded: [
				{ command: `cat >> '${log}'; echo >> '${log}'`, matcher: 'session_start|include' },
			],
		})
		const running: Promise<void>[] = []
		const tracker = new ProjectInstructionTracker(cwd, {
			userHome: null,
			onLoaded: (file) => {
				running.push(instructionsLoaded(runtime.manager, 'session-1', file))
			},
		})
		tracker.prepareSnapshot([])
		tracker.prepareSnapshot([])
		await Promise.all(running)
		// The `compact` run is a reason the matcher leaves out.
		await instructionsLoaded(runtime.manager, 'session-1', {
			filePath: 'x',
			memoryType: 'Project',
			loadReason: 'compact',
		})
		const lines = readFileSync(log, 'utf8')
			.split('\n')
			.filter((line) => line.startsWith('{'))
			.map((line) => JSON.parse(line))
		const named = lines.map((line) => [line.load_reason, line.file_path.split('/').pop()])
		expect(named).toEqual(
			expect.arrayContaining([
				['session_start', 'AGENTS.md'],
				['include', 'notes.md'],
			]),
		)
		// Once each, and the `compact` run was filtered out by the matcher.
		expect(named.filter(([, file]) => file === 'AGENTS.md')).toHaveLength(1)
		expect(lines.some((line) => line.load_reason === 'compact')).toBe(false)
		expect(lines.find((line) => line.file_path.endsWith('notes.md'))).toMatchObject({
			memory_type: 'Project',
			parent_file_path: expect.stringContaining('AGENTS.md'),
		})
	})
})

describe('user_prompt_expansion', () => {
	const expansion = {
		expansionType: 'slash_command' as const,
		commandName: 'review',
		commandArgs: 'main',
		commandSource: 'project',
	}

	it('is sent the command and its expansion, and adds context', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'exp')
		const runtime = await runtimeWith(cwd, { user_prompt_expansion: [{ command: hook.command }] })
		reply(
			cwd,
			'exp',
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'UserPromptExpansion',
					additionalContext: 'On branch x',
				},
			}),
		)
		expect(
			await userPromptExpansion(runtime.manager, 'session-1', expansion, 'Review main'),
		).toEqual({
			context: 'On branch x',
		})
		expect(hook.saved()).toMatchObject({
			hook_event_name: 'UserPromptExpansion',
			expansion_type: 'slash_command',
			command_name: 'review',
			command_args: 'main',
			command_source: 'project',
			prompt: 'Review main',
		})
	})

	it('stops the command on exit 2', async () => {
		const cwd = project()
		const hook = recorder(cwd, 'exp')
		const runtime = await runtimeWith(cwd, { user_prompt_expansion: [{ command: hook.command }] })
		refuse(cwd, 'exp', 'not allowed')
		expect(await userPromptExpansion(runtime.manager, 'session-1', expansion, 'Review')).toEqual({
			blocked: 'not allowed',
		})
	})
})
