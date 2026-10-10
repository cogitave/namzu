import { describe, expect, it } from 'vitest'

import { explainFailure } from './plain-failure.js'

describe('a failure the app hit itself', () => {
	it('maps known causes to a sentence', () => {
		const eacces = Object.assign(new Error("EACCES: permission denied, open '/x/y'"), {
			code: 'EACCES',
		})
		expect(explainFailure(eacces, 'Could not save the name.', false)).toBe(
			'Could not save the name. Namzu does not have permission to write its files.',
		)
	})

	it('shows a finished sentence Namzu wrote for a person, and nothing that reads as machine output', () => {
		expect(
			explainFailure(
				new Error('Wait for the work to finish. Use /model after.'),
				'Could not switch.',
				false,
			),
		).toBe('Could not switch. Wait for the work to finish. Use /model after.')
		for (const message of [
			'Candidate unavailable',
			'ENOENT: no such file',
			'Cannot open /home/ada/x.json.',
			'Unexpected token { in JSON.',
			'Value was undefined here.',
			'SQLITE_BUSY: database is locked.',
		]) {
			expect(explainFailure(new Error(message), 'Could not fork.', false)).toBe(
				'Could not fork. Run with --debug for details.',
			)
		}
		expect(
			explainFailure(new TypeError('Nope nope nope nope.'), 'Could not fork.', false),
		).toContain('--debug')
	})

	it('never pastes an unknown error’s text unless detail was asked for', () => {
		expect(explainFailure(new Error('SQLITE_BUSY at /home/x/db'), 'Could not fork.', false)).toBe(
			'Could not fork. Run with --debug for details.',
		)
		expect(explainFailure(new Error('SQLITE_BUSY'), 'Could not fork.', true)).toBe(
			'Could not fork. Run with --debug for details. (SQLITE_BUSY)',
		)
		expect(explainFailure('plain string', 'Could not fork.', false)).not.toContain('plain string')
	})
})
