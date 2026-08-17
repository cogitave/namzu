import { createLogger } from '../utils/log/create-logger.js'
import { getProcessSinkCounters } from '../utils/log/process-sink.js'
import type { LogSink } from '../utils/log/types.js'
import type { LogLevel, Logger } from '../utils/logger.js'

/**
 * What a host builds after it has decided where its logs go.
 *
 * Before LOG-20 a test installed a process sink and every SDK component
 * silently routed through it, because a component with no logger resolved the
 * process-wide `getRootLogger()`. That is gone: `resolveLogger(undefined)`
 * returns `NOOP_LOGGER`, so a component with no logger produces nothing at
 * all. A test that wants to see a component's records now has to hand it one,
 * exactly as `installCliLogging` (`packages/cli/src/logging.ts`) does for the
 * CLI — which is the point of the change, not a cost of it: the routing is
 * visible at the call site rather than implied by process state.
 *
 * The counters come from the process sink when one is installed, so a test
 * that installs a sink AND builds a logger over it still sees one set of
 * totals through `getLogCounters()` — the production arrangement. When
 * nothing is installed, `getProcessSinkCounters()` is `undefined` and this
 * logger counts standalone.
 */
export function hostLogger(sink: LogSink, level: LogLevel = 'debug', scope = 'test-host'): Logger {
	return createLogger(
		{
			sink,
			level: { current: level },
			resource: { 'service.name': 'namzu' },
			scope,
		},
		getProcessSinkCounters(),
	)
}
