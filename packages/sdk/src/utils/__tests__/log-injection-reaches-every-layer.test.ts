import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AbstractAgent } from '../../agents/AbstractAgent.js'
import { BaseConnector } from '../../connector/BaseConnector.js'
import { ConnectorManager } from '../../manager/connector/lifecycle.js'
import { ConnectorRegistry } from '../../registry/connector/definitions.js'
import type {
	AgentInput,
	AgentMetadata,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../types/agent/index.js'
import type {
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
} from '../../types/connector/index.js'
import type { ConnectorId, TenantId } from '../../types/ids/index.js'
import { InMemoryCredentialVault } from '../../vault/InMemoryCredentialVault.js'
import { SCOPE_ATTRIBUTE } from '../log/types.js'
import type { LogContext, Logger } from '../logger.js'

interface CapturedRecord {
	message: string
	bound: LogContext
}

function capturingLogger(): { logger: Logger; records: CapturedRecord[] } {
	const records: CapturedRecord[] = []
	const make = (bound: LogContext): Logger => ({
		debug: (message) => records.push({ message, bound }),
		info: (message) => records.push({ message, bound }),
		warn: (message) => records.push({ message, bound }),
		error: (message) => records.push({ message, bound }),
		child: (context) => make({ ...bound, ...context }),
	})
	return { logger: make({}), records }
}

class TestAgent extends AbstractAgent<BaseAgentConfig, BaseAgentResult> {
	readonly type = 'reactive' as const

	async run(_input: AgentInput, _config: BaseAgentConfig): Promise<BaseAgentResult> {
		const runId = this.createRunId()
		this.bindRun(runId)
		this.log.info('agent layer reached')
		return this.createEmptyResult(runId, Date.now())
	}
}

function agentMetadata(): AgentMetadata {
	return {
		type: 'reactive',
		id: 'agent_test',
		name: 'Test Agent',
		version: '1.0.0',
		category: 'test',
		description: 'test',
		capabilities: {
			supportsTools: false,
			supportsStreaming: false,
			supportsConcurrency: false,
			supportsSubAgents: false,
		},
	}
}

class TestConnector extends BaseConnector<Record<string, never>> {
	readonly id = 'conn_test' as ConnectorId
	readonly name = 'Test'
	readonly description = 'Test connector'
	readonly connectionType: ConnectionType = 'custom'
	readonly configSchema = z.object({})
	readonly methods: ConnectorMethod[] = []

	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async healthCheck(): Promise<boolean> {
		return true
	}
	async execute(): Promise<ConnectorExecuteResult> {
		return { success: true, output: 'ok', durationMs: 0 }
	}
}

describe('a host-injected logger reaches the agent, connector AND vault layers', () => {
	it('marks records from all three with the SAME injected logger', async () => {
		const { logger, records } = capturingLogger()
		const marked = logger.child({ testMarker: 'shared-injected-logger' })

		// Agent layer.
		const agent = new TestAgent(agentMetadata(), marked)
		await agent.run(
			{ messages: [], workingDirectory: '/tmp' },
			{ model: 'test-model', tokenBudget: 1000, timeoutMs: 1000 },
		)

		// Connector layer.
		const registry = new ConnectorRegistry()
		registry.register({
			id: 'conn_test' as ConnectorId,
			name: 'Test',
			description: 'Test connector',
			connectionType: 'custom',
			configSchema: z.object({}),
			methods: [],
		})
		const manager = new ConnectorManager({ registry, log: marked })
		await manager.createInstance(
			{ connectorId: 'conn_test' as ConnectorId, name: 'x' },
			new TestConnector(),
		)

		// Vault layer.
		const vault = new InMemoryCredentialVault(marked)
		await vault.store('t_test' as TenantId, 'conn_test' as ConnectorId, 'label', {
			type: 'api_key',
			credentials: { apiKey: 'sk-test' },
		})

		const agentRecords = records.filter((r) => r.message === 'agent layer reached')
		const connectorRecords = records.filter((r) => r.message === 'Connector instance created')
		const vaultRecords = records.filter((r) => r.message === 'Credential stored')

		expect(agentRecords).toHaveLength(1)
		expect(connectorRecords).toHaveLength(1)
		expect(vaultRecords).toHaveLength(1)

		// Each failed independently against pre-LOG-10 code, since none of
		// these three constructors had an injection point at all.
		expect(agentRecords[0]?.bound.testMarker).toBe('shared-injected-logger')
		expect(connectorRecords[0]?.bound.testMarker).toBe('shared-injected-logger')
		expect(vaultRecords[0]?.bound.testMarker).toBe('shared-injected-logger')

		// And each layer still stamps its OWN scope on top of the shared base.
		expect(agentRecords[0]?.bound[SCOPE_ATTRIBUTE]).toBe('agents')
		expect(connectorRecords[0]?.bound[SCOPE_ATTRIBUTE]).toBe('manager/connector')
		expect(vaultRecords[0]?.bound[SCOPE_ATTRIBUTE]).toBe('vault')
	})
})
