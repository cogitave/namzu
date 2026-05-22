import { describe, expect, it } from 'vitest'
import { AppendFileTool } from '../append-file.js'
import { EditTool } from '../edit.js'
import { WriteFileTool } from '../write-file.js'

describe('filesystem tool payload budgeting', () => {
	it('does not hard-fail oversized write/edit/append payloads at schema validation', () => {
		const oversized = 'x'.repeat(12_500)

		expect(() =>
			WriteFileTool.inputSchema.parse({ path: 'outputs/long.md', content: oversized }),
		).not.toThrow()
		expect(() =>
			AppendFileTool.inputSchema.parse({ path: 'outputs/long.md', content: oversized }),
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
})
