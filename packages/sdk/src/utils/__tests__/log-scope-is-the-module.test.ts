import { describe, expect, it } from 'vitest'

import { EditOwnershipTracker } from '../../bus/ownership.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { BaseExecutionContext } from '../../execution/base.js'
import { createRunReporter } from '../../run/reporter.js'
import type { ExecutionEnvironment } from '../../types/execution/index.js'
import type { RunId } from '../../types/ids/index.js'
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

		tracker.claim('/tmp/a.ts', 'run_one' as RunId)
		tracker.claim('/tmp/a.ts', 'run_two' as RunId)

		expect(records.length).toBeGreaterThan(0)
		expect(records[0]?.scope.name).toBe('bus/ownership')
		// The old binding survived as an ordinary attribute rather than being
		// consumed into the scope. Its absence is what says the migration
		// happened rather than being duplicated.
		expect('component' in (records[0]?.attributes ?? {})).toBe(false)
	})

	it('createRunReporter logs as run/reporter', () => {
		const { logger, records } = capturing()
		const reporter = createRunReporter(logger)

		reporter.listener({ type: 'run_started', runId: 'run_x' as RunId })

		expect(records[0]?.scope.name).toBe('run/reporter')
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
