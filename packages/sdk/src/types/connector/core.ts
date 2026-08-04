import type { z } from 'zod'
import type { ConnectorId, ConnectorInstanceId } from '../ids/index.js'

export type ConnectionType = 'http' | 'webhook' | 'custom'

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export function isConnectorActive(status: ConnectorStatus): boolean {
	return status === 'connected' || status === 'connecting'
}

export type AuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2' | 'custom'

export interface AuthConfig {
	type: AuthType
	credentials?: Record<string, string>
}

export type ConnectorCategory =
	| 'communication'
	| 'data'
	| 'development'
	| 'productivity'
	| 'integration'
	| 'custom'

export interface ConnectorMethod<TInput = unknown, TOutput = unknown> {
	name: string
	description: string
	inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>
	/**
	 * **Not consulted.** Neither in-tree connector declares one, and nothing
	 * validates a result against it or shows it to a model.
	 *
	 * The tool layer solved the same problem already: a remote tool's output
	 * schema is appended to its description by `describeWithOutput`, because
	 * no provider's tool wire format has a slot for one. A connector method
	 * that reaches a model through that bridge should take the same route
	 * rather than growing a second mechanism.
	 */
	outputSchema?: z.ZodType<TOutput, z.ZodTypeDef, unknown>
}

/**
 * **Declared, not implemented.** Nothing reads a trigger and nothing emits
 * a {@link ConnectorEvent}; no inbound event starts a run today.
 *
 * Said here rather than left to be discovered, because a connector author
 * who declares triggers gets no error and no events — the worst combination
 * to debug. The shape is kept because it is right: a trigger names an
 * upstream event and the config a subscription needs.
 *
 * What is missing is not the type but the delivery half, and it is a larger
 * piece than it looks. An inbound event has to be de-duplicated across
 * processes, since the same webhook is retried and the same poll can
 * overlap; that needs a compare-and-set claim, and the only durable write
 * primitive here is an atomic file REPLACE, which is last-writer-wins and
 * cannot express one. It also needs a release path for an event claimed by
 * a process that then dies, or the first crash silently drops that event
 * forever.
 *
 * Two of those parts already exist and should be reused rather than
 * rebuilt when this is built: `AbstractAgent.underIdempotencyKey` is the
 * in-process dedupe seam and names the cross-process half as its known
 * gap, and `EditOwnershipTracker.claim` is the claim/refuse shape with
 * same-owner idempotency already worked out.
 */
export interface ConnectorTrigger {
	name: string
	description: string
	event: string
	configSchema?: z.ZodType
}

export interface ConnectorEvent {
	connectorId: ConnectorId
	instanceId: ConnectorInstanceId
	trigger: string
	payload: unknown
	timestamp: number
}
