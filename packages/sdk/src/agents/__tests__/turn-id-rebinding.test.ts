import { describe, expect, it } from 'vitest'
import { GENAI, NAMZU } from '../../constants/telemetry/index.js'
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

	async run(_input: AgentInput, config: BaseAgentConfig): Promise<BaseAgentResult> {
		const sessionId = this.resolveSessionId(config.sessionId)
		const turnId = this.createTurnId()
		this.bindTurn(sessionId, turnId)
		this.log.info('turn started')
		return this.createEmptyResult(sessionId, turnId, Date.now())
	}

	getCurrentTurnId() {
		return this.currentTurnId
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

describe('AbstractAgent — per-invocation turn-id rebinding', () => {
	it('carries the SECOND turn’s id on records from the second turn, never the first — a constructor-time binding fails this', async () => {
		const { logger, records } = capturingLogger()
		const agent = new TestAgent(metadata(), logger)

		const input: AgentInput = { messages: [], workingDirectory: '/tmp' }
		const config: BaseAgentConfig = { model: 'test-model', tokenBudget: 1000, timeoutMs: 1000 }

		const first = await agent.run(input, config)
		expect(agent.getCurrentTurnId()).toBe(first.turnId)

		const second = await agent.run(input, config)
		expect(agent.getCurrentTurnId()).toBe(second.turnId)
		expect(first.turnId).not.toBe(second.turnId)

		const turnStartedRecords = records.filter((r) => r.message === 'turn started')
		expect(turnStartedRecords).toHaveLength(2)

		const firstTurnRecords = turnStartedRecords.filter(
			(r) => r.bound[NAMZU.TURN_ID] === first.turnId,
		)
		const secondTurnRecords = turnStartedRecords.filter(
			(r) => r.bound[NAMZU.TURN_ID] === second.turnId,
		)

		expect(firstTurnRecords).toHaveLength(1)
		expect(secondTurnRecords).toHaveLength(1)
		// The session travels with the turn, under the conventional key.
		expect(firstTurnRecords[0]?.bound[GENAI.CONVERSATION_ID]).toBe(first.sessionId)
		// The bug this test exists to catch: a constructor-time binding gives
		// every record — first turn AND second — the id (or lack of one) that
		// was live when `new TestAgent(...)` ran, so the second turn's own
		// record would still carry the FIRST turn's id here.
		expect(secondTurnRecords[0]?.bound[NAMZU.TURN_ID]).not.toBe(first.turnId)
	})
})
