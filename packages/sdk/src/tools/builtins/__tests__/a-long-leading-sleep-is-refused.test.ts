import { describe, expect, it } from 'vitest'

import { BackgroundJobRegistry, bindOwner } from '../../../runtime/jobs/registry.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'
import { leadingLongSleep } from '../sleep-guard.js'

function turn(withJobs: boolean): ToolContext {
	return {
		workingDirectory: '/workspace',
		...(withJobs
			? {
					backgroundJobs: bindOwner(new BackgroundJobRegistry(), 'turn-1', {
						workingDirectory: '/workspace',
					}),
				}
			: {}),
	} as ToolContext
}

describe('leadingLongSleep', () => {
	it('names a standalone or leading sleep of 25 seconds or more', () => {
		expect(leadingLongSleep('sleep 30')).toBe('standalone sleep 30')
		expect(leadingLongSleep('sleep 25')).toBe('standalone sleep 25')
		expect(leadingLongSleep('sleep 60 && make test')).toBe('sleep 60 followed by: make test')
	})

	it('leaves shorter, suffixed and later sleeps alone', () => {
		expect(leadingLongSleep('sleep 24.9')).toBeNull()
		expect(leadingLongSleep('sleep 30s')).toBeNull()
		expect(leadingLongSleep('make test; sleep 60')).toBeNull()
		expect(leadingLongSleep('echo sleep 60')).toBeNull()
	})
})

describe('bash refuses a long leading sleep where a job can be waited on', () => {
	it('refuses it and points at the better ways to wait', async () => {
		const result = await BashTool.execute({ command: 'sleep 120', timeout: 1000 }, turn(true))
		expect(result.success).toBe(false)
		expect(result.error).toContain('Blocked: standalone sleep 120')
		expect(result.error).toContain('wait_for_job')
		expect(result.error).toContain('monitor')
	})
})

describe('long-sleep guard boundary and command shape', () => {
	it.each([
		'sleep 25; echo done',
		'sleep 25 || echo done',
		'sleep 25 | cat',
		'sleep 25\necho done',
	])('recognizes a leading literal wait in %s', (command) => {
		expect(leadingLongSleep(command)).toContain('sleep 25 followed by:')
	})

	it('does not mistake quoted prose or an invalid sleep operand for a leading wait', () => {
		expect(leadingLongSleep('echo "sleep 100"')).toBeNull()
		expect(leadingLongSleep('sleep $SECONDS')).toBeNull()
		expect(leadingLongSleep('sleep -1')).toBeNull()
		expect(leadingLongSleep('sleep 24.999')).toBeNull()
		expect(leadingLongSleep('sleep 25.001')).toBe('standalone sleep 25.001')
	})
})
