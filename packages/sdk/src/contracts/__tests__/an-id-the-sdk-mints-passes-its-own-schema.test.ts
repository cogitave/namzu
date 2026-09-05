import { describe, expect, it } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'

import {
	asMessageId,
	asProjectId,
	asRunId,
	generateMessageId,
	generateProjectId,
	generateRunId,
} from '../../utils/id.js'
import { MessageIdSchema, ProjectIdSchema, RunIdSchema } from '../schemas.js'

const contracts = [
	{
		name: 'project',
		schema: ProjectIdSchema,
		generate: generateProjectId,
		parse: asProjectId,
		prefix: 'prj_',
	},
	{
		name: 'run',
		schema: RunIdSchema,
		generate: generateRunId,
		parse: asRunId,
		prefix: 'run_',
	},
	{
		name: 'message',
		schema: MessageIdSchema,
		generate: generateMessageId,
		parse: asMessageId,
		prefix: 'msg_',
	},
]

describe('id schemas use the same spelling contract as constructors', () => {
	it.each(contracts)(
		'$name retains its spelling constraints in JSON Schema',
		({ schema, generate, prefix }) => {
			const json = zodToJsonSchema(schema)
			if (!('pattern' in json) || typeof json.pattern !== 'string') {
				throw new Error('The id schema must export its spelling pattern')
			}
			const pattern = new RegExp(json.pattern)
			const id = generate()
			expect(pattern.test(id)).toBe(true)
			expect(pattern.test(`${prefix}Selected-A_1`)).toBe(true)
			expect(pattern.test(`${id}\n`)).toBe(false)
			expect(pattern.test(`${prefix}../outside`)).toBe(false)
			// Existing callers can keep composing the exported ZodString schema.
			expect(schema.min(1).parse(id)).toBe(id)
		},
	)

	it.each(contracts)(
		'$name accepts minted and established safe ids unchanged',
		({ schema, generate, parse, prefix }) => {
			const accepted = [
				...Array.from({ length: 20 }, () => generate()),
				`${prefix}selected`,
				`${prefix}Selected-A_1`,
				'550E8400-E29B-41D4-A716-446655440000',
			]
			for (const id of accepted) {
				expect(schema.parse(id)).toBe(id)
				expect(parse(id)).toBe(id)
			}
		},
	)

	it.each(contracts)(
		'$name refuses invalid segments and mismatched legacy kinds',
		({ schema, parse, prefix }) => {
			const refused = [
				`${prefix}../../etc`,
				`${prefix}..`,
				`${prefix}a/b`,
				`${prefix}a\\b`,
				prefix,
				`${prefix}a b`,
				`${prefix}a\n`,
				`${prefix}a\0b`,
				'550e8400-e29b-41d4-a716-446655440000\n',
				'proj_abc',
				'thd_abc',
				'top_abc',
				'',
			]
			for (const id of refused) {
				expect(schema.safeParse(id).success, id).toBe(false)
				expect(() => parse(id), id).toThrow()
			}
		},
	)
})
