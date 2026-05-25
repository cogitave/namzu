import { describe, expect, it } from 'vitest'
import { EditTool } from '../edit.js'
import { getBuiltinTools } from '../index.js'
import { WriteFileTool } from '../write-file.js'

describe('filesystem tool payload budgeting', () => {
	it('does not hard-fail oversized write/edit payloads at schema validation', () => {
		const oversized = 'x'.repeat(12_500)

		expect(() =>
			WriteFileTool.inputSchema.parse({ path: 'outputs/long.md', content: oversized }),
		).not.toThrow()
		expect(() =>
			EditTool.inputSchema.parse({
				path: 'outputs/long.md',
				oldStr: '{{SECTION}}',
				newStr: oversized,
				replace_all: false,
			}),
		).not.toThrow()
	})

	it('keeps append out of the default builtin toolset', () => {
		const names = getBuiltinTools().map((tool) => tool.name)

		expect(names).toContain('edit')
		expect(names).not.toContain('append')
	})
})
