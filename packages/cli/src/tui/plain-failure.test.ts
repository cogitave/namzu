import { NamzuError } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	StartupRefusal,
	explainFailure,
	isMachineError,
	workingDirectoryProblem,
} from './plain-failure.js'

describe('a failure the app hit itself', () => {
	it('shows the memory lock path and recovery condition without requiring debug mode', () => {
		const error = new NamzuError({
			code: 'storage_error',
			message: 'Memory operation lock acquisition timed out.',
			details: { lockPath: '/fixture/memory/operation.lock', timeoutMs: 10_000 },
		})
		const text = explainFailure(error, 'Stored memory index not loaded.', false)
		expect(text).toContain('Stored memory is locked at /fixture/memory/operation.lock.')
		expect(text).toContain('Close Namzu sessions using this memory store')
		expect(text).toContain('inspect the lock owner')
		expect(text).not.toContain('--debug')
	})

	it('does not diagnose other storage failures as an occupied memory lock', () => {
		for (const details of [undefined, {}, { lockPath: '/fixture', timeoutMs: '10000' }]) {
			const error = new NamzuError({
				code: 'storage_error',
				message: 'Unexpected storage failure.',
				...(details ? { details } : {}),
			})
			expect(explainFailure(error, 'Stored memory index not loaded.', false)).toContain('--debug')
		}
	})

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
			'Could not fork. Details: SQLITE_BUSY.',
		)
		expect(explainFailure('plain string', 'Could not fork.', false)).not.toContain('plain string')
	})
})

describe('startup sentences', () => {
	it('keeps a refusal that is already a sentence, even with a path in it', () => {
		const refusal = new StartupRefusal('Namzu could not open the folder ~/x. It does not exist.')
		expect(explainFailure(refusal, 'Could not start the selected provider.', false)).toBe(
			'Could not start the selected provider. Namzu could not open the folder ~/x. It does not exist.',
		)
	})
	it('tells a system error from a sentence', () => {
		expect(
			isMachineError(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })),
		).toBe(true)
		expect(isMachineError(new TypeError('x is not a function'))).toBe(true)
		expect(isMachineError('text')).toBe(true)
		expect(isMachineError(new Error('Run namzu state to repair the split histories.'))).toBe(false)
	})
	it('words a missing or unreadable working folder with the next step', () => {
		const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
		expect(workingDirectoryProblem('/srv/none', missing, false)).toBe(
			'Namzu could not open the folder /srv/none. It does not exist. Check the path, then try again.',
		)
		const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' })
		expect(workingDirectoryProblem('/srv/none', denied, false)).toContain(
			'does not have permission',
		)
		expect(workingDirectoryProblem('/srv/none', new Error('weird'), false)).toBe(
			'Namzu could not open the folder /srv/none. Run with --debug for details. Choose another folder.',
		)
	})
	it('shows the error text only as labelled Details with --debug', () => {
		expect(
			explainFailure(new Error('weird'), 'Computer use is unavailable on this device.', true),
		).toBe('Computer use is unavailable on this device. Details: weird.')
	})
})
