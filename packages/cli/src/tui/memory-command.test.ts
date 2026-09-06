import { describe, expect, it } from 'vitest'

import { type SlashContext, runSlash } from './slashCommands.js'

const context: SlashContext = {
	cwd: '/workspace/current',
	compaction: null,
	jobs: () => [],
	availableTools: () => [],
	sandbox: null,
	mcp: () => null,
	lastAssistantMessageId: () => null,
	providerSummary: null,
	modelSummary: null,
	usage: null,
	permissions: {
		currentMode: () => ({ mode: 'prompt', source: 'default' }),
		rules: [],
		approvalLatched: () => false,
		neverPrompted: () => [],
	},
	instructionFiles: [],
	userCommands: [],
	configDebug: null,
	reasoningEffort: { current: () => undefined, levels: undefined },
}

describe('/memory dispatch', () => {
	it.each([
		'/memory',
		'/memory show',
		'/memory list',
		'/memory SHOW',
		'/memory LiSt',
		'/memory --user',
		'/memory --user show',
		'/memory --user LIST',
		'  /memory   show  ',
	])('%s inspects memory without dispatching a write', (command) => {
		expect(runSlash(command, context)).toEqual({ kind: 'show-memory' })
	})

	it.each([
		['/memory add Use pnpm for tests', 'Use pnpm for tests', 'project'],
		['/memory ADD Keep Case', 'Keep Case', 'project'],
		['/memory --user add Keep Case', 'Keep Case', 'user'],
		['/memory add show', 'show', 'project'],
		['/memory add list', 'list', 'project'],
		['/memory add add', 'add', 'project'],
	])('%s explicitly saves the supplied fact', (command, text, scope) => {
		expect(runSlash(command, context)).toEqual({
			kind: 'remember',
			text,
			scope,
		})
	})

	it.each(['/memory add', '/memory ADD', '/memory --user add'])(
		'%s shows usage without dispatching a write',
		(command) => {
			expect(runSlash(command, context)).toEqual({
				kind: 'message',
				role: 'system',
				content:
					'Usage: /memory add <text> or /memory --user add <text>. /memory show displays saved memory.',
			})
		},
	)

	it.each([
		['/memory Use pnpm for tests', 'Use pnpm for tests', 'project'],
		['/memory --user Keep Case', 'Keep Case', 'user'],
		['/memory show errors clearly', 'show errors clearly', 'project'],
		['/memory list dependencies here', 'list dependencies here', 'project'],
	])('%s preserves an existing free-text save', (command, text, scope) => {
		expect(runSlash(command, context)).toEqual({
			kind: 'remember',
			text,
			scope,
		})
	})
})
