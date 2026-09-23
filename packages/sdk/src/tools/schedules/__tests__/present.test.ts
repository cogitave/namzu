import { describe, expect, it } from 'vitest'
import {
	presentLoopCall,
	presentLoopResult,
	presentScheduleCall,
	presentScheduleResult,
} from '../present.js'

describe('schedule tool presentation', () => {
	it('names each action in words', () => {
		const label = (input: Record<string, unknown>) =>
			(presentScheduleCall(input as never) as { label: string }).label
		expect(label({ action: 'create', name: 'n', when: 'every 1h' })).toBe(
			'Propose scheduled job · n · every 1h',
		)
		expect(label({ action: 'create' })).toBe('Propose scheduled job')
		expect(label({ action: 'list' })).toBe('List scheduled jobs')
		expect(label({ action: 'pause', job: 'n' })).toBe('Pause scheduled job · n')
		expect(label({ action: 'resume', job: 'n' })).toBe('Resume scheduled job · n')
		expect(label({ action: 'delete', job: 'n' })).toBe('Delete scheduled job · n')
		expect(label({ action: 'other' })).toBe('Scheduled jobs')
		expect(label({ action: 'create', name: 'x'.repeat(200) }).length).toBeLessThan(120)
	})

	it('hides a successful receipt and says why a failure failed', () => {
		expect(presentScheduleResult({}, { success: true, output: 'ok' })).toMatchObject({
			visibility: 'hidden',
		})
		expect(presentScheduleResult({}, { success: false, output: '', error: 'no' })).toMatchObject({
			label: 'no',
		})
		expect(presentScheduleResult({}, { success: false, output: '' })).toMatchObject({
			label: 'Not done',
		})
	})

	it('names loop actions', () => {
		const label = (input: Record<string, unknown>) =>
			(presentLoopCall(input as never) as { label: string }).label
		expect(label({ action: 'create', interval: '5m', prompt: 'ping' })).toBe('Loop 5m · ping')
		expect(label({ action: 'list' })).toBe('List loops')
		expect(label({ action: 'delete' })).toBe('Stop loop')
		expect(label({})).toBe('Loops')
		expect(presentLoopResult({}, { success: true, output: '' })).toMatchObject({
			visibility: 'hidden',
		})
		expect(presentLoopResult({}, { success: false, output: '', error: 'x' })).toMatchObject({
			label: 'x',
		})
	})
})
