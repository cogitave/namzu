import { describe, expect, it } from 'vitest'
import { toToolSourceRef } from './types.js'

describe('toToolSourceRef', () => {
	it('projects a non-MCP source down to just id and kind', () => {
		expect(toToolSourceRef({ id: 'plugin:acme', kind: 'plugin', name: 'acme' })).toEqual({
			id: 'plugin:acme',
			kind: 'plugin',
		})
	})

	it('adds server and readOnlyHintTrusted for an mcp_server source', () => {
		const ref = toToolSourceRef(
			{ id: 'mcp:github', kind: 'mcp_server', name: 'GitHub', mcpServer: { name: 'github' } },
			{ readOnlyHintTrusted: true },
		)
		expect(ref).toEqual({
			id: 'mcp:github',
			kind: 'mcp_server',
			server: 'github',
			readOnlyHintTrusted: true,
		})
	})

	it('defaults readOnlyHintTrusted to false for an mcp_server source when omitted', () => {
		const ref = toToolSourceRef({ id: 'mcp:github', kind: 'mcp_server', name: 'GitHub' })
		expect(ref.readOnlyHintTrusted).toBe(false)
	})

	it("reads readOnlyHintTrusted off the source's own mcpServer config when no explicit override is given", () => {
		const ref = toToolSourceRef({
			id: 'mcp:github',
			kind: 'mcp_server',
			name: 'GitHub',
			mcpServer: { name: 'github', readOnlyHintTrusted: true },
		})
		expect(ref.readOnlyHintTrusted).toBe(true)
	})

	it("an explicit mcp override still wins over the source's own mcpServer config", () => {
		const ref = toToolSourceRef(
			{
				id: 'mcp:github',
				kind: 'mcp_server',
				name: 'GitHub',
				mcpServer: { name: 'github', readOnlyHintTrusted: true },
			},
			{ readOnlyHintTrusted: false },
		)
		expect(ref.readOnlyHintTrusted).toBe(false)
	})

	it('falls back to the source name when mcpServer.name is absent', () => {
		const ref = toToolSourceRef({ id: 'mcp:github', kind: 'mcp_server', name: 'GitHub' })
		expect(ref.server).toBe('GitHub')
	})
})
