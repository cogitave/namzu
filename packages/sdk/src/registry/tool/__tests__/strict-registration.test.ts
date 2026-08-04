import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ToolDefinition } from '../../../types/tool/index.js'
import { ToolRegistry } from '../execute.js'

/**
 * A tool that asks for constrained generation and hands over a schema the
 * constrained dialect cannot express is wrong at the moment it is DECLARED,
 * whichever model it later meets.
 *
 * The first attempt at this check lived in a provider driver. That caught the
 * bug — but per request, in one of the two drivers that mark tools strict, and
 * only once something actually ran. The registry already refused
 * `enforceModelInput` without a `modelInputSchema`, with a comment stating the
 * principle exactly: "Refusing at registration puts the error where the author
 * can fix it rather than at the first request." The rule was written down; the
 * check was in the wrong place.
 *
 * So the pair is here now. One asks whether a model schema EXISTS, the other
 * whether it can carry the guarantee the tool just requested.
 */

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
	return {
		name: 'sample',
		description: 'a tool',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
		...overrides,
	} as ToolDefinition
}

describe('a tool cannot register a schema its own guarantee cannot carry', () => {
	it('refuses a keyword outside the strict subset, naming the path', () => {
		const registry = new ToolRegistry()

		expect(() =>
			registry.register(
				tool({
					name: 'edit',
					enforceModelInput: true,
					modelInputSchema: {
						type: 'object',
						properties: { insertLine: { oneOf: [{ type: 'integer' }, { const: 'end' }] } },
					},
				}),
			),
		).toThrow(/edit\.properties\.insertLine\.oneOf/)
	})

	it('names the remedy, not just the offence', () => {
		const registry = new ToolRegistry()

		expect(() =>
			registry.register(
				tool({ enforceModelInput: true, modelInputSchema: { properties: { n: { minimum: 0 } } } }),
			),
		).toThrow(/enforce at execution/)
	})

	it('admits the same union spelled the way the subset accepts', () => {
		const registry = new ToolRegistry()

		expect(() =>
			registry.register(
				tool({
					enforceModelInput: true,
					modelInputSchema: {
						type: 'object',
						properties: { insertLine: { anyOf: [{ type: 'integer' }, { const: 'end' }] } },
						additionalProperties: false,
					},
				}),
			),
		).not.toThrow()
	})

	it('leaves a tool that never asked for the guarantee alone', () => {
		// Without `enforceModelInput` nothing is marked strict, so the schema is
		// sent as ordinary JSON Schema and `oneOf` is perfectly legal there.
		// Refusing it would break working setups for no reason.
		const registry = new ToolRegistry()

		expect(() =>
			registry.register(
				tool({ modelInputSchema: { properties: { a: { oneOf: [{ type: 'string' }] } } } }),
			),
		).not.toThrow()
	})

	it('still refuses enforcement with no model schema at all', () => {
		// The check this one was added beside. Kept in the same file so a
		// future edit sees both halves of the pair together.
		const registry = new ToolRegistry()

		expect(() => registry.register(tool({ enforceModelInput: true }))).toThrow(
			/does not define modelInputSchema/,
		)
	})

	it('refuses through every registration shape', () => {
		// `register` has three overloads and only one of them was exercised
		// above; a check on the wrong one would look like coverage.
		const bad = tool({
			name: 'bad',
			enforceModelInput: true,
			modelInputSchema: { properties: { a: { oneOf: [] } } },
		})

		expect(() => new ToolRegistry().register(bad)).toThrow(/oneOf/)
		expect(() => new ToolRegistry().register('bad', bad)).toThrow(/oneOf/)
		expect(() => new ToolRegistry().register([bad])).toThrow(/oneOf/)
	})
})
