import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTextEvidenceSource } from '../disk.js'
import { evidenceSession } from './support/session-log.js'

/**
 * Every search page makes several accesses to the log, and each one parsed
 * the whole log again to learn its first record and whether a turn is open.
 * The records parsed are counted here, never timed.
 */
const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function session(records: number) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-access-'))
	roots.push(root)
	const s = await evidenceSession(root)
	for (let i = 0; i < records; i++) {
		await s.append({ type: 'session_updated', title: `title ${i}` })
	}
	return s
}

/** How many JSON documents `action` parses. */
async function parsedBy(action: () => Promise<unknown>): Promise<number> {
	const parse = vi.spyOn(JSON, 'parse')
	try {
		await action()
		return parse.mock.calls.length
	} finally {
		parse.mockRestore()
	}
}

describe('an access to a session log', () => {
	it('parses the records appended since the last one, not the whole log', async () => {
		const parsed: number[] = []
		for (const records of [50, 200]) {
			const s = await session(records)
			await s.close()
			const source = createSessionTextEvidenceSource({ scope: s.scope, logPath: s.logPath })
			await source.search({ query: 'zzz-nothing-matches' }) // the first access scans it all
			parsed.push(await parsedBy(() => source.search({ query: 'zzz-nothing-matches' })))
		}
		// The search's own index reads grow a little with the log; re-parsing every
		// record would add a parse for each of the 150 records the larger log has more.
		expect(parsed[1]! - parsed[0]!).toBeLessThan(150 / 4)
	})

	it('sees a turn close, and a log that was replaced, as before', async () => {
		const s = await session(5)
		const open = createSessionTextEvidenceSource({ scope: s.scope, logPath: s.logPath })
		await expect(open.search()).rejects.toThrow('not closed')
		await expect(open.search()).rejects.toThrow('not closed')
		await s.close()
		await expect(open.search({ query: 'title' })).resolves.toBeDefined()
		const wrongTenant = createSessionTextEvidenceSource({
			scope: { ...s.scope, projectId: '00000000-0000-4000-8000-000000000000' as never },
			logPath: s.logPath,
		})
		await expect(wrongTenant.search()).rejects.toThrow('does not belong')
	})
})
