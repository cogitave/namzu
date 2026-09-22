import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionPaths, slugForCwd } from '../../../session/paths.js'
import type { SessionId } from '../../../types/ids/index.js'

/**
 * Feedback written by one process, read by another.
 *
 * The point of a durable store is that the answer outlives the process that
 * gave it — and an in-memory implementation satisfies every assertion in
 * the conformance suite while failing that completely. Two runners in one
 * process share module state and would agree either way, so this needs real
 * `node` invocations.
 */

const DIST = join(import.meta.dirname, '../../../../dist/store/feedback/disk.js')
const DIST_PATHS = join(import.meta.dirname, '../../../../dist/session/paths.js')
const DIST_DIR = join(import.meta.dirname, '../../../../dist')
const WORKER = join(import.meta.dirname, 'feedback-cas-worker.mjs')
const FIXTURE_LOG = join(import.meta.dirname, '../../../__fixtures__/session-log/valid.jsonl')
const exec = promisify(execFile)
const UPDATE_RECORDS = 160
const SLUG = slugForCwd('/work/feedback')

// valid.jsonl: a real session log, and a message it holds.
const SESSION = '1b898770-f856-497c-a28f-8a3f5aefb0b1'
const MESSAGE = '18f2480c-1892-471c-8d5c-9c043b583e76'

/** A layout under `home` whose project holds the fixture session log. */
async function layout(home: string): Promise<void> {
	const paths = new SessionPaths({ home, slug: SLUG })
	await mkdir(paths.projectDir(), { recursive: true })
	await copyFile(FIXTURE_LOG, paths.sessionLog({ sessionId: SESSION as SessionId }))
}

/** The script prologue that opens the disk store over `home`'s layout in a child process. */
function openStore(home: string): string {
	return `const { DiskMessageFeedbackStore } = await import(${JSON.stringify(DIST)})
			const { SessionPaths } = await import(${JSON.stringify(DIST_PATHS)})
			const paths = new SessionPaths({ home: ${JSON.stringify(home)}, slug: ${JSON.stringify(SLUG)} })
			const store = new DiskMessageFeedbackStore({ paths })`
}

const dirs: string[] = []

afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true })
	dirs.length = 0
})

function run(script: string): string {
	return execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
}

describe('feedback survives the process that recorded it', () => {
	it('is readable, with its version, from a second node invocation', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-proc-'))
		dirs.push(root)
		await layout(root)

		run(`(async () => {
			${openStore(root)}
			await store.putMessageFeedback({ sessionId: '${SESSION}', messageId: '${MESSAGE}', rating: 'bad', note: 'wrong file', expectedVersion: 0 })
		})()`)

		const out = run(`(async () => {
			${openStore(root)}
			const listed = await store.listMessageFeedback({ sessionId: '${SESSION}' })
			process.stdout.write(JSON.stringify(listed))
		})()`)

		expect(JSON.parse(out)).toEqual([
			expect.objectContaining({
				sessionId: SESSION,
				messageId: MESSAGE,
				rating: 'bad',
				note: 'wrong file',
				ownerVersion: 1,
			}),
		])
	})

	it('refuses a second first-write from a different process', async () => {
		// The compare-and-set, across the boundary it actually has to hold
		// across. In one process the two writes are ordered by the event loop
		// and a broken store can still look correct; two processes give the
		// kernel's exclusive create nothing to hide behind.
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-proc2-'))
		dirs.push(root)
		await layout(root)

		const write = (rating: string) => `(async () => {
			${openStore(root)}
			try {
				await store.putMessageFeedback({ sessionId: '${SESSION}', messageId: '${MESSAGE}', rating: '${rating}', expectedVersion: 0 })
				process.stdout.write('ok')
			} catch (err) { process.stdout.write(err.name) }
		})()`

		expect(run(write('good'))).toBe('ok')
		expect(run(write('bad'))).toBe('StaleFeedbackError')
	})

	it('admits one version-one update per message across real processes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-update-proc-'))
		dirs.push(root)
		const sessionId = randomUUID() as SessionId
		const ids = Array.from({ length: UPDATE_RECORDS }, () => randomUUID())
		// This test is about compare-and-set across processes, not about the
		// session-log check (both-stores-agree covers that), so every process
		// accepts these ids through the same injected check.
		const known = new Set<string>(ids)
		const accept = async (_session: SessionId, messageId: string) => known.has(messageId)

		const { DiskMessageFeedbackStore } = await import('../disk.js')
		const paths = new SessionPaths({ home: root, slug: SLUG })
		const seed = new DiskMessageFeedbackStore({ paths }, accept)
		for (const messageId of ids) {
			await seed.putMessageFeedback({
				sessionId,
				messageId: messageId as never,
				rating: 'good',
				expectedVersion: 0,
			})
		}

		// Past process startup. Without a barrier one child can finish the
		// batch before another imports the SDK, which proves sequencing rather
		// than arbitration of the same expected version.
		const barrier = String(Date.now() + 1_500)
		const outputs = await Promise.all(
			Array.from({ length: 3 }, (_, index) =>
				exec(
					process.execPath,
					[WORKER, DIST_DIR, root, SLUG, JSON.stringify({ sessionId, ids }), `w${index}`, barrier],
					{ maxBuffer: 4 * 1024 * 1024 },
				),
			),
		)
		const results = outputs.map(
			({ stdout }) =>
				JSON.parse(stdout.trim()) as {
					won: {
						id: string
						rating: 'good' | 'bad'
						note: string
						worker: string
					}[]
					unexpected: { id: string; name?: string; message?: string }[]
				},
		)
		const byId = new Map<string, (typeof results)[number]['won']>()
		for (const result of results) {
			expect(result.unexpected).toEqual([])
			for (const winner of result.won) {
				byId.set(winner.id, [...(byId.get(winner.id) ?? []), winner])
			}
		}
		expect(byId.size).toBe(UPDATE_RECORDS)
		expect([...byId.values()].filter((winners) => winners.length !== 1)).toEqual([])

		const durable = await new DiskMessageFeedbackStore({ paths }, accept).listMessageFeedback({
			sessionId,
		})
		expect(durable).toHaveLength(UPDATE_RECORDS)
		for (const record of durable) {
			const winners = byId.get(record.messageId)
			expect(winners).toHaveLength(1)
			expect(record).toMatchObject({
				ownerVersion: 2,
				rating: winners?.[0]?.rating,
				note: winners?.[0]?.note,
			})
		}
	}, 60_000)
})
