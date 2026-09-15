import { describe, expect, it } from 'vitest'
import { z } from 'zod'

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
import type { TaskScheduler } from '../../../types/agent/scheduler.js'
import type { ComputerUseHost } from '../../../types/computer-use/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { MemoryStore } from '../../../types/memory/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { ToolRegistry } from '../execute.js'
import { findPortableSchemaViolations } from '../portable.js'

/**
 * Every tool this kernel can put in a `tools` block, swept once.
 *
 * This is the test that would have caught the incident. `read.readRange` was a
 * `z.tuple`, which renders as the draft-07 `items: [a, b]`; Zen's Console
 * gateway validates a tool's `parameters` against the JSON Schema 2020-12
 * metaschema, where an array-valued `items` is simply not a schema:
 *
 *     [400] Tool 4 function has invalid 'parameters' schema:
 *     [{'minimum': 1, 'type': 'integer'}, {'minimum': 1, 'type': 'integer'}]
 *     is not of type 'object', 'boolean'
 *
 * The request is rejected whole, so ONE bad field in ONE tool takes down every
 * other tool in the call, and the turn dies before a token is produced. That is
 * why the gate is a sweep over all of them rather than a test beside each one:
 * the blast radius of a single offender is the entire tool surface, and the
 * only useful question is whether ANY tool carries the construct.
 *
 * Two independent checks run over each schema, because neither subsumes the
 * other:
 *
 *  - the **portability profile** (`findPortableSchemaViolations`), which is the
 *    intersection of draft-07 and 2020-12 — narrower than either dialect, and
 *    the thing that makes a driver's dialect conversion unnecessary; and
 *  - the **2020-12 metaschema**, encoded below, which catches a keyword whose
 *    VALUE has the wrong type (`minItems: "two"`) — inside the profile, and
 *    still a 400.
 */

/**
 * The keyword-type rules of the JSON Schema 2020-12 metaschema.
 *
 * Encoded here rather than pulled in as a validator dependency, deliberately:
 * the rules that matter to a tool schema are the ones that say where a
 * SUBSCHEMA may appear and what type each keyword's value takes, and those are
 * a short, stable list. What this does not do is evaluate `$dynamicRef`
 * resolution or format assertions — neither of which a rendered tool schema can
 * reach, since the profile above forbids references outright.
 *
 * The vocabularies covered are core, applicator, validation, meta-data and
 * content, which is the whole of the 2020-12 dialect a `parameters` object is
 * allowed to speak.
 */
const SUBSCHEMA = new Set([
	'additionalProperties',
	'contains',
	'contentSchema',
	'else',
	'if',
	'items',
	'not',
	'propertyNames',
	'then',
	'unevaluatedItems',
	'unevaluatedProperties',
])
const SUBSCHEMA_ARRAY = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SUBSCHEMA_MAP = new Set([
	'$defs',
	'definitions',
	'dependentSchemas',
	'patternProperties',
	'properties',
])
const STRING_ARRAY = new Set(['required'])
const NON_NEGATIVE_INTEGER = new Set([
	'maxContains',
	'maxItems',
	'maxLength',
	'maxProperties',
	'minContains',
	'minItems',
	'minLength',
	'minProperties',
])
const NUMBER = new Set(['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'])
const BOOLEAN = new Set(['deprecated', 'readOnly', 'uniqueItems', 'writeOnly'])
const STRING = new Set([
	'$anchor',
	'$comment',
	'$dynamicAnchor',
	'$dynamicRef',
	'$id',
	'$ref',
	'$schema',
	'contentEncoding',
	'contentMediaType',
	'description',
	'format',
	'pattern',
	'title',
])
const TYPE_NAMES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

function findMetaschemaViolations(node: unknown, path = ''): string[] {
	// A schema is an object or a boolean. That single rule is the one the
	// incident tripped: an ARRAY in a subschema position is neither.
	if (typeof node === 'boolean') return []
	if (typeof node !== 'object' || node === null || Array.isArray(node)) {
		return [`${path || '(root)'} is not of type 'object', 'boolean'`]
	}

	const found: string[] = []
	for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
		const here = path ? `${path}.${keyword}` : keyword
		if (SUBSCHEMA.has(keyword)) {
			found.push(...findMetaschemaViolations(value, here))
		} else if (SUBSCHEMA_ARRAY.has(keyword)) {
			if (!Array.isArray(value) || value.length === 0) {
				found.push(`${here} is not a non-empty array of schemas`)
			} else {
				value.forEach((member, i) =>
					found.push(...findMetaschemaViolations(member, `${here}[${i}]`)),
				)
			}
		} else if (SUBSCHEMA_MAP.has(keyword)) {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				found.push(`${here} is not an object of schemas`)
			} else {
				for (const [name, member] of Object.entries(value as Record<string, unknown>)) {
					found.push(...findMetaschemaViolations(member, `${here}.${name}`))
				}
			}
		} else if (keyword === 'type') {
			const names = Array.isArray(value) ? value : [value]
			if (names.length === 0 || new Set(names).size !== names.length) {
				found.push(`${here} is not a unique, non-empty list of type names`)
			}
			for (const name of names) {
				if (typeof name !== 'string' || !TYPE_NAMES.has(name)) {
					found.push(`${here} names ${JSON.stringify(name)}, which is not a JSON Schema type`)
				}
			}
		} else if (keyword === 'enum') {
			if (!Array.isArray(value)) found.push(`${here} is not an array`)
		} else if (STRING_ARRAY.has(keyword)) {
			if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
				found.push(`${here} is not an array of strings`)
			}
		} else if (NON_NEGATIVE_INTEGER.has(keyword)) {
			if (!Number.isInteger(value) || (value as number) < 0) {
				found.push(`${here} is not a non-negative integer`)
			}
		} else if (NUMBER.has(keyword)) {
			if (typeof value !== 'number') found.push(`${here} is not a number`)
		} else if (BOOLEAN.has(keyword)) {
			if (typeof value !== 'boolean') found.push(`${here} is not a boolean`)
		} else if (STRING.has(keyword)) {
			if (typeof value !== 'string') found.push(`${here} is not a string`)
		}
		// Anything else is an annotation the metaschema does not constrain
		// (`default`, `examples`, a vendor extension). Refusing it here would
		// be an allow-list pretending to be a metaschema.
	}
	return found
}

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
 * A tool left out of this list is a tool this gate does not cover, which is why
 * the list is spelled out rather than discovered: a new builtin has to be added
 * here on purpose, and the count assertion below makes forgetting loud.
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
			workingDirectory: '/tmp/portability',
			allowedAgentIds: ['a-worker'],
			getPlanManager: () => undefined,
			resumeHandler: () => Promise.reject(new Error('not used')),
			runId: '302e1709-cddd-42e2-b4f7-56186ce7faa2' as RunId,
		} as Parameters<typeof buildCoordinatorTools>[0]),
	]
}

/**
 * What a provider driver is actually handed.
 *
 * Through the registry, not through `renderToolSchema` directly: a tool may
 * carry a hand-written `modelInputSchema` instead of a rendered one, and that
 * schema reaches the same `tools` block. Sweeping the rendering alone would
 * have covered the tools least likely to be wrong and skipped the ones written
 * by hand.
 */
function wireSchemas(): { name: string; parameters: Record<string, unknown> }[] {
	const registry = new ToolRegistry()
	const seen = new Set<string>()
	for (const tool of everyShippedTool()) {
		if (seen.has(tool.name)) continue
		seen.add(tool.name)
		registry.register(tool)
	}
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
		expect(schemas.map((s) => s.name)).toContain('computer_use')
	})

	it.each(wireSchemas().map((s) => [s.name, s.parameters] as const))(
		'%s stays inside the draft-07 ∩ 2020-12 profile',
		(_name, parameters) => {
			expect(findPortableSchemaViolations(parameters)).toEqual([])
		},
	)

	it.each(wireSchemas().map((s) => [s.name, s.parameters] as const))(
		'%s validates against the JSON Schema 2020-12 metaschema',
		(_name, parameters) => {
			expect(findMetaschemaViolations(parameters)).toEqual([])
		},
	)
})

describe('the gate itself', () => {
	it('fails on exactly the shape that produced the 400', () => {
		// The schema `read` used to render, verbatim from the captured request
		// body. Without this, a gate that passed would prove only that it
		// cannot fail.
		const asShipped = {
			type: 'object',
			properties: {
				readRange: {
					type: 'array',
					minItems: 2,
					maxItems: 2,
					items: [
						{ type: 'integer', minimum: 1 },
						{ type: 'integer', minimum: 1 },
					],
				},
			},
		}

		expect(findPortableSchemaViolations(asShipped)).toHaveLength(1)
		expect(findPortableSchemaViolations(asShipped)[0]?.path).toBe('properties.readRange.items')
		// And the metaschema check reproduces the vendor's own wording.
		expect(findMetaschemaViolations(asShipped)).toEqual([
			"properties.readRange.items is not of type 'object', 'boolean'",
		])
	})

	it('fails on a keyword whose value has the wrong type, which the profile alone would miss', () => {
		const bad = { type: 'object', properties: { n: { type: 'array', minItems: 'two' } } }

		expect(findPortableSchemaViolations(bad)).toEqual([])
		expect(findMetaschemaViolations(bad)).toEqual([
			'properties.n.minItems is not a non-negative integer',
		])
	})
})
