import { describe, expect, it } from 'vitest'
import { browserWindowRouting } from '../agent.js'

describe('what the model is told about the person’s own browser window', () => {
	it('keeps the rule honest for each setting and never offers a reload as a way forward', () => {
		for (const setting of ['look', 'ask', 'act'] as const) {
			const text = browserWindowRouting(setting)
			expect(text, setting).toContain('desktop browser window that is already open')
			expect(text, setting).toContain('separate Namzu-managed browser profile')
			expect(text, setting).not.toMatch(/reload/i)
		}
	})

	it('look says look only and names the setting, the Namzu browser and guiding', () => {
		const text = browserWindowRouting('look')
		expect(text).toContain('Look at it only')
		expect(text).toContain('Browser windows in Settings')
		expect(text).toContain('Namzu browser profile')
		expect(text).toContain('guide them from screenshots')
	})

	it('ask names the three ways forward and the asks that stay', () => {
		const text = browserWindowRouting('ask')
		expect(text).toContain('only their answer allows it')
		expect(text).toContain('allow it for this conversation')
		expect(text).toContain('Namzu browser profile, where they sign in once')
		expect(text).toContain('password field')
		expect(text).toContain('organisation-wide admin settings')
	})

	it('act still keeps the asks that stay', () => {
		const text = browserWindowRouting('act')
		expect(text).toContain('click and type in their own browser windows')
		expect(text).toContain('accept terms')
	})
})
