/**
 * The hook events for model switches, tool-server questions, working folders,
 * instruction files, expanded commands and tasks: what each is sent, which
 * matcher it reads, and what its answer does.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PluginHookContext } from '../../types/plugin/index.js'
import { asSessionId } from '../../utils/id.js'
import {
	SHELL_HOOK_EVENTS,
	SHELL_HOOK_PASCAL_EVENT_NAMES,
	type ShellHookEvent,
	createShellHook,
	shellHookPayload,
	shellHookVerdict,
} from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const ok = { exitCode: 0, timedOut: false, stdout: '', stderr: '' }
const json = (value: unknown) => ({ ...ok, stdout: JSON.stringify(value) })
const entry = { command: 'x' }

const NEW_EVENTS = {
	pre_model_switch: 'PreModelSwitch',
	post_model_switch: 'PostModelSwitch',
	elicitation: 'Elicitation',
	elicitation_result: 'ElicitationResult',
	directory_added: 'DirectoryAdded',
	instructions_loaded: 'InstructionsLoaded',
	user_prompt_expansion: 'UserPromptExpansion',
	task_created: 'TaskCreated',
	task_completed: 'TaskCompleted',
	teammate_idle: 'TeammateIdle',
	teammate_start: 'TeammateStart',
	teammate_stop: 'TeammateStop',
} as const

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function context(
	event: ShellHookEvent,
	fields: Partial<PluginHookContext> = {},
): PluginHookContext {
	return { event, sessionId: asSessionId(SESSION), pluginId: 'p' as never, ...fields }
}

describe('the events', () => {
	it('are shell hook events, each with its written name', () => {
		for (const [event, written] of Object.entries(NEW_EVENTS)) {
			expect(SHELL_HOOK_EVENTS).toContain(event)
			expect(SHELL_HOOK_PASCAL_EVENT_NAMES[event as ShellHookEvent]).toBe(written)
		}
	})
})

describe('what each event is sent', () => {
	const send = (input: Record<string, unknown>) =>
		JSON.parse(shellHookPayload({ cwd: '/p', sessionId: SESSION, ...input } as never))

	it('model switches carry the model left, the model asked for and what asked', () => {
		const modelSwitch = {
			fromModel: 'a/one',
			toModel: 'b/two',
			requestedModel: 'two',
			source: 'picker',
		}
		for (const event of ['pre_model_switch', 'post_model_switch']) {
			expect(send({ event, modelSwitch })).toMatchObject({
				hook_event_name: NEW_EVENTS[event as keyof typeof NEW_EVENTS],
				from_model: 'a/one',
				to_model: 'b/two',
				requested_model: 'two',
				source: 'picker',
			})
		}
	})

	it('elicitation carries the question, and its result the answer', () => {
		const asked = send({
			event: 'elicitation',
			elicitation: {
				serverName: 'docs',
				message: 'Which space?',
				mode: 'form',
				elicitationId: 'e1',
				requestedSchema: { type: 'object' },
			},
		})
		expect(asked).toMatchObject({
			mcp_server_name: 'docs',
			message: 'Which space?',
			mode: 'form',
			elicitation_id: 'e1',
			requested_schema: { type: 'object' },
		})
		expect(asked.action).toBeUndefined()
		const answered = send({
			event: 'elicitation_result',
			elicitation: {
				serverName: 'docs',
				message: 'Which space?',
				action: 'accept',
				content: { space: 'x' },
			},
		})
		expect(answered).toMatchObject({ action: 'accept', content: { space: 'x' } })
	})

	it('directory_added carries the folder and what added it', () => {
		expect(
			send({ event: 'directory_added', directory: '/other', directorySource: 'slash_command' }),
		).toMatchObject({ directory: '/other', source: 'slash_command' })
	})

	it('instructions_loaded carries the file, its kind and why it was read', () => {
		expect(
			send({
				event: 'instructions_loaded',
				instructions: {
					filePath: '/p/AGENTS.md',
					memoryType: 'Project',
					loadReason: 'include',
					parentFilePath: '/p/AGENTS.local.md',
				},
			}),
		).toMatchObject({
			file_path: '/p/AGENTS.md',
			memory_type: 'Project',
			load_reason: 'include',
			parent_file_path: '/p/AGENTS.local.md',
		})
	})

	it('user_prompt_expansion carries the command and what it expanded to', () => {
		expect(
			send({
				event: 'user_prompt_expansion',
				prompt: 'Review the diff',
				expansion: {
					expansionType: 'slash_command',
					commandName: 'review',
					commandArgs: 'main',
					commandSource: 'project',
				},
			}),
		).toMatchObject({
			expansion_type: 'slash_command',
			command_name: 'review',
			command_args: 'main',
			command_source: 'project',
			prompt: 'Review the diff',
		})
	})

	it('task events carry the task, with no id before it exists', () => {
		const created = send({ event: 'task_created', task: { subject: 'Ship it' } })
		expect(created).toMatchObject({ task_subject: 'Ship it' })
		expect(created.task_id).toBeUndefined()
		expect(
			send({ event: 'task_completed', task: { id: 't1', subject: 'Ship it', description: 'd' } }),
		).toMatchObject({ task_id: 't1', task_subject: 'Ship it', task_description: 'd' })
	})
})

describe('teammate events', () => {
	it('send the teammate and its team, and the task events send them when a teammate caused them', () => {
		for (const event of ['teammate_idle', 'teammate_start', 'teammate_stop'] as const) {
			expect(
				JSON.parse(
					shellHookPayload({
						event,
						cwd: '/w',
						sessionId: SESSION,
						teammateName: 'writer',
						teamName: 'team-ab12',
					}),
				),
			).toMatchObject({ teammate_name: 'writer', team_name: 'team-ab12' })
		}
		const done = JSON.parse(
			shellHookPayload({
				event: 'task_completed',
				cwd: '/w',
				sessionId: SESSION,
				task: { id: '3' },
				teammateName: 'writer',
				teamName: 'team-ab12',
			}),
		)
		expect(done).toMatchObject({ task_id: '3', teammate_name: 'writer', team_name: 'team-ab12' })
		const lead = JSON.parse(
			shellHookPayload({ event: 'task_created', cwd: '/w', sessionId: SESSION, task: {} }),
		)
		expect(lead.teammate_name).toBeUndefined()
		expect(lead.team_name).toBeUndefined()
	})

	it('teammate_idle: exit 2 sends the stderr back as feedback and keeps the teammate working', () => {
		expect(
			shellHookVerdict('teammate_idle', entry, {
				...ok,
				exitCode: 2,
				stderr: 'run the tests first',
			}),
		).toEqual({ action: 'skip', reason: 'run the tests first' })
		expect(shellHookVerdict('teammate_idle', entry, ok)).toEqual({ action: 'continue' })
		// A failing script is the hook's failure, never feedback.
		expect(
			shellHookVerdict('teammate_idle', entry, { ...ok, exitCode: 1, stderr: 'boom' }),
		).toEqual({
			action: 'continue',
		})
	})

	it('teammate_start and teammate_stop are observational: a 2 refuses nothing', () => {
		for (const event of ['teammate_start', 'teammate_stop'] as const) {
			expect(shellHookVerdict(event, entry, { ...ok, exitCode: 2, stderr: 'x' })).toEqual({
				action: 'continue',
			})
		}
	})
})

describe('pre_model_switch answers', () => {
	const run = (outcome: object) => shellHookVerdict('pre_model_switch', entry, outcome as never)

	it('exit 2 refuses the switch with the hook text as the reason', () => {
		expect(run({ ...ok, exitCode: 2, stderr: 'no switching today' })).toEqual({
			action: 'skip',
			reason: 'no switching today',
		})
	})

	it('permissionDecision deny refuses, ask has the person confirm, allow goes ahead', () => {
		const answer = (permissionDecision: string) =>
			run(
				json({
					hookSpecificOutput: {
						hookEventName: 'PreModelSwitch',
						permissionDecision,
						permissionDecisionReason: 'because',
					},
				}),
			)
		expect(answer('deny')).toMatchObject({ action: 'skip', reason: 'because' })
		expect(answer('ask')).toMatchObject({
			action: 'continue',
			permission: { decision: 'ask', reason: 'because' },
		})
		expect(answer('allow')).toMatchObject({ action: 'continue', permission: { decision: 'allow' } })
		expect(run(ok)).toEqual({ action: 'continue' })
	})

	it('does not read updatedInput: there is no input to rewrite', () => {
		expect(
			run(
				json({
					hookSpecificOutput: { hookEventName: 'PreModelSwitch', updatedInput: { model: 'x' } },
				}),
			),
		).toEqual({ action: 'continue' })
	})
})

describe('post_model_switch answers', () => {
	it('what the hook says reaches the model, as additionalContext or plain text', () => {
		expect(
			shellHookVerdict(
				'post_model_switch',
				entry,
				json({
					hookSpecificOutput: { hookEventName: 'PostModelSwitch', additionalContext: 'Be terse.' },
				}),
			),
		).toEqual({ action: 'annotate', text: 'Be terse.' })
		expect(shellHookVerdict('post_model_switch', entry, { ...ok, stdout: 'plain note\n' })).toEqual(
			{ action: 'annotate', text: 'plain note' },
		)
	})

	it('cannot refuse: exit 2 is reported and the turn goes on', () => {
		expect(
			shellHookVerdict('post_model_switch', entry, { ...ok, exitCode: 2, stderr: 'x' }),
		).toEqual({ action: 'continue' })
	})
})

describe('elicitation answers', () => {
	const run = (event: 'elicitation' | 'elicitation_result', outcome: object) =>
		shellHookVerdict(event, entry, outcome as never)

	it('a hook can respond for the person, or decline', () => {
		expect(
			run(
				'elicitation',
				json({
					hookSpecificOutput: {
						hookEventName: 'Elicitation',
						action: 'accept',
						content: { space: 'x' },
					},
				}),
			),
		).toEqual({ action: 'continue', elicitation: { action: 'accept', content: { space: 'x' } } })
		expect(
			run(
				'elicitation',
				json({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } }),
			),
		).toEqual({ action: 'continue', elicitation: { action: 'decline' } })
	})

	it('exit 2 refuses the question, and the result too', () => {
		for (const event of ['elicitation', 'elicitation_result'] as const) {
			expect(run(event, { ...ok, exitCode: 2, stderr: 'not here' })).toEqual({
				action: 'skip',
				reason: 'not here',
			})
		}
	})

	it('an unknown action is set aside as unreadable and the question goes to the person', () => {
		expect(
			run(
				'elicitation',
				json({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'maybe' } }),
			),
		).toEqual({ action: 'continue' })
	})

	it('a result may carry new values for the server', () => {
		expect(
			run(
				'elicitation_result',
				json({
					hookSpecificOutput: { hookEventName: 'ElicitationResult', content: { space: 'y' } },
				}),
			),
		).toEqual({ action: 'continue', elicitation: { action: 'accept', content: { space: 'y' } } })
	})
})

describe('user_prompt_expansion answers', () => {
	const run = (outcome: object) =>
		shellHookVerdict('user_prompt_expansion', entry, outcome as never)

	it('stops the command with exit 2 or a block, and adds context otherwise', () => {
		expect(run({ ...ok, exitCode: 2, stderr: 'not that one' })).toEqual({
			action: 'skip',
			reason: 'not that one',
		})
		expect(run(json({ decision: 'block', reason: 'nope' }))).toEqual({
			action: 'skip',
			reason: 'nope',
		})
		expect(
			run(
				json({
					hookSpecificOutput: {
						hookEventName: 'UserPromptExpansion',
						additionalContext: 'On branch x',
					},
				}),
			),
		).toEqual({ action: 'annotate', text: 'On branch x' })
		expect(run(ok)).toEqual({ action: 'continue' })
	})
})

describe('task events answers', () => {
	it('exit 2 refuses the task and the reason reaches the model; anything else lets it be', () => {
		for (const event of ['task_created', 'task_completed'] as const) {
			expect(shellHookVerdict(event, entry, { ...ok, exitCode: 2, stderr: 'not yet' })).toEqual({
				action: 'skip',
				reason: 'not yet',
			})
			expect(shellHookVerdict(event, entry, ok)).toEqual({ action: 'continue' })
		}
	})
})

describe('the folder and instruction events', () => {
	it('are observational: a 2 is reported and nothing is refused', () => {
		for (const event of ['directory_added', 'instructions_loaded'] as const) {
			expect(shellHookVerdict(event, entry, { ...ok, exitCode: 2, stderr: 'x' })).toEqual({
				action: 'continue',
			})
		}
	})
})

describe('through createShellHook', () => {
	async function run(
		event: ShellHookEvent,
		matcher: string | undefined,
		fields: Partial<PluginHookContext>,
	) {
		const directory = mkdtempSync(join(tmpdir(), 'namzu-lifecycle-events-'))
		dirs.push(directory)
		const out = join(directory, 'stdin.json')
		const hook = createShellHook(
			event,
			{ command: `cat > '${out}'`, ...(matcher !== undefined ? { matcher } : {}) },
			{ cwd: directory },
		)
		await hook.handler(context(event, fields))
		try {
			return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
		} catch {
			return undefined
		}
	}

	it('a hook runs with the event it was attached to and is sent its fields', async () => {
		const seen = await run('pre_model_switch', undefined, {
			modelSwitch: {
				fromModel: 'a/one',
				toModel: 'b/two',
				requestedModel: null,
				source: 'command',
			},
		})
		expect(seen).toMatchObject({
			event: 'pre_model_switch',
			hook_event_name: 'PreModelSwitch',
			from_model: 'a/one',
			to_model: 'b/two',
			requested_model: null,
			source: 'command',
		})
	})

	it('directory_added reads its matcher against the source', async () => {
		const fields = { directory: '/x', directorySource: 'slash_command' } as const
		expect(await run('directory_added', 'slash_command', fields)).toBeDefined()
		expect(await run('directory_added', 'other', fields)).toBeUndefined()
		expect(await run('directory_added', '*', fields)).toBeDefined()
	})

	it('instructions_loaded reads its matcher against the load reason', async () => {
		const instructions = {
			filePath: '/p/AGENTS.md',
			memoryType: 'Project',
			loadReason: 'session_start',
		} as const
		expect(
			await run('instructions_loaded', 'session_start|include', { instructions }),
		).toBeDefined()
		expect(await run('instructions_loaded', 'compact', { instructions })).toBeUndefined()
	})

	it('a teammate event reads its matcher against the teammate name', async () => {
		const fields = { teammateName: 'writer', teamName: 'team-ab12' } as const
		expect(await run('teammate_idle', 'writer', fields)).toMatchObject({
			teammate_name: 'writer',
			hook_event_name: 'TeammateIdle',
		})
		expect(await run('teammate_idle', 'reviewer', fields)).toBeUndefined()
		expect(await run('teammate_start', '*', fields)).toBeDefined()
	})

	it('events that name nothing ignore their matcher and fire', async () => {
		expect(await run('task_created', 'anything', { task: { subject: 'S' } })).toMatchObject({
			task_subject: 'S',
		})
		expect(
			await run('elicitation', 'anything', { elicitation: { serverName: 's', message: 'm' } }),
		).toMatchObject({ mcp_server_name: 's' })
	})
})
