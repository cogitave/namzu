import { describe, expect, it } from 'vitest'

import {
	shellHookIfMatches,
	shellHookIfProblem,
	shellHookMatcherProblem,
	shellHookMatches,
} from '../shell-hook.js'
import { toolNamesFromSource } from './tool-names-from-source.js'

/**
 * The matchers people write, against every tool name the SDK defines (read
 * from the source) and three tool-server tools: what fires for each. This
 * table is the statement of what a matcher means; `docs/sdk/hooks.md` quotes
 * it.
 */

const SERVER_TOOLS = [
	'mcp__github__get_issue',
	'mcp__github__create_pr',
	'mcp__slack__post_message',
]
const UNIVERSE = [...toolNamesFromSource(), ...SERVER_TOOLS]

const TABLE: readonly (readonly [string, 'all' | readonly string[]])[] = [
	['', 'all'],
	[' ', 'all'],
	['*', 'all'],
	['.*', 'all'],
	['Bash', ['bash']],
	['bash', ['bash']],
	['BASH', ['bash']],
	['Edit|Write', ['edit', 'write']],
	['Edit,Write', ['edit', 'write']],
	['Edit | Write', ['edit', 'write']],
	['MultiEdit', ['edit']],
	['Read|Grep|Glob|LS', ['glob', 'grep', 'ls', 'read']],
	['Web*', ['web_fetch', 'web_search']],
	['WebFetch', ['web_fetch']],
	['web_fetch', ['web_fetch']],
	['Task', ['Agent', 'create_task']],
	['Agent', ['Agent', 'create_task']],
	['agent*', ['Agent', 'agent_task_list', 'create_task']],
	['Agent|Task', ['Agent', 'create_task']],
	['^(Edit|Write)$', ['edit', 'write']],
	['^(edit|write)$', ['edit', 'write']],
	['(Edit|Write)', ['edit', 'write']],
	['Edit|Write|NotebookEdit', ['edit', 'write']],
	['mcp__.*', ['mcp__github__get_issue', 'mcp__github__create_pr', 'mcp__slack__post_message']],
	['mcp__github__.*', ['mcp__github__get_issue', 'mcp__github__create_pr']],
	['mcp__github__*', ['mcp__github__get_issue', 'mcp__github__create_pr']],
	['mcp__github', ['mcp__github__get_issue', 'mcp__github__create_pr']],
	['mcp__slack__post_message', ['mcp__slack__post_message']],
	['mcp__.*__post_message', ['mcp__slack__post_message']],
	['mcp__*__get_issue', ['mcp__github__get_issue']],
	['mcp__*', ['mcp__github__get_issue', 'mcp__github__create_pr', 'mcp__slack__post_message']],
	['.*Edit.*', ['edit']],
	['Notebook', []],
	['(unclosed', 'all'],
	['[', 'all'],
	['^bash$', ['bash']],
	['^Bash$', ['bash']],
	['^read', ['read', 'read_memory']],
	['read', ['read']],
	['Bash.*', ['bash', 'job']],
	['task_*', ['task_create', 'task_list', 'task_update']],
	['*_task', ['cancel_task', 'continue_task', 'create_task', 'hand_back_task', 'wait_for_task']],
	['Read|mcp__github__.*', ['read', 'mcp__github__get_issue', 'mcp__github__create_pr']],
	['Skill', ['skill']],
	['AskUserQuestion', ['ask_user_question']],
	['ViewImage', ['view_image']],
	['KillShell', ['job']],
	['TaskStop', ['job']],
	['ToolSearch', ['search_tools']],
	['TodoWrite', []],
	['Browser*', ['browser', 'browser_act']],
	['computer_use|browser', ['browser', 'computer_use']],
	['Bash(git push *)', []],
]

describe('what a matcher fires for, against every tool name', () => {
	it('covers at least forty matchers and every name the SDK defines', () => {
		expect(TABLE.length).toBeGreaterThanOrEqual(40)
		expect(UNIVERSE.length).toBeGreaterThan(50)
	})

	for (const [matcher, expected] of TABLE) {
		it(`${JSON.stringify(matcher)}`, () => {
			const fired = UNIVERSE.filter((name) => shellHookMatches(matcher, name, { tool: true }))
			expect(fired).toEqual(expected === 'all' ? UNIVERSE : [...expected])
		})
	}
})

describe('a matcher that cannot be read', () => {
	it('fires for every name, and is reported as unreadable', () => {
		for (const bad of ['(unclosed', '[', 'a(b', '*+']) {
			expect(shellHookMatcherProblem(bad)).toContain('cannot be read')
			expect(shellHookMatches(bad, 'bash', { tool: true })).toBe(true)
		}
	})

	it('reports nothing for a matcher that reads', () => {
		for (const good of ['', '*', 'Bash', 'Edit|Write', '^(Edit|Write)$', 'mcp__.*', 'mcp__*__x']) {
			expect(shellHookMatcherProblem(good)).toBeUndefined()
		}
	})
})

describe('a name that is not a tool takes no tool aliases', () => {
	it('keeps `Task` from standing for the sub-agent tool on a notification type', () => {
		expect(shellHookMatches('Task', 'Agent', { tool: false })).toBe(false)
		expect(shellHookMatches('agent', 'Agent', { tool: false })).toBe(true)
	})
})

describe('an if names a tool by every spelling a matcher takes', () => {
	const names = [...UNIVERSE]
	const cases: readonly [string, string, boolean][] = [
		['Agent', 'Agent', true],
		['agent', 'Agent', true],
		['Task', 'Agent', true],
		['Agent(research *)', 'Agent', true],
		['Task', 'create_task', true],
		['Agent', 'create_task', true],
		['Edit|Write', 'write', true],
		['Edit,Write', 'edit', true],
		['Edit|Write', 'read', false],
		['MultiEdit', 'edit', true],
		['Web*', 'web_search', true],
		['WebFetch', 'web_fetch', true],
		['ViewImage', 'view_image', true],
		['KillShell', 'job', true],
		['mcp__github', 'mcp__github__get_issue', true],
		['mcp__github__*', 'mcp__github__get_issue', true],
		['mcp__*__get_issue', 'mcp__github__get_issue', true],
		['mcp__github__*', 'mcp__slack__post_message', false],
		['mcp__slack__post_message', 'mcp__slack__post_message', true],
		['*', 'bash', true],
		['Bash', 'read', false],
	]
	for (const [filter, tool, fires] of cases) {
		it(`${JSON.stringify(filter)} on ${tool} ${fires ? 'runs' : 'does not run'}`, () => {
			expect(names.includes(tool)).toBe(true)
			expect(shellHookIfMatches(filter, tool, { command: 'x', path: 'a' })).toBe(fires)
		})
	}

	it('reports an if that is not Tool or Tool(pattern), and runs it', () => {
		expect(shellHookIfProblem('^Edit$')).toContain('cannot be read')
		expect(shellHookIfProblem('Edit(src/**)')).toBeUndefined()
		expect(shellHookIfMatches('^Edit$', 'bash', {})).toBe(true)
	})
})
