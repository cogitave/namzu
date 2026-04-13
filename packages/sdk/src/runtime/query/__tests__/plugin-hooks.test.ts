import { describe, expect, it } from 'vitest'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import { applyLifecycleHookResults } from '../plugin-hooks.js'

describe('applyLifecycleHookResults', () => {
	it('returns silently when all results are continue', () => {
		const results: PluginHookResult[] = [{ action: 'continue' }, { action: 'continue' }]
		expect(() => applyLifecycleHookResults('run_start', results)).not.toThrow()
	})

	it('throws when a result is error', () => {
		const results: PluginHookResult[] = [{ action: 'error', message: 'kaboom' }]
		expect(() => applyLifecycleHookResults('pre_llm_call', results)).toThrow(
			/pre_llm_call reported error: kaboom/,
		)
	})

	it.each([
		['skip', { action: 'skip', reason: 'no' } as PluginHookResult],
		['modify', { action: 'modify', input: {} } as PluginHookResult],
		['retry', { action: 'retry' } as PluginHookResult],
		['resume', { action: 'resume', input: 'x' } as PluginHookResult],
	])('throws on unsupported %s action for lifecycle event', (_, result) => {
		expect(() => applyLifecycleHookResults('iteration_start', [result])).toThrow(
			/unsupported action/,
		)
	})
})
