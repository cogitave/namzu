import { describe, expect, it } from 'vitest'

import { WORKING_STATE_MIME, mcpToolResultToToolResult } from '../adapter.js'

describe('a working-state resource from an MCP server', () => {
	it('becomes pins on the tool result and not text for the model', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'text', text: 'moved right' },
				{
					type: 'resource',
					resource: {
						uri: 'namzu://working-state',
						mimeType: WORKING_STATE_MIME,
						text: JSON.stringify([{ key: 'piece', text: 'at (39,42)' }, { bad: true }]),
					},
				},
			],
		})
		expect(result.output).toBe('moved right')
		expect(result.workingState).toEqual([{ key: 'piece', text: 'at (39,42)' }])
	})

	it('ignores a resource of that type that is not a JSON array', () => {
		const result = mcpToolResultToToolResult({
			content: [
				{ type: 'resource', resource: { uri: 'x', mimeType: WORKING_STATE_MIME, text: '{nope' } },
			],
		})
		expect(result.workingState).toBeUndefined()
	})
})
