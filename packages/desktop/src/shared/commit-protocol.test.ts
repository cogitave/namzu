import { describe, expect, it } from 'vitest'
import { readCommitOutcome, readCommitPreview } from './commit-protocol.js'

describe('readCommitPreview', () => {
	const good = {
		files: [{ path: 'a.ts', state: 'modified', fingerprint: 'abc', extra: 1 }],
		otherDirty: 2,
		skippedSecrets: 0,
		branch: 'trunk',
		detached: false,
		suggestedMessage: 'Update a.ts',
		messageSource: 'model',
		secret: 'dropped',
	}
	it('keeps the known fields only', () => {
		expect(readCommitPreview(good)).toEqual({
			files: [{ path: 'a.ts', state: 'modified', fingerprint: 'abc' }],
			otherDirty: 2,
			skippedSecrets: 0,
			branch: 'trunk',
			detached: false,
			suggestedMessage: 'Update a.ts',
			messageSource: 'model',
		})
	})
	it('drops files that do not read and treats bad counts as none', () => {
		const out = readCommitPreview({
			...good,
			files: [
				null,
				{ path: '', state: 'modified', fingerprint: 'x' },
				{ path: 'b', state: 'weird', fingerprint: 'x' },
				{ path: 'c', state: 'added', fingerprint: 'y' },
			],
			otherDirty: -4,
			blocker: 'Trust this folder to commit in it.',
		})
		expect(out?.files).toEqual([{ path: 'c', state: 'added', fingerprint: 'y' }])
		expect(out?.otherDirty).toBe(0)
		expect(out?.blocker).toBe('Trust this folder to commit in it.')
		expect(readCommitPreview({ ...good, skippedLocalSettings: 2 })?.skippedLocalSettings).toBe(2)
		expect(readCommitPreview({ ...good, skippedLocalSettings: -1 })).not.toHaveProperty(
			'skippedLocalSettings',
		)
	})
	it('refuses frames that do not read', () => {
		for (const bad of [null, 'x', [], {}, { files: 'x' }, { files: [] }])
			expect(readCommitPreview(bad)).toBeUndefined()
	})
	it('treats an unknown message source as plain and a missing branch as none', () => {
		const out = readCommitPreview({
			...good,
			messageSource: 'oracle',
			branch: null,
			detached: true,
		})
		expect(out).toMatchObject({ messageSource: 'plain', branch: null, detached: true })
	})
})

describe('readCommitOutcome', () => {
	it('reads a commit, or the reason there was none', () => {
		expect(readCommitOutcome({ ok: true, hash: 'abc1234', subject: 'Fix it' })).toEqual({
			ok: true,
			hash: 'abc1234',
			subject: 'Fix it',
		})
		expect(readCommitOutcome({ ok: false, reason: 'the hook says no\u0007' })).toEqual({
			ok: false,
			reason: 'the hook says no',
		})
	})
	it('refuses what is neither', () => {
		for (const bad of [
			null,
			{},
			{ ok: true },
			{ ok: true, hash: 'xyz!', subject: 'x' },
			{ ok: false },
			{ ok: false, reason: '  ' },
			{ hash: 'abc', subject: 'x' },
		])
			expect(readCommitOutcome(bad)).toBeUndefined()
	})
})
