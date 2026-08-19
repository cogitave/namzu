import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorManager } from '../../manager/connector/lifecycle.js'
import { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type { ToolContext } from '../../types/tool/index.js'
import { WebhookConnector } from '../builtins/webhook.js'
import { createConnectorExecuteTool } from './definitions.js'

describe('connector tools preserve remote outcome', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('keeps a received 202 visible when the webhook body misses its deadline', async () => {
		vi.useFakeTimers()
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 202,
			statusText: 'Accepted',
			headers: new Headers({ 'content-type': 'application/json' }),
			json: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve({ arrived: 'too late' }), 50)
				}),
			text: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve('too late'), 50)
				}),
		}))
		vi.stubGlobal('fetch', fetchMock)

		const connector = new WebhookConnector()
		const registry = new ConnectorRegistry()
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })
		const instance = await manager.createInstance(
			{
				connectorId: connector.id,
				name: 'phase-aware webhook',
				options: { url: 'https://hook.example.com', timeoutMs: 5 },
			},
			connector,
		)
		await manager.connect(instance.id)
		const tool = createConnectorExecuteTool({ manager })

		const pending = tool.execute(
			{
				instance_id: instance.id,
				method: 'send',
				input: { payload: { event: 'once' } },
			},
			{ abortSignal: new AbortController().signal } as ToolContext,
		)
		await vi.advanceTimersByTimeAsync(50)
		const result = await pending

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(result.success).toBe(true)
		expect(result.output).toContain('"status": 202')
		expect(result.output).toContain('"bodyAvailable": false')
		expect(result.output).toContain('"remoteOutcome": "response_received"')
		expect(result.output).toContain('"retrySafety": "unsafe"')
	})

	it('keeps the known response when caller cancellation interrupts its body', async () => {
		let markBodyStarted: (() => void) | undefined
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve
		})
		let transportSignal: AbortSignal | undefined
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				transportSignal = init.signal as AbortSignal
				return {
					ok: true,
					status: 202,
					statusText: 'Accepted',
					headers: new Headers({ 'content-type': 'application/json' }),
					json: () =>
						new Promise<never>(() => {
							markBodyStarted?.()
						}),
					text: () => new Promise<never>(() => {}),
				}
			}),
		)

		const connector = new WebhookConnector()
		const registry = new ConnectorRegistry()
		registry.register(connector.toDefinition())
		const manager = new ConnectorManager({ registry })
		const instance = await manager.createInstance(
			{
				connectorId: connector.id,
				name: 'cancelled-body webhook',
				options: { url: 'https://hook.example.com', timeoutMs: 60_000 },
			},
			connector,
		)
		await manager.connect(instance.id)
		const tool = createConnectorExecuteTool({ manager })
		const caller = new AbortController()
		const pending = tool.execute(
			{
				instance_id: instance.id,
				method: 'send',
				input: { payload: { event: 'once' } },
			},
			{ abortSignal: caller.signal } as ToolContext,
		)

		await bodyStarted
		const reason = new Error('caller stopped after acceptance')
		caller.abort(reason)
		const result = await pending

		expect(result.success).toBe(true)
		expect(result.output).toContain('"status": 202')
		expect(result.output).toContain('"bodyAvailable": false')
		expect(transportSignal?.reason).toBe(reason)
	})
})
