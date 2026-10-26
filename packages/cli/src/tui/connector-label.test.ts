import { expect, it } from 'vitest'

import { connectorToolLabel } from './connector-label.js'

it('names a connector tool by its server and tool, not by the name the model calls', () => {
	expect(connectorToolLabel('mcp__slack__post')).toBe('slack · post')
	expect(connectorToolLabel('mcp__my-server__list__items')).toBe('my-server · list__items')
})

it('leaves every other name as it came', () => {
	expect(connectorToolLabel('bash')).toBe('bash')
	expect(connectorToolLabel('mcp__slack')).toBe('mcp__slack')
	expect(connectorToolLabel('mcp____x')).toBe('mcp____x')
})
