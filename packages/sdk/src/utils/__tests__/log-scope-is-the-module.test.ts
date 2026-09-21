import { describe, expect, it } from 'vitest'

import { EditOwnershipTracker } from '../../bus/ownership.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { BaseExecutionContext } from '../../execution/base.js'
import { createTurnReporter } from '../../turn/index.js'
import type { ExecutionEnvironment } from '../../types/execution/index.js'
import type { MessageId, SessionId, TurnId } from '../../types/ids/index.js'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'
import type { Logger } from '../logger.js'

/**
 * `scope.name` has to be the module, and it has to arrive from a real class
 * rather than from a unit test of the mechanism.
 *
 * `log-scope-attribute.test.ts` already proves `child({ [SCOPE_ATTRIBUTE]: x })`
 * rebinds `scope.name` — that is the seam. This file proves the SDK's own
 * modules USE it. The distinction is not academic: every one of these classes
 * previously bound `component: 'EditOwnershipTracker'`, and `component` is
 * deliberately inert (see `SCOPE_ATTRIBUTE`'s doc comment). So the records
 * carried a default scope and an extra attribute, and no test anywhere would
 * have failed if they had gone on doing so.
 */

function capturing(): { logger: Logger; records: LogRecord[] } {
	const records: LogRecord[] = []
	const sink: LogSink = { emit: (record) => records.push(record) }
	return {
		logger: createLogger({
			sink,
			level: { current: 'debug' },
			resource: { 'service.name': 'test' },
			// A scope a module MUST overwrite. Asserting against 'root' below
			// would pass for a module that binds nothing at all.
			scope: 'root',
		}),
		records,
	}
}

describe('a record names the module it came from', () => {
	it('EditOwnershipTracker logs as bus/ownership, not as its class name', () => {
		const { logger, records } = capturing()
		const tracker = new EditOwnershipTracker(logger, () => {})

		tracker.claim('/tmp/a.ts', 'c6ef7827-d63a-47fb-91d6-157229a8906e' as SessionId)
		tracker.claim('/tmp/a.ts', '299cae19-4431-4007-8356-a447a844d719' as SessionId)

		expect(records.length).toBeGreaterThan(0)
		expect(records[0]?.scope.name).toBe('bus/ownership')
		// The old binding survived as an ordinary attribute rather than being
		// consumed into the scope. Its absence is what says the migration
		// happened rather than being duplicated.
		expect('component' in (records[0]?.attributes ?? {})).toBe(false)
	})

	it('createTurnReporter logs as turn/reporter', () => {
		const { logger, records } = capturing()
		const reporter = createTurnReporter(logger)

		reporter.listener({
			type: 'turn_started',
			sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
			turnId: 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3' as TurnId,
			userMessageId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5d' as MessageId,
			config: { model: 'fixture-model', tokenBudget: 0, timeoutMs: 60_000 },
		})

		expect(records[0]?.scope.name).toBe('turn/reporter')
		expect('component' in (records[0]?.attributes ?? {})).toBe(false)
	})

	it('a base class scopes to the base MODULE and puts the subclass in an attribute', async () => {
		// The two `this.constructor.name` sites are the ones a straight key
		// rename would have got wrong: making the scope the subclass name
		// would mean `scope.name` varies per instance, which is the opposite
		// of what a scope is. ManagedRegistry settled this shape first —
		// scope is the file, identity is an attribute.
		class SandboxedContext extends BaseExecutionContext {
			readonly id = 'ctx_1'
			readonly environment: ExecutionEnvironment = 'local'
			protected async doInitialize(): Promise<void> {}
			protected async doTeardown(): Promise<void> {}
		}

		const { logger, records } = capturing()
		await new SandboxedContext(logger).initialize()

		expect(records[0]?.scope.name).toBe('execution/base')
		expect(records[0]?.attributes[NAMZU.EXECUTION_TYPE]).toBe('SandboxedContext')
	})
})
