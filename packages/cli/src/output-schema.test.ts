import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadOutputSchema } from './output-schema.js'
it('loads a native schema and validates output locally', () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-schema-'))
	try {
		const path = join(dir, 'schema.json')
		writeFileSync(
			path,
			JSON.stringify({
				type: 'object',
				properties: { score: { type: 'number' } },
				required: ['score'],
				additionalProperties: false,
			}),
		)
		const output = loadOutputSchema(path)
		expect(output.mode).toBe('native')
		expect(output.schema.safeParse({ score: 1 }).success).toBe(true)
		expect(output.schema.safeParse({ score: 'wrong' }).success).toBe(false)
		writeFileSync(
			path,
			JSON.stringify({
				type: 'object',
				properties: {},
				required: [],
				additionalProperties: false,
				patternProperties: { '^x': { type: 'string' } },
			}),
		)
		expect(() => loadOutputSchema(path)).toThrow('losslessly')
		writeFileSync(path, 'null')
		expect(() => loadOutputSchema(path)).toThrow('JSON Schema object')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
