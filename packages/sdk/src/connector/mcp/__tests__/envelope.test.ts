import { describe, expect, it } from 'vitest'

import {
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
} from '../../../constants/mcp/index.js'
import { buildEnvelope, encodeMcpHeaderValue } from '../envelope.js'

/**
 * The envelope is where a modern request's whole wire format is decided:
 * the `_meta` a server requires, and the headers that mirror it for an
 * intermediary that will not parse JSON-RPC.
 *
 * It is a pure function specifically so this file needs no server, no
 * socket and no transport to state what goes on the wire.
 */

const MODERN = { kind: 'modern', version: '2026-07-28' } as const
const CLIENT_INFO = { name: 'namzu-sdk', version: '1.2.3' }

describe('a modern request carries the _meta a server requires', () => {
	it('sets protocolVersion, clientCapabilities and clientInfo', () => {
		const envelope = buildEnvelope({
			era: MODERN,
			method: 'tools/list',
			params: {},
			clientInfo: CLIENT_INFO,
			capabilities: {},
		})

		expect(envelope.params?._meta).toEqual({
			[MCP_META_PROTOCOL_VERSION]: '2026-07-28',
			[MCP_META_CLIENT_CAPABILITIES]: {},
			[MCP_META_CLIENT_INFO]: CLIENT_INFO,
		})
	})

	it('still declares empty capabilities rather than omitting the key', () => {
		// REQUIRED even when there is nothing to declare: an absent key is
		// not the same claim as "this client can do nothing", and a server
		// reads it to decide what it may ask for.
		const envelope = buildEnvelope({ era: MODERN, method: 'tools/list' })
		const meta = envelope.params?._meta as Record<string, unknown>

		expect(Object.hasOwn(meta, MCP_META_CLIENT_CAPABILITIES)).toBe(true)
		expect(meta[MCP_META_CLIENT_CAPABILITIES]).toEqual({})
	})

	it('omits clientInfo when the caller supplied none — it is a SHOULD, not a MUST', () => {
		const envelope = buildEnvelope({ era: MODERN, method: 'tools/list' })
		const meta = envelope.params?._meta as Record<string, unknown>

		expect(Object.hasOwn(meta, MCP_META_CLIENT_INFO)).toBe(false)
	})

	it('keeps the caller-supplied params and any _meta they already carried', () => {
		const envelope = buildEnvelope({
			era: MODERN,
			method: 'tools/call',
			params: { name: 'create', arguments: { title: 'Bug' }, _meta: { 'acme/trace': 'abc' } },
			capabilities: {},
		})

		expect(envelope.params?.name).toBe('create')
		expect(envelope.params?.arguments).toEqual({ title: 'Bug' })
		expect((envelope.params?._meta as Record<string, unknown>)['acme/trace']).toBe('abc')
	})
})

describe('the mirrored headers cannot disagree with the body', () => {
	it('writes MCP-Protocol-Version and _meta.protocolVersion from one value', () => {
		// The invariant this whole module exists for. There is no code path
		// that produces one without the other, so a mismatched pair is
		// unconstructible rather than merely validated somewhere.
		const envelope = buildEnvelope({ era: MODERN, method: 'tools/list', capabilities: {} })
		const meta = envelope.params?._meta as Record<string, unknown>

		expect(envelope.headers['MCP-Protocol-Version']).toBe(meta[MCP_META_PROTOCOL_VERSION])
		expect(envelope.headers['MCP-Protocol-Version']).toBe('2026-07-28')
	})

	it('names the method in Mcp-Method', () => {
		expect(buildEnvelope({ era: MODERN, method: 'tools/list' }).headers['Mcp-Method']).toBe(
			'tools/list',
		)
	})

	it('names a tool call in Mcp-Name, from params.name', () => {
		const envelope = buildEnvelope({
			era: MODERN,
			method: 'tools/call',
			params: { name: 'create_issue', arguments: {} },
		})

		expect(envelope.headers['Mcp-Name']).toBe('create_issue')
	})

	it('names a resource read in Mcp-Name, from params.uri', () => {
		const envelope = buildEnvelope({
			era: MODERN,
			method: 'resources/read',
			params: { uri: 'file:///notes.md' },
		})

		expect(envelope.headers['Mcp-Name']).toBe('file:///notes.md')
	})

	it('sends no Mcp-Name for a method that has no target to name', () => {
		expect(buildEnvelope({ era: MODERN, method: 'tools/list' }).headers['Mcp-Name']).toBeUndefined()
	})
})

describe('a header value that cannot go on the wire verbatim is wrapped', () => {
	it('leaves a plain ASCII value alone', () => {
		expect(encodeMcpHeaderValue('create_issue')).toBe('create_issue')
		expect(encodeMcpHeaderValue('file:///notes.md')).toBe('file:///notes.md')
	})

	it('wraps a value carrying non-ASCII bytes', () => {
		const encoded = encodeMcpHeaderValue('café')

		expect(encoded).toBe(`=?base64?${Buffer.from('café', 'utf-8').toString('base64')}?=`)
	})

	it('wraps a value carrying a newline, which would otherwise split the field', () => {
		expect(encodeMcpHeaderValue('a\nb')).toMatch(/^=\?base64\?.*\?=$/)
	})

	it('wraps a plain value that already reads as a sentinel', () => {
		// The case that is easy to miss. Sending this through unwrapped would
		// have the server decode a string the caller meant literally.
		const literal = '=?base64?abc?='
		const encoded = encodeMcpHeaderValue(literal)

		expect(encoded).not.toBe(literal)
		expect(Buffer.from(encoded.slice('=?base64?'.length, -2), 'base64').toString('utf-8')).toBe(
			literal,
		)
	})

	it('treats the marker as case-sensitive: an uppercase lookalike is not a sentinel', () => {
		expect(encodeMcpHeaderValue('=?BASE64?abc?=')).toBe('=?BASE64?abc?=')
	})

	it('wraps a sentinel lookalike whose interior carries a question mark', () => {
		// The spec's rule is "starts with `=?base64?` and ends with `?=`",
		// with nothing said about what lies between. A server applying it
		// literally would try to base64-decode `a?b` out of this value, so
		// this client wraps it rather than sending it verbatim.
		for (const literal of ['=?base64?a?b?=', '=?base64??=', '=?base64?=']) {
			const encoded = encodeMcpHeaderValue(literal)

			expect(encoded).not.toBe(literal)
			expect(Buffer.from(encoded.slice('=?base64?'.length, -2), 'base64').toString('utf-8')).toBe(
				literal,
			)
		}
	})

	it('carries a wrapped tool name through the envelope', () => {
		const envelope = buildEnvelope({
			era: MODERN,
			method: 'tools/call',
			params: { name: 'créer', arguments: {} },
		})

		expect(envelope.headers['Mcp-Name']).toBe(
			`=?base64?${Buffer.from('créer', 'utf-8').toString('base64')}?=`,
		)
	})
})

describe('a legacy request is written exactly as it was before the modern era existed', () => {
	it('adds no _meta and no modern headers', () => {
		const envelope = buildEnvelope({
			era: { kind: 'legacy', version: '2025-11-25' },
			method: 'tools/call',
			params: { name: 'create', arguments: {} },
			clientInfo: CLIENT_INFO,
			capabilities: {},
		})

		expect(envelope.params).toEqual({ name: 'create', arguments: {} })
		expect(envelope.headers['Mcp-Method']).toBeUndefined()
		expect(envelope.headers['Mcp-Name']).toBeUndefined()
	})

	it('sends MCP-Protocol-Version from 2025-06-18 on, and not before', () => {
		const header = (version: '2025-11-25' | '2025-06-18' | '2025-03-26' | '2024-11-05') =>
			buildEnvelope({ era: { kind: 'legacy', version }, method: 'tools/list' }).headers[
				'MCP-Protocol-Version'
			]

		expect(header('2025-11-25')).toBe('2025-11-25')
		expect(header('2025-06-18')).toBe('2025-06-18')
		expect(header('2025-03-26')).toBeUndefined()
		expect(header('2024-11-05')).toBeUndefined()
	})

	it('adds nothing at all before an era has been resolved', () => {
		const params = { protocolVersion: '2025-11-25' }
		const envelope = buildEnvelope({ era: undefined, method: 'initialize', params })

		expect(envelope.params).toBe(params)
		expect(envelope.headers).toEqual({})
	})
})
