import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { testToolset } from '../../../test-support/toolset.js'
import {
	BashTool,
	EditTool,
	GlobTool,
	GrepTool,
	JobTool,
	LsTool,
	LspTool,
	ReadFileTool,
	SearchToolsTool,
	SkillTool,
	VerifyOutputsTool,
	WaitForJobTool,
	WebFetchTool,
	WebSearchTool,
	WriteFileTool,
	buildRunCodeTool,
	createComputerUseTool,
	createStructuredOutputTool,
	getBuiltinTools,
} from '../../../tools/builtins/index.js'
import { buildCoordinatorTools } from '../../../tools/coordinator/index.js'
import { buildMemoryTools } from '../../../tools/memory/index.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { TaskScheduler } from '../../../types/agent/scheduler.js'
import type { ComputerUseHost } from '../../../types/computer-use/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { MemoryStore } from '../../../types/memory/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { findUndescribedProperties } from '../portable.js'

/**
 * Every tool this kernel can put in a `tools` block, swept once, for a
 * property with no `description`.
 *
 * `defineTool` requires a tool-level `description` but nothing requires one
 * per Zod field, so a field missing `.describe()` reaches the model with no
 * account of what it is for — the convention exists today by author
 * discipline (58 `.describe()` calls across `tools/builtins/*.ts` at the time
 * this test was written) and nothing enforced it. Built the same way as
 * `every-shipped-tool-schema-is-portable.test.ts`, its sibling sweep: one
 * offender's blast radius is the tool it sits on, not the whole surface (a
 * missing description is a quality defect, not a 400 like a non-portable
 * schema), but the only useful question is still whether ANY shipped tool
 * carries one, so this runs as a sweep rather than a test beside each tool.
 */

function unusedStore(): MemoryStore {
	const refuse = () => Promise.reject(new Error('not used'))
	return {
		create: refuse,
		get: refuse,
		update: refuse,
		delete: refuse,
		list: refuse,
	} as unknown as MemoryStore
}

function unusedGateway(): TaskScheduler {
	return {
		createTask: () => Promise.reject(new Error('not used')),
		waitForTask: () => Promise.reject(new Error('not used')),
		continueTask: () => Promise.resolve(),
		cancelTask() {},
		getTask: () => undefined,
		listTasks: () => [],
		onTaskCompleted: () => () => {},
	} as unknown as TaskScheduler
}

function unusedDesktop(): ComputerUseHost {
	return {
		id: 'stub',
		capabilities: {
			displayServer: 'x11',
			screenshot: true,
			cursorPosition: true,
			mouse: true,
			keyboard: true,
		},
		getDisplayGeometry: () => Promise.reject(new Error('not used')),
		execute: () => Promise.reject(new Error('not used')),
	} as unknown as ComputerUseHost
}

/**
 * Every tool the SDK ships, including the ones that are not in the default
 * builtin set and the ones only a configured host registers.
 *
 * A tool left out of this list is a tool this gate does not cover, which is
 * why the list is spelled out rather than discovered — see the sibling
 * portability sweep for the same reasoning.
 */
function everyShippedTool(): ToolDefinition[] {
	return [
		...getBuiltinTools(),
		BashTool,
		EditTool,
		GlobTool,
		GrepTool,
		JobTool,
		ReadFileTool,
		VerifyOutputsTool,
		WaitForJobTool,
		WriteFileTool,
		LsTool,
		SearchToolsTool,
		SkillTool,
		WebFetchTool,
		WebSearchTool,
		LspTool,
		buildRunCodeTool(),
		createComputerUseTool(unusedDesktop()),
		createStructuredOutputTool(z.object({ answer: z.string().describe('The answer') })),
		...buildMemoryTools(unusedStore()),
		...buildCoordinatorTools({
			gateway: unusedGateway(),
			workingDirectory: '/tmp/description-coverage',
			allowedAgentIds: ['a-worker'],
			getPlanManager: () => undefined,
			resumeHandler: () => Promise.reject(new Error('not used')),
			sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
			turnId: '302e1709-cddd-42e2-b4f7-56186ce7faa2' as TurnId,
		} as Parameters<typeof buildCoordinatorTools>[0]),
	]
}

/**
 * What a provider driver is actually handed. Through the registry, not
 * `renderToolSchema` directly, for the reason the portability sweep gives:
 * a tool may carry a hand-written `modelInputSchema` instead of a rendered
 * one, and that schema reaches the same `tools` block.
 */
function wireSchemas(): { name: string; parameters: Record<string, unknown> }[] {
	const seen = new Set<string>()
	const tools: ToolDefinition[] = []
	for (const tool of everyShippedTool()) {
		if (seen.has(tool.name)) continue
		seen.add(tool.name)
		tools.push(tool)
	}
	const registry = new ToolManager({ toolsets: [testToolset(...tools)], messages: () => [] })
	return registry.toLLMTools().map((tool) => ({
		name: tool.function.name,
		parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
	}))
}

describe('every tool schema the kernel emits', () => {
	const schemas = wireSchemas()

	it('covers the whole shipped surface', () => {
		// A floor, not an equality: a new tool should raise this, and a tool
		// silently dropping out of the sweep should fail it.
		expect(schemas.length).toBeGreaterThanOrEqual(30)
		expect(schemas.map((s) => s.name)).toContain('read')
	})

	it.each(wireSchemas().map((s) => [s.name, s.parameters] as const))(
		'%s describes every field',
		(name, parameters) => {
			const violations = findUndescribedProperties(parameters)
			expect(violations, `${name}: ${violations.map((v) => v.path).join(', ')}`).toEqual([])
		},
	)
})

describe('the gate itself', () => {
	it('finds a top-level property with no description', () => {
		const schema = {
			type: 'object',
			properties: {
				described: { type: 'string', description: 'has one' },
				bare: { type: 'string' },
			},
		}
		expect(findUndescribedProperties(schema)).toEqual([{ path: 'properties.bare' }])
	})

	it('finds a nested property, at any depth', () => {
		const schema = {
			type: 'object',
			properties: {
				outer: {
					type: 'object',
					description: 'the outer object',
					properties: {
						inner: { type: 'string' },
					},
				},
			},
		}
		expect(findUndescribedProperties(schema)).toEqual([
			{ path: 'properties.outer.properties.inner' },
		])
	})

	it('does not demand a description on each element of an array, only on the array itself', () => {
		const schema = {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					description: 'a list',
					items: { type: 'string' },
				},
			},
		}
		expect(findUndescribedProperties(schema)).toEqual([])
	})

	it('treats an empty-string description the same as a missing one', () => {
		const schema = { type: 'object', properties: { n: { type: 'string', description: '' } } }
		expect(findUndescribedProperties(schema)).toEqual([{ path: 'properties.n' }])
	})
})
