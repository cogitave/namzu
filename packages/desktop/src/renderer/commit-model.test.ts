import { describe, expect, it } from 'vitest'
import type { CommitPreviewView } from '../shared/commit-protocol.js'
import { changedPaths, commitButtonState, commitDialogModel } from './commit-model.js'

describe('when Commit changes works', () => {
	const ok = { hasChanges: true, trusted: true, repository: true, running: false }
	it('works with edits in a trusted repository while no reply is being written', () => {
		expect(commitButtonState(ok)).toEqual({ enabled: true })
	})
	it('says why it is off, in this order of importance', () => {
		expect(commitButtonState({ ...ok, hasChanges: false }).reason).toBe('Nothing to commit')
		expect(commitButtonState({ ...ok, trusted: false }).reason).toBe(
			'Trust this folder to commit in it',
		)
		expect(commitButtonState({ ...ok, repository: false }).reason).toBe(
			'Commit needs a Git repository',
		)
		expect(commitButtonState({ ...ok, running: true }).reason).toBe('Wait for the reply to finish')
		expect(commitButtonState({ ...ok, hasChanges: false, trusted: false }).reason).toBe(
			'Nothing to commit',
		)
		expect(commitButtonState({ ...ok, trusted: false }).enabled).toBe(false)
	})
})

const preview = (over: Partial<CommitPreviewView> = {}): CommitPreviewView => ({
	files: [
		{ path: 'a.ts', state: 'modified', fingerprint: 'f1' },
		{ path: 'b.ts', state: 'added', fingerprint: 'f2' },
	],
	otherDirty: 0,
	skippedSecrets: 0,
	branch: 'trunk',
	detached: false,
	suggestedMessage: 'Update a.ts, b.ts',
	messageSource: 'plain',
	...over,
})

describe('the dialog', () => {
	it('commits the ticked files with a message, and always says Namzu will not push', () => {
		const model = commitDialogModel(preview(), new Set(['a.ts']), 'Fix it')
		expect(model).toMatchObject({ paths: ['a.ts'], canCommit: true })
		expect(model.lines).toEqual(['Namzu will not push.'])
	})
	it('is off with nothing ticked or no message, and names why', () => {
		expect(commitDialogModel(preview(), new Set(), 'x')).toMatchObject({
			canCommit: false,
			reason: 'Choose at least one file.',
		})
		expect(commitDialogModel(preview(), new Set(['a.ts']), '   ')).toMatchObject({
			canCommit: false,
			reason: 'Write a message.',
		})
	})
	it('is off for a blocker whatever else is true', () => {
		const model = commitDialogModel(
			preview({ blocker: 'A merge is in progress.' }),
			new Set(['a.ts']),
			'x',
		)
		expect(model).toMatchObject({ canCommit: false, reason: 'A merge is in progress.' })
	})
	it('says what is not included, what was left out, and when there is no branch', () => {
		const model = commitDialogModel(
			preview({ otherDirty: 1, skippedSecrets: 2, detached: true }),
			new Set(['a.ts']),
			'x',
		)
		expect(model.lines).toEqual([
			'1 other change will not be included.',
			'2 files left out: the name suggests it may hold a secret.',
			'You are not on a branch.',
			'Namzu will not push.',
		])
		expect(
			commitDialogModel(preview({ skippedLocalSettings: 1 }), new Set(['a.ts']), 'x').lines,
		).toEqual([
			'Namzu’s settings file for this computer is left out: it holds your own answers, not the project’s.',
			'Namzu will not push.',
		])
		expect(commitDialogModel(preview({ otherDirty: 3 }), new Set(), 'x').lines[0]).toBe(
			'3 other changes will not be included.',
		)
	})
})

describe('the files a conversation changed', () => {
	it('are the receipts’ paths, once each, without the ones that have none', () => {
		expect(changedPaths([{ path: 'a' }, { path: 'a' }, {}, { path: 'b' }])).toEqual(['a', 'b'])
	})
})
