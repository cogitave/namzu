import { describe, expect, it } from 'vitest'

import { parseExecFlags } from '../exec-flags.js'

describe('--mcp-config', () => {
	it('is repeatable and keeps each path', () => {
		const flags = parseExecFlags(['--mcp-config', 'a.json', '--mcp-config=b.json', 'do it'])
		expect(flags.mcpConfigs).toEqual(['a.json', 'b.json'])
		expect(flags.rest).toEqual(['do it'])
		expect(flags.unknown).toEqual([])
	})

	it('is empty by default', () => {
		expect(parseExecFlags(['hello']).mcpConfigs).toEqual([])
	})
})
