import { describe, expect, it } from 'vitest'

import { composeFilePlacementGuidance } from '../file-placement.js'
import { composeSessionSystemPrompt, sessionPromptInput } from '../system-prompt.js'

describe('the "Where files go" guidance', () => {
	it('is two lines, the same on every platform', () => {
		const text = composeFilePlacementGuidance()
		expect(text.split('\n')).toHaveLength(2)
		expect(text.length).toBeLessThan(500)
	})

	it('says where temporary work goes, to report the path of a folder, and to ask before touching the home or root top level', () => {
		const text = composeFilePlacementGuidance()
		for (const phrase of [
			'temporary work',
			'scratchpad',
			'full path of every folder',
			'home folder or the filesystem root without asking',
		]) {
			expect(text, phrase).toContain(phrase)
		}
	})

	it('no longer carries the service checklist, which most turns never need', () => {
		const text = composeFilePlacementGuidance()
		for (const gone of ['Identity:', 'Supervisor:', 'Monitoring:', 'receipt', '~/.local/share'])
			expect(text, gone).not.toContain(gone)
	})

	it('is in the session prompt once and identical on every turn', () => {
		const facts = {
			anyToolDeferred: false,
			filePlacementGuidance: composeFilePlacementGuidance(),
		}
		const turn = (permissionMode: string) =>
			composeSessionSystemPrompt(sessionPromptInput(facts, { permissionMode })) ?? ''
		const first = turn('auto')
		expect(first.split('# Where files go')).toHaveLength(2)
		expect(turn('auto')).toBe(first)
		expect(turn('default')).toBe(first)
	})
})
