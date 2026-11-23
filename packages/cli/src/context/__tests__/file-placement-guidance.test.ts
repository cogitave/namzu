import { describe, expect, it } from 'vitest'

import { composeFilePlacementGuidance } from '../file-placement.js'
import { composeSessionSystemPrompt, sessionPromptInput } from '../system-prompt.js'

describe('the "Where files go" guidance', () => {
	it('is three short paragraphs under the heading, the same on every platform', () => {
		const text = composeFilePlacementGuidance()
		expect(text.split('\n')).toHaveLength(4)
		expect(text.length).toBeLessThan(1150)
	})

	it('sends everything that is not the work to the scratch folder, and keeps it out of the project and the home folder', () => {
		const text = composeFilePlacementGuidance()
		for (const phrase of [
			'Keep your folders to what was asked for',
			"session's scratch folder",
			'never in the working directory or the home folder',
			'logs, saved output, helper and reproduction scripts, intermediate data (a merged or converted copy included), backup copies, staging folders',
			'Use the shared temp folder only when the person asks',
		]) {
			expect(text, phrase).toContain(phrase)
		}
	})

	it('puts a requested file where the person said and asks for no backup copy beside an edit', () => {
		const text = composeFilePlacementGuidance()
		for (const phrase of [
			'A file they asked for goes where they said, or where the project keeps such files',
			'A backup copy goes in the scratch folder, not beside the file',
			'Give a full path only when the person needs it',
		]) {
			expect(text, phrase).toContain(phrase)
		}
	})

	it('writes no documentation unless asked, names files by the project, and keeps lists and output real', () => {
		const text = composeFilePlacementGuidance()
		for (const phrase of [
			'Do not create documentation, report or README files unless the person asked for one',
			"follows the project's own file names and folders",
			'hyphenated English name with no spaces',
			'add the new one to that list',
			'never retyped',
		]) {
			expect(text, phrase).toContain(phrase)
		}
	})

	it('still asks before touching the home or root top level', () => {
		expect(composeFilePlacementGuidance()).toContain(
			'home folder or the filesystem root without asking',
		)
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
