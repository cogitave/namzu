import { describe, expect, it, vi } from 'vitest'

import type { Logger } from '../../utils/logger.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

/**
 * What a default-level start actually reads like.
 *
 * Registration ran at `info`, once per item, and a CLI run registers dozens —
 * every builtin tool, every agent, every task tool. So the first twenty lines
 * of a run were `Registered: read`, `Registered: write`, `Registered: glob`,
 * and the lines an operator could act on were somewhere below them.
 *
 * That is the same failure as the CLI silencing its own logger, with the sign
 * flipped: in one case the signal is absent, in the other it is buried, and
 * neither start tells you anything. Fixing the first exposed the second.
 *
 * Every other test in this package asserts against a logger stub and never
 * looks at which METHOD was called, so the level was invisible to all of them.
 * This one exists because that gap is what let it ship — it was found by
 * running the CLI against a real provider, which is the one thing no unit test
 * here does.
 */

function spyLogger(): {
	log: Logger
	info: ReturnType<typeof vi.fn>
	debug: ReturnType<typeof vi.fn>
	warn: ReturnType<typeof vi.fn>
} {
	const info = vi.fn()
	const debug = vi.fn()
	const warn = vi.fn()
	const log = { info, debug, warn, error: vi.fn(), child: () => log } as unknown as Logger
	return { log, info, debug, warn }
}

interface Thing {
	name: string
}

describe('registering something is not news', () => {
	it('logs a registration at debug, never at info', () => {
		// Reverting either `debug` call in ManagedRegistry.register to `info`
		// fails this.
		const { log, info, debug } = spyLogger()
		const registry = new ManagedRegistry<Thing>({
			componentName: 'TestRegistry',
			idField: 'name',
			logger: log,
		})

		registry.register({ name: 'alpha' })

		expect(debug).toHaveBeenCalledTimes(1)
		expect(info, 'a routine registration reached the default level').not.toHaveBeenCalled()
	})

	it('logs the explicit-id overload at debug too', () => {
		// Two call sites, two levels to get wrong. Reverting only the first
		// one fails here and nowhere else.
		const { log, info, debug } = spyLogger()
		const registry = new ManagedRegistry<Thing>({
			componentName: 'TestRegistry',
			idField: 'name',
			logger: log,
		})

		registry.register('explicit', { name: 'beta' })

		expect(debug).toHaveBeenCalledTimes(1)
		expect(info).not.toHaveBeenCalled()
	})

	it('still warns when a live id is overwritten', () => {
		// The negative half. Quieting the routine case must not quiet the one
		// that is genuinely news: a second registration under an id something
		// may already hold a reference to. Lowering this to debug fails here.
		const { log, warn } = spyLogger()
		const registry = new ManagedRegistry<Thing>({
			componentName: 'TestRegistry',
			idField: 'name',
			logger: log,
		})

		registry.register({ name: 'alpha' })
		registry.register({ name: 'alpha' })

		expect(warn).toHaveBeenCalledTimes(1)
	})
})
