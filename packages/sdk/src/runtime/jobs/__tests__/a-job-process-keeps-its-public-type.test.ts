import type { ChildProcess } from 'node:child_process'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { BackgroundJobRegistryRef } from '../../../types/tool/index.js'
import type { JobChild, JobProcess, JobSource, StartJobParams } from '../registry.js'

/**
 * `JobProcess` is public. A host that builds one for `StartJobParams.spawn`,
 * or reads `.child` from one, was written against a `ChildProcess`; narrowing
 * the member to the registry's smaller `JobChild` breaks the reader, so the
 * smaller shape is a separate type that a `spawn` may return instead.
 *
 * These are compile-time assertions: a regression fails `pnpm typecheck`.
 */
describe('the public job process types are only ever widened', () => {
	it('keeps JobProcess.child a ChildProcess', () => {
		expectTypeOf<JobProcess['child']>().toEqualTypeOf<ChildProcess>()
		expect(true).toBe(true)
	})

	it('lets a spawn return the smaller JobSource, and a ChildProcess still is one', () => {
		expectTypeOf<JobSource['child']>().toEqualTypeOf<JobChild>()
		expectTypeOf<ChildProcess>().toExtend<JobChild>()
		expectTypeOf<JobProcess>().toExtend<JobSource>()
		type Spawned = ReturnType<NonNullable<StartJobParams['spawn']>>
		expectTypeOf<JobProcess>().toExtend<Spawned>()
		expectTypeOf<JobSource>().toExtend<Spawned>()
		// A spawn written before the host argument existed still fits.
		const legacy: StartJobParams['spawn'] = (): JobProcess => {
			throw new Error('unused')
		}
		expect(legacy).toBeTypeOf('function')
	})

	it('keeps startMonitor taking only a command, with the WebSocket form beside it', () => {
		type Params = Parameters<NonNullable<BackgroundJobRegistryRef['startMonitor']>>[0]
		expectTypeOf<Params>().toHaveProperty('command')
		expectTypeOf<Params['command']>().toEqualTypeOf<string>()
		expectTypeOf<BackgroundJobRegistryRef>().toHaveProperty('startWebSocketMonitor')
	})
})
