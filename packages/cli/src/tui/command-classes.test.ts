import { describe, expect, it } from 'vitest'

import { listedModelRun, modelRunOf } from './model-run.js'
import { CLI_LOCAL_COMMANDS, kernelCommandDescriptors, mergeHostCommands } from './slashCommands.js'

const every = mergeHostCommands(kernelCommandDescriptors(), CLI_LOCAL_COMMANDS)

const names = (cls: 'run' | 'confirm' | 'never') =>
	every
		.filter((command) => listedModelRun(command.modelRun) === cls)
		.map((command) => command.name)
		.sort()

describe('what the model may do with each slash command', () => {
	it('makes every registered command declare a class', () => {
		const undeclared = every.filter((command) => command.modelRun === undefined)
		expect(undeclared.map((command) => command.name)).toEqual([])
		for (const command of kernelCommandDescriptors()) {
			expect(command.modelRun, `kernel command /${command.name}`).toBeDefined()
		}
	})

	it('holds the agreed split', () => {
		expect(names('run')).toEqual(
			[
				'bashes',
				'context',
				'copy',
				'cost',
				'diff',
				'doctor',
				'help',
				'hooks',
				'mcp',
				'release notes',
				'status',
				'tasks',
				'workflows',
			].sort(),
		)
		expect(names('confirm')).toEqual(
			[
				'abandon',
				'branch',
				'btw',
				'checkpoint',
				'clear',
				'compact',
				'effort',
				'export',
				'fast',
				'fork',
				'goal',
				'hypermode',
				'init',
				'loop',
				'memory',
				'model',
				'new',
				'orchestrate',
				'plan',
				'raw',
				'recap',
				'rename',
				'restore',
				'resume',
				'review',
				'rewind',
				'schedule',
				'skills',
				'theme',
				'tui',
				'ultrafast',
				'undo',
				'vim',
				'worktree',
			].sort(),
		)
		expect(names('never')).toEqual(
			[
				'add dir',
				'archive',
				'auth',
				'browser',
				'config',
				'exit',
				'feedback',
				'login',
				'logout',
				'peers',
				'permissions',
				'plugin',
				'plugins',
				'settings',
				'setup',
				'team',
				'terminal setup',
				'unarchive',
			].sort(),
		)
	})

	it('puts fast and ultrafast side by side, asked first', () => {
		const fast = every.find((command) => command.name === 'fast')
		const ultra = every.find((command) => command.name === 'ultrafast')
		expect(modelRunOf(fast?.modelRun, [])).toBe('confirm')
		expect(modelRunOf(ultra?.modelRun, [])).toBe('confirm')
	})

	it('lets a command read freely and ask before it changes anything', () => {
		const of = (name: string, ...args: string[]) =>
			modelRunOf(every.find((command) => command.name === name)?.modelRun, args)
		expect(of('tasks', 'list')).toBe('run')
		expect(of('tasks')).toBe('never')
		expect(of('schedule')).toBe('run')
		expect(of('schedule', 'list')).toBe('run')
		expect(of('schedule', 'add', 'daily', '"9am"', 'read-only', 'check')).toBe('confirm')
		expect(of('schedule', 'remove', 'x')).toBe('confirm')
		expect(of('loop', 'list')).toBe('run')
		expect(of('loop', '5m', 'check')).toBe('confirm')
		expect(of('goal', 'status')).toBe('run')
		expect(of('goal', 'write', 'the', 'changelog')).toBe('confirm')
		expect(of('goal', 'clear')).toBe('confirm')
		expect(of('goal')).toBe('never')
		expect(of('goal', 'set')).toBe('never')
		expect(of('memory', 'list')).toBe('run')
		expect(of('memory', 'add', 'x')).toBe('confirm')
		expect(of('skills', 'list')).toBe('run')
		expect(of('mcp')).toBe('run')
		expect(of('mcp', 'resource', 's', 'u')).toBe('confirm')
		expect(of('effort')).toBe('run')
		expect(of('effort', 'high')).toBe('confirm')
		expect(of('model')).toBe('never')
		expect(of('model', 'x')).toBe('confirm')
		expect(of('tui')).toBe('run')
		expect(of('tui', 'fullscreen')).toBe('confirm')
		expect(of('theme')).toBe('run')
		expect(of('theme', 'light')).toBe('confirm')
		expect(of('vim', 'on')).toBe('confirm')
		expect(of('vim')).toBe('confirm')
		expect(of('raw', 'on')).toBe('confirm')
		expect(of('rename', 'x')).toBe('confirm')
		expect(of('rename', 'clear')).toBe('confirm')
		expect(of('rename')).toBe('never')
	})

	it('treats a command that declares nothing as never', () => {
		expect(modelRunOf(undefined, [])).toBe('never')
		expect(listedModelRun(undefined)).toBe('never')
	})
})
