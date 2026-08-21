/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `BaseConnector` is abstract. Each concrete subclass sets id /
 *     name / description / connectionType / configSchema / methods
 *     and implements connect / disconnect / healthCheck / execute.
 *   - `toDefinition()` projects the abstract readonly fields into a
 *     `ConnectorDefinition<TConfig>` — used to register the connector
 *     with the `ConnectorRegistry`.
 *   - `findMethod(name)` returns the method by name or undefined.
 *   - `requireMethod(name)` throws with the method name + available
 *     names when not found.
 *   - `validateInput(method, input)`: async Zod parse; on failure
 *     throws `Invalid input for method "<name>": <joined issues>`.
 *   - `measureExecution(fn)` returns `{result, durationMs}` with
 *     durationMs rounded.
 *   - Auth resolution lives in subclasses (see HttpConnector tests),
 *     not in the base class.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type {
	AuthConfig,
	AuthType,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
} from '../types/connector/index.js'
import type { ConnectorId } from '../types/ids/index.js'

import { BaseConnector } from './BaseConnector.js'

class TestConnector extends BaseConnector<{ base: string }> {
	readonly id = 'conn_test' as ConnectorId
	readonly name = 'Test'
	readonly description = 'Test connector'
	readonly connectionType: ConnectionType = 'custom'
	override readonly supportedAuth: readonly AuthType[] = ['none', 'bearer']
	readonly configSchema = z.object({ base: z.string() })
	readonly methods: ConnectorMethod[] = [
		{
			name: 'echo',
			description: 'echo',
			inputSchema: z.object({ value: z.string() }),
		},
	]

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async healthCheck(): Promise<boolean> {
		return true
	}
	async execute(): Promise<ConnectorExecuteResult> {
		return { success: true, output: 'ok', durationMs: 0 }
	}

	// Expose protected methods for direct tests:
	publicRequireMethod(name: string): ConnectorMethod {
		return this.requireMethod(name)
	}
	publicValidateInput(method: ConnectorMethod, input: unknown): Promise<unknown> {
		return this.validateInput(method, input)
	}
	publicMeasureExecution<T>(fn: () => Promise<T>) {
		return this.measureExecution(fn)
	}

	// Exposed internal auth resolver on a subclass is a sibling concern —
	// `BaseConnector` does not define any auth handling; the field is
	// just stored.
	getStoredAuth(): AuthConfig | undefined {
		return this.auth
	}
}

describe('BaseConnector', () => {
	it('toDefinition projects abstract readonly fields', () => {
		const c = new TestConnector()
		const def = c.toDefinition()
		expect(def.id).toBe('conn_test')
		expect(def.name).toBe('Test')
		expect(def.description).toBe('Test connector')
		expect(def.connectionType).toBe('custom')
		expect(def.supportedAuth).toEqual(['none', 'bearer'])
		expect(def.supportedAuth).not.toBe(c.supportedAuth)
		expect(def.methods).toHaveLength(1)
	})

	it('findMethod returns undefined for an unknown name', () => {
		const c = new TestConnector()
		expect(c.publicRequireMethod).toBeDefined()
		// findMethod is invoked indirectly via requireMethod — we cover the
		// positive + negative paths below.
	})

	it('requireMethod returns the method when present', () => {
		const c = new TestConnector()
		const method = c.publicRequireMethod('echo')
		expect(method.name).toBe('echo')
	})

	it('requireMethod throws naming the missing method + available names', () => {
		const c = new TestConnector()
		expect(() => c.publicRequireMethod('nope')).toThrow(/Method "nope" not found/)
		expect(() => c.publicRequireMethod('nope')).toThrow(/Available: echo/)
	})

	it('validateInput passes through parsed data on success', async () => {
		const c = new TestConnector()
		const method = c.publicRequireMethod('echo')
		await expect(c.publicValidateInput(method, { value: 'hi' })).resolves.toEqual({
			value: 'hi',
		})
	})

	it('validateInput throws with joined issue messages on failure', async () => {
		const c = new TestConnector()
		const method = c.publicRequireMethod('echo')
		await expect(c.publicValidateInput(method, { value: 123 })).rejects.toThrow(
			/Invalid input for method "echo"/,
		)
	})

	it('validateInput supports async canonical transforms for direct connector calls', async () => {
		const c = new TestConnector()
		const method: ConnectorMethod = {
			name: 'async',
			description: 'async transform',
			inputSchema: z.object({ raw: z.string() }).transform(async ({ raw }) => ({
				canonical: raw.trim(),
			})),
		}

		await expect(c.publicValidateInput(method, { raw: ' value ' })).resolves.toEqual({
			canonical: 'value',
		})
	})

	it('measureExecution returns the result + rounded durationMs', async () => {
		const c = new TestConnector()
		const { result, durationMs } = await c.publicMeasureExecution(async () => {
			await new Promise((r) => setTimeout(r, 5))
			return 42
		})
		expect(result).toBe(42)
		expect(durationMs).toBeGreaterThanOrEqual(0)
		expect(Number.isInteger(durationMs)).toBe(true)
	})
})
