import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Toolset } from '../../../toolsets/types.js'
import { deferred, filtered } from '../../../toolsets/wrappers.js'
import { PromptBuilder } from '../prompt.js'

function manager(toolsets: readonly Toolset[] = []): ToolManager {
	return new ToolManager({ toolsets, messages: () => [] })
}

describe('PromptBuilder runtime context', () => {
	it('includes output contract even when no filesystem tool is registered', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a worker.',
			tools: manager(),
			runtimeContext: {
				label: 'test runtime',
				outputDirectory: 'outputs/',
				outputFileMarker: 'OUTPUT_FILE: <filename> - <description>',
				notes: ['Register generated files after the turn.'],
			},
		}).build('full', '/tmp/work')

		expect(prompt).toContain('Runtime: test runtime')
		expect(prompt).toContain('Working directory: /tmp/work')
		expect(prompt).toContain('Output directory: outputs/')
		expect(prompt).toContain('OUTPUT_FILE: <filename> - <description>')
		expect(prompt).toContain('Register generated files after the turn.')
		expect(prompt).not.toContain('glob')
	})

	it('discloses available skills even when the host supplies a systemPrompt', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a project assistant.',
			tools: manager(),
			skills: [
				{
					metadata: {
						name: 'delivery-briefing',
						description: 'Draft and edit delivery briefings from grounded inputs.',
					},
					dirPath: '/repo/.agents/skills/delivery-briefing',
				},
			],
		}).build('full', '/tmp/work')

		expect(prompt).toContain('You are a project assistant.')
		expect(prompt).toContain('## Available Skills')
		expect(prompt).toContain('<available_skills>')
		expect(prompt).toContain('delivery-briefing')
		expect(prompt).toContain('Draft and edit delivery briefings')
		expect(prompt).toContain('<location>/repo/.agents/skills/delivery-briefing/SKILL.md</location>')
		expect(prompt).toContain('The following block is a manifest')
		expect(prompt).not.toContain('## Loaded Skills')
	})

	it('includes loaded skill bodies with systemPrompt while preserving the metadata catalogue', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a supervisor.',
			tools: manager(),
			skills: [
				{
					metadata: {
						name: 'structured-file-authoring',
						description: 'Create structured files with bounded edit chunks.',
						license: 'MIT',
						compatibility: 'Requires file tools',
						allowedTools: 'read write edit',
					},
					body: 'Use skeleton-first writes and bounded edit chunks.',
					dirPath: '/repo/.agents/skills/structured-file-authoring',
				},
			],
		}).build('full', '/tmp/work')

		expect(prompt).toContain('## Available Skills')
		expect(prompt).toContain('<license>MIT</license>')
		expect(prompt).toContain('<compatibility>Requires file tools</compatibility>')
		// Named for what it does: a pre-approval, never a whitelist.
		expect(prompt).toContain('<pre_approved_tools>read write edit</pre_approved_tools>')
		expect(prompt).not.toContain('<allowed_tools>')
		expect(prompt).toContain('It never limits which tools you may use')
		expect(prompt).toContain('read the SKILL.md at its <location> before writing code')
		expect(prompt).toContain('## Loaded Skills')
		expect(prompt).toContain('Use skeleton-first writes')
	})
})

describe.each(['flat', 'segmented'] as const)('%s prompt file discovery', (format) => {
	function build(tools: ToolManager, allowedTools?: string[]): string {
		const builder = new PromptBuilder({ tools, allowedTools })
		return format === 'flat'
			? builder.build('full', '/workspace/project')
			: builder.buildSegmented('full', '/workspace/project').dynamic
	}

	function fileTool(name: string) {
		return {
			name,
			description: 'Access project files',
			inputSchema: z.object({}),
			category: 'filesystem' as const,
			execute: async () => ({ success: true, output: '' }),
		}
	}

	it('reads known paths directly and reserves recursive discovery for the task', () => {
		const tools = manager([testToolset(fileTool('read_file'), fileTool('glob'))])
		const prompt = build(tools)

		expect(prompt).toContain('Working directory: /workspace/project')
		expect(prompt).toContain('Resolve relative paths against the working directory')
		expect(prompt).toContain('use supplied absolute paths as given')
		expect(prompt).toContain('read known file paths directly')
		expect(prompt).toContain('targeted directories and patterns')
		expect(prompt).toContain("immediate directory overview, use glob with pattern '*'")
		expect(prompt).toContain("Use '**' only when recursive discovery is needed")
		expect(prompt).toContain(
			'do not recursively inventory unrelated home directories or cache trees',
		)
		expect(prompt).not.toContain('Before reading a file, use the glob tool')
	})

	it.each(['absent', 'disallowed', 'filtered', 'deferred'] as const)(
		'does not prescribe glob when it is %s',
		(state) => {
			const glob = testToolset(fileTool('glob'))
			const tools = manager([
				testToolset(fileTool('read_file')),
				...(state === 'absent'
					? []
					: [
							state === 'deferred'
								? deferred(glob)
								: state === 'filtered'
									? filtered(glob, () => false)
									: glob,
						]),
			])
			const prompt = build(tools, state === 'disallowed' ? ['read_file'] : undefined)
			const guidance = prompt.split('</env>')[1] ?? ''

			expect(prompt).toContain('Working directory: /workspace/project')
			expect(guidance).toContain('read known file paths directly')
			expect(guidance).toContain('available directory listing tool')
			expect(guidance).not.toMatch(/\bglob\b/)
		},
	)
})
