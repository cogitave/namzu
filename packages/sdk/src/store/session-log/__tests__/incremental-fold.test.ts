import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evidenceSession } from '../../evidence/__tests__/support/session-log.js'
import { SessionLogIntegrityError } from '../chain.js'
import { foldSessionLog } from '../incremental.js'

/**
 * Every turn asked the whole log the same questions again, parsing and
 * verifying every record the session had ever written. A reduction now
 * advances from the last record it folded. The records folded are counted
 * here, never timed.
 */
const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function session(updates: number) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-incremental-'))
	roots.push(root)
	const s = await evidenceSession(root)
	for (let i = 0; i < updates; i++) await s.append({ type: 'session_updated', title: `t${i}` })
	return s
}

/** A reduction that lists titles and counts the records it was handed. */
function titles(mode: 'strict' | 'tolerant', counter: { applied: number }, name = 'titles') {
	return {
		name,
		mode,
		create: () => [] as string[],
		apply: (list: string[], entry: { record: { type: string; title?: unknown } }) => {
			counter.applied++
			if (entry.record.type === 'session_updated') list.push(String(entry.record.title))
		},
		result: (list: string[]) => [...list],
	} as const
}

describe('a reduction over a session log', () => {
	it.each(['strict', 'tolerant'] as const)(
		'folds only the records appended since its last answer (%s)',
		async (mode) => {
			const folded: number[] = []
			for (const updates of [10, 40]) {
				const s = await session(updates)
				const counter = { applied: 0 }
				const first = await foldSessionLog(s.log, titles(mode, counter))
				expect(first).toHaveLength(updates)
				const afterFirst = counter.applied
				await s.append({ type: 'session_updated', title: 'new' })
				const second = await foldSessionLog(s.log, titles(mode, counter))
				expect(second.at(-1)).toBe('new')
				expect(second).toHaveLength(updates + 1)
				folded.push(counter.applied - afterFirst)
				// Nothing appended: nothing folded.
				const before = counter.applied
				await foldSessionLog(s.log, titles(mode, counter))
				expect(counter.applied).toBe(before)
			}
			// Four times the log, the same work for the one record added.
			expect(folded).toEqual([1, 1])
		},
	)

	it('answers as a fresh walk does, whichever log instance asks', async () => {
		const s = await session(6)
		const counter = { applied: 0 }
		await foldSessionLog(s.log, titles('strict', counter))
		await s.append({ type: 'session_updated', title: 'later' })
		const warm = await foldSessionLog(s.log, titles('strict', counter))
		const cold = await foldSessionLog(s.log, titles('strict', counter, 'another-name'))
		expect(warm).toEqual(cold)
	})

	it('starts again from the first record when the log no longer holds the one it stopped at', async () => {
		const s = await session(5)
		const counter = { applied: 0 }
		await foldSessionLog(s.log, titles('tolerant', counter))
		// The same session, rewritten: the record the reduction stopped at is gone.
		const lines = (await readFile(s.logPath, 'utf8')).split('\n').filter(Boolean)
		await writeFile(s.logPath, `${lines.slice(0, 4).join('\n')}\n`)
		const again = await foldSessionLog(s.log, titles('tolerant', counter))
		const fresh = await foldSessionLog(s.log, titles('tolerant', counter, 'fresh'))
		expect(again).toEqual(fresh)
		expect(again.length).toBeLessThan(5)
	})

	it('still refuses a broken chain in strict mode, from a cold start and past a damaged anchor', async () => {
		const s = await session(5)
		const counter = { applied: 0 }
		await foldSessionLog(s.log, titles('strict', counter))
		// Damage the record the reduction stopped at, then let the writer append after it.
		const lines = (await readFile(s.logPath, 'utf8')).split('\n').filter(Boolean)
		lines[lines.length - 1] = lines[lines.length - 1]!.replace('"t4"', '"tX"')
		await writeFile(s.logPath, `${lines.join('\n')}\n`)
		await s.append({ type: 'session_updated', title: 'after' })
		// Warm: the anchor no longer matches, so the fold restarts from byte 0 and refuses.
		await expect(foldSessionLog(s.log, titles('strict', counter))).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
		// A failed fold leaves nothing behind: the next one starts cold and refuses again.
		await expect(foldSessionLog(s.log, titles('strict', counter))).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
	})
})
