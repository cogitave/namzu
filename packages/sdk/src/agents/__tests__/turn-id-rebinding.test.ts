import { describe, expect, it } from 'vitest'
import { NAMZU } from '../../constants/telemetry/index.js'
import type {
	AgentInput,
	AgentMetadata,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../types/agent/index.js'
import type { LogContext, Logger } from '../../utils/logger.js'
import { AbstractAgent } from '../AbstractAgent.js'

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
		this.log.info('run started')
		return this.createEmptyResult(runId, Date.now())
	}

	getCurrentRunId() {
		return this.currentRunId
	}
}

function metadata(): AgentMetadata {
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

describe('AbstractAgent — per-invocation run-id rebinding', () => {
	it('carries the SECOND run’s id on records from the second run, never the first — a constructor-time binding fails this', async () => {
		const { logger, records } = capturingLogger()
		const agent = new TestAgent(metadata(), logger)

		const input: AgentInput = { messages: [], workingDirectory: '/tmp' }
		const config: BaseAgentConfig = { model: 'test-model', tokenBudget: 1000, timeoutMs: 1000 }

		const first = await agent.run(input, config)
		expect(agent.getCurrentRunId()).toBe(first.runId)

		const second = await agent.run(input, config)
		expect(agent.getCurrentRunId()).toBe(second.runId)
		expect(first.runId).not.toBe(second.runId)

		const runStartedRecords = records.filter((r) => r.message === 'run started')
		expect(runStartedRecords).toHaveLength(2)

		const firstRunRecords = runStartedRecords.filter((r) => r.bound[NAMZU.RUN_ID] === first.runId)
		const secondRunRecords = runStartedRecords.filter((r) => r.bound[NAMZU.RUN_ID] === second.runId)

		expect(firstRunRecords).toHaveLength(1)
		expect(secondRunRecords).toHaveLength(1)
		// The bug this test exists to catch: a constructor-time binding gives
		// every record — first run AND second — the run id (or lack of one)
		// that was live when `new TestAgent(...)` ran, so the second run's own
		// record would still carry the FIRST run's id here.
		expect(secondRunRecords[0]?.bound[NAMZU.RUN_ID]).not.toBe(first.runId)
	})
})
