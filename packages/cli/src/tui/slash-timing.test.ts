import { describe, expect, it } from 'vitest'

import type { UserCommand } from '../user-commands/store.js'
import {
	CLI_LOCAL_COMMANDS,
	kernelCommandDescriptors,
	mergeHostCommands,
	slashTiming,
} from './slashCommands.js'

const builtins = mergeHostCommands(kernelCommandDescriptors())

const userCommand = {
	name: 'standup',
	description: 'Write the stand-up',
	template: 'Write it',
	path: '/tmp/standup.md',
	source: 'user',
} as unknown as UserCommand

describe('which commands run while a reply is being written', () => {
	it.each([
		'/model',
		'/model openai/gpt-5',
		'/effort',
		'/effort high',
		'/status',
		'/cost',
		'/tasks',
		'/bashes',
		'/permissions',
		'/hooks',
		'/mcp',
		'/mcp details',
		'/btw why',
		'/exit',
		'/rename a title',
		'/skills',
		'/skills list',
		'/skills save todo',
		'/skills new a thing',
		'/plugins',
		'/goal',
		'/workflows',
		'/feedback',
		'/help',
		'/theme',
		'/diff',
		'/config limits 5',
		'/add-dir ../other',
		'/browser',
		'/hypermode',
		'/raw',
		'/doctor',
		'/release-notes',
		'/peers',
		'/abandon',
	])('%s runs at once', (line) => {
		expect(slashTiming(line, [], builtins)).toBe('now')
	})

	it.each([
		'/compact',
		'/clear',
		'/new',
		'/fork',
		'/resume',
		'/copy',
		'/run',
		'/fork a title',
		'/resume work',
		'/context',
		'/plan',
		'/memory',
		'/branch',
		'/rewind',
		'/undo',
		'/review',
		'/init',
		'/export',
		'/recap',
		'/login',
		'/logout',
		'/auth',
		'/config',
		'/add-dir',
		'/browser profile work',
		'/skills release',
		'/mcp prompts',
		'/mcp resource srv file:///x',
	])('%s waits for the reply to end', (line) => {
		expect(slashTiming(line, [], builtins)).toBe('queue')
	})

	it('makes a saved prompt command or skill wait', () => {
		expect(slashTiming('/standup now', [userCommand], builtins)).toBe('queue')
	})

	it('runs an unknown name at once, since it only answers that it is unknown', () => {
		expect(slashTiming('/nonesuch', [], builtins)).toBe('now')
	})

	it('is null for text that is not a command', () => {
		expect(slashTiming('fix the build', [], builtins)).toBeNull()
		expect(slashTiming('/', [], builtins)).toBeNull()
	})

	it('classifies every local command one way or the other, never by omission by accident', () => {
		// A new command lands in `queue` unless it says otherwise. Listing the
		// ones that wait here means adding a command forces the decision.
		const waits = new Set([
			'setup',
			'recap',
			'plan',
			'archive',
			'unarchive',
			'branch',
			'worktree',
			'rewind',
			'undo',
			'checkpoint',
			'restore',
			'memory',
			'login',
			'auth',
			'logout',
			'context',
			'review',
			'compact',
			'export',
			'init',
			'clear',
			'new',
			'fork',
			'resume',
			'copy',
			'run',
		])
		for (const command of CLI_LOCAL_COMMANDS) {
			const unspecified = command.immediate === undefined
			expect(unspecified, `/${command.name}`).toBe(waits.has(command.name))
		}
	})
})
