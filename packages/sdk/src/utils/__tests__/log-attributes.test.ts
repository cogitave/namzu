import { describe, expect, it } from 'vitest'
import type { LogAttributes } from '../log/index.js'

describe('LogAttributes', () => {
	it('accepts namespaced keys with string, number, boolean or array-of-primitive values', () => {
		const attrs: LogAttributes = {
			'namzu.connector.server.name': 'weather-mcp',
			'gen_ai.tool.call.id': 'call_1',
			'service.name': '@namzu/sdk',
			'exception.type': 'Error',
			'namzu.discovery.count': 3,
			'namzu.sandbox.enforces': true,
			'namzu.audit.event_id': ['a', 'b'],
		}

		expect(Object.keys(attrs)).toHaveLength(7)
	})

	it('rejects a nested object value at compile time', () => {
		const attrs: LogAttributes = {
			// @ts-expect-error — object values are not in AttributeValue; only the
			// array-of-primitives shape is, and a plain object is not that.
			'namzu.connector.auth': { type: 'bearer', token: 'x' },
		}

		expect(true).toBe(true)
		void attrs
	})

	it('rejects a key outside the four reserved prefixes at compile time', () => {
		const attrs: LogAttributes = {
			// @ts-expect-error — 'serverId' is not namzu./gen_ai./service./exception.-namespaced.
			serverId: 'srv_1',
		}

		expect(true).toBe(true)
		void attrs
	})

	it('rejects an explicit null or undefined value at compile time', () => {
		const withNull: LogAttributes = {
			// @ts-expect-error — null is not in AttributeValue.
			'namzu.connector.server.name': null,
		}
		const withUndefined: LogAttributes = {
			// @ts-expect-error — LogAttributes is a plain Record, not
			// Partial<Record<...>>, so an explicit undefined is rejected too.
			'namzu.connector.server.name': undefined,
		}

		expect(true).toBe(true)
		void withNull
		void withUndefined
	})
})
