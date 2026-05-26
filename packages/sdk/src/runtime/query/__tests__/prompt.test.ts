import { describe, expect, it, vi } from 'vitest'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import { PromptBuilder } from '../prompt.js'

function makeToolRegistry(): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute: vi.fn(),
		get: vi.fn(() => undefined),
		has: vi.fn(() => false),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
		toPromptSection: vi.fn(() => ''),
		toTierGuidance: vi.fn(() => ''),
	} as unknown as ToolRegistryContract
}

describe('PromptBuilder runtime context', () => {
	it('includes output contract even when no filesystem tool is registered', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a worker.',
			tools: makeToolRegistry(),
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
	})

	it('discloses available skills even when the host supplies a systemPrompt', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a project assistant.',
			tools: makeToolRegistry(),
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
		expect(prompt).toContain('delivery-briefing')
		expect(prompt).toContain('Draft and edit delivery briefings')
		expect(prompt).not.toContain('## Loaded Skills')
	})

	it('includes loaded skill bodies with systemPrompt while preserving the metadata catalogue', () => {
		const prompt = new PromptBuilder({
			systemPrompt: 'You are a cowork supervisor.',
			tools: makeToolRegistry(),
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
		expect(prompt).toContain('license: MIT')
		expect(prompt).toContain('compatibility: Requires file tools')
		expect(prompt).toContain('allowed-tools: read write edit')
		expect(prompt).toContain('## Loaded Skills')
		expect(prompt).toContain('Use skeleton-first writes')
	})
})
