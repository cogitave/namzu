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
})
