import { describe, expect, it } from 'vitest'
import {
	LearningLeakError,
	assertNoLearningLeak,
	createLearningCanary,
	scanForLearningLeak,
} from './leak-tripwire.js'

describe('learning leak tripwire', () => {
	it('plants distinct canaries and finds one however it is dressed', () => {
		const canary = createLearningCanary()
		expect(createLearningCanary()).not.toBe(canary)
		const guard = { canaries: [canary] }
		const dressed = [
			`trace: ${canary}`,
			canary.toUpperCase(),
			canary.split('').join('​'),
			Buffer.from(canary).toString('base64'),
			Buffer.from(canary).toString('hex'),
		]
		for (const text of dressed) {
			const found = scanForLearningLeak(guard, [{ subject: 'failure.trace', text }])
			expect(found, text).toEqual([{ kind: 'canary', subject: 'failure.trace', rule: 'canary[0]' }])
		}
		expect(scanForLearningLeak(guard, [{ subject: 'x', text: 'an ordinary trace' }])).toEqual([])
	})

	it('finds a canary inside a larger base64 or hex blob at every alignment', () => {
		const canary = createLearningCanary()
		const guard = { canaries: [canary] }
		for (const lead of ['', 'x', 'xy', 'xyz']) {
			for (const tail of ['', 'q', 'qr']) {
				const raw = Buffer.from(`${lead}${canary}${tail}`)
				const forms = [
					raw.toString('base64'),
					raw.toString('base64url'),
					raw.toString('base64').replace(/(.{20})/g, '$1\n'),
					raw.toString('hex').toUpperCase(),
				]
				for (const text of forms)
					expect(
						scanForLearningLeak(guard, [{ subject: 's', text }]),
						`${lead}|${tail}|${text}`,
					).toHaveLength(1)
			}
		}
		expect(
			scanForLearningLeak(guard, [
				{ subject: 's', text: Buffer.from('nothing').toString('base64') },
			]),
		).toEqual([])
	})

	it('sees a built-in secret shape split by a zero-width character', () => {
		const text = `sk-aaaaaaaaaa${'\u200b'}aaaaaaaaaaaaaaa`
		expect(scanForLearningLeak(undefined, [{ subject: 's', text }])).toEqual([
			{ kind: 'secret', subject: 's', rule: 'default:api-key' },
		])
	})

	it('matches evaluator path globs on paths and on paths named inside text', () => {
		const guard = { paths: ['**/evaluator/**', 'fixtures/answers/*.json'] }
		expect(
			scanForLearningLeak(guard, [
				{ subject: 'candidate.sources', paths: ['./repo/evaluator/cases/1.md', 'src/app.ts'] },
			]),
		).toEqual([{ kind: 'path', subject: 'candidate.sources', rule: 'path[0]' }])
		const inText = scanForLearningLeak(guard, [
			{ subject: 'failure.trace', text: 'it read "fixtures/answers/7.json" first' },
		])
		expect(inText).toEqual([{ kind: 'path', subject: 'failure.trace', rule: 'path[1]' }])
		expect(
			scanForLearningLeak(guard, [
				{ subject: 'p', paths: ['fixtures/answers/deep/7.json', 'src/a.ts'] },
			]),
		).toEqual([])
	})

	it('flags grader-verdict wording and protected contents but not long innocent text', () => {
		const protectedText = 'Rename the exported helper without touching its callers.'
		const found = scanForLearningLeak({ protectedContents: [protectedText] }, [
			{ subject: 'a', text: 'The Grader  Verdict was pass.' },
			{ subject: 'b', text: 'task: rename   the exported helper without touching its callers.' },
			{ subject: 'c', text: 'A trace about renaming a helper and its callers.' },
		])
		expect(found.map((f) => `${f.subject}:${f.kind}`).sort()).toEqual([
			'a:marker',
			'b:protected-content',
		])
	})

	it('flags secrets, built-in shapes and host literals', () => {
		const literal = 'hunter2-hunter2'
		const found = scanForLearningLeak({ secrets: [literal] }, [
			{ subject: 'a', text: `key sk-${'a1'.repeat(14)}` },
			{ subject: 'b', text: `password ${literal}` },
			{ subject: 'c', text: '-----BEGIN RSA PRIVATE KEY-----' },
		])
		expect(found.map((f) => `${f.subject}:${f.kind}`).sort()).toEqual([
			'a:secret',
			'b:secret',
			'c:secret',
		])
	})

	it('never repeats the matched text and says plainly that it is a leak', () => {
		const canary = createLearningCanary()
		let error: unknown
		try {
			assertNoLearningLeak({ canaries: [canary] }, [{ subject: 'candidate.body', text: canary }])
		} catch (e) {
			error = e
		}
		expect(error).toBeInstanceOf(LearningLeakError)
		const message = (error as Error).message
		expect(message).toContain('a leak, not a false positive')
		expect(message).toContain('candidate.body')
		expect(message).not.toContain(canary)
		expect(JSON.stringify((error as LearningLeakError).findings)).not.toContain(canary)
	})

	it('rejects guards that would match innocently', () => {
		expect(() => scanForLearningLeak({ canaries: ['abc'] }, [])).toThrow(/canary/)
		expect(() => scanForLearningLeak({ protectedContents: ['short'] }, [])).toThrow(/Protected/)
		expect(() => scanForLearningLeak({ markers: [/x/g] }, [])).toThrow(/global/)
	})
})
