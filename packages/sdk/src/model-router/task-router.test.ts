import { describe, expect, it } from 'vitest'

import type { TaskRouterConfig } from '../types/router/index.js'
import { resolveTaskModel } from './task-router.js'

/**
 * The task router, asked the question it answers.
 *
 * This module had no test of its own, and its 100% coverage came from
 * somewhere else: `runtime/query/iteration/phases/compaction-model-routing.test.ts`
 * runs the compaction phase and watches which model the summariser is asked
 * for, and `resolveTaskModel` is one call on that path. So the coverage
 * number and the test-presence gate were answering different questions and
 * both were right: the chain is exercised, and nothing fails if the resolver
 * is wrong in a way compaction's single entry point cannot see.
 *
 * What that other file does assert, and should be read as the owner of, is
 * the runtime's behaviour: that compaction honours a router at all, that
 * `coding` stays inert, and that a null key means unrouted rather than
 * "route to nothing". This file asserts the resolver's own contract in the
 * resolver's own terms — the three steps of the fallback, for every task
 * type the config admits, and the type-level promise that `| null` is a
 * value and not a model name — plus what the docblock on `TaskRouterConfig`
 * needs in order to be true: which keys the runtime consults is the call
 * site's business, and the resolver honours whatever it is handed.
 */

/** Every task type the config admits, so a chain step is never asserted for one key only. */
const TASK_TYPES = [
	'compaction',
	'summarization',
	'exploration',
	'coding',
	'verification',
	'planning',
	'advisory',
	'default',
] as const

describe('resolveTaskModel', () => {
	it('keeps the turn’s model when there is no router at all', () => {
		// The three steps exist because each answers a different host's
		// config: someone who routed this task type, someone who routed
		// everything else, and someone who never configured the router. The
		// last must be the model the turn was started with — substituting a
		// provider default for an unconfigured router would move a host's
		// work to a model they did not pick.
		expect(resolveTaskModel('compaction', undefined, 'primary-model')).toBe('primary-model')
		expect(resolveTaskModel('default', undefined, 'primary-model')).toBe('primary-model')
	})

	it('takes the model routed for this task type, ahead of the default', () => {
		// Step one, and the reason the default is a fallback rather than an
		// override: a host who routes compaction and everything else must get
		// the compaction model for compaction.
		const router: TaskRouterConfig = { compaction: 'cheap-model', default: 'fallback-model' }

		expect(resolveTaskModel('compaction', router, 'primary-model')).toBe('cheap-model')
	})

	it('falls back to `default` when this task type is not routed', () => {
		// `coding` is routed by nothing in this config, so the answer comes from
		// the second step. The `default` task type is in the loop below, where
		// its own key is what answers — reaching it through the fallback step
		// would assert the same value for the wrong reason.
		const router: TaskRouterConfig = { compaction: 'cheap-model', default: 'fallback-model' }

		expect(resolveTaskModel('coding', router, 'primary-model')).toBe('fallback-model')
	})

	it('falls to the primary model when the router routes nothing this task could use', () => {
		// Step three, and the one that must not drift: an empty router is what
		// a config schema produces before a host fills it in, and the answer
		// for it is the model the turn was started with.
		expect(resolveTaskModel('compaction', {}, 'primary-model')).toBe('primary-model')
		expect(resolveTaskModel('coding', { compaction: 'cheap-model' }, 'primary-model')).toBe(
			'primary-model',
		)
	})

	it('treats a null entry as unrouted rather than as a model name', () => {
		// Every key is typed `string | null`, and the nullable half is asserted
		// here for keys other than `compaction`: `default: null` has to fall
		// through to the primary model rather than become the answer, or a
		// config file that writes the key and leaves it empty sends an empty
		// model id to a provider where the id IS the endpoint.
		expect(
			resolveTaskModel('compaction', { compaction: null, default: 'fallback' }, 'primary'),
		).toBe('fallback')
		expect(resolveTaskModel('coding', { default: null }, 'primary-model')).toBe('primary-model')
		expect(resolveTaskModel('default', { default: null }, 'primary-model')).toBe('primary-model')
	})

	it('resolves every task type the config admits through the same chain', () => {
		// The type document states which keys the runtime consults today —
		// `compaction`, with `default` behind it — and states that the rest
		// are inert because nothing classifies a spawned task as exploration
		// or coding, NOT because this function refuses them. That distinction
		// is what this asserts: the resolver honours any key it is given, so
		// wiring a classifier later needs no change here, and `advisory` is
		// safe precisely because the call sites never ask for it.
		for (const taskType of TASK_TYPES) {
			const routesThisType = { [taskType]: 'routed' } as TaskRouterConfig

			expect(resolveTaskModel(taskType, routesThisType, 'primary-model')).toBe('routed')
			expect(resolveTaskModel(taskType, { default: 'fallback' }, 'primary-model')).toBe('fallback')
			expect(resolveTaskModel(taskType, {}, 'primary-model')).toBe('primary-model')
		}
	})
})
