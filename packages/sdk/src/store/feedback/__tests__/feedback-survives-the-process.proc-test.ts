import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

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
const DIST_DIR = join(import.meta.dirname, '../../../../dist')
const WORKER = join(import.meta.dirname, 'feedback-cas-worker.mjs')
const exec = promisify(execFile)
const UPDATE_RECORDS = 160

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
		const runsDir = join(root, 'runs')
		const feedbackDir = join(root, 'feedback')
		await mkdir(join(runsDir, 'ea18dfb2-57ba-47cc-b667-56a2426d0584'), { recursive: true })
		await writeFile(
			join(runsDir, 'ea18dfb2-57ba-47cc-b667-56a2426d0584', 'transcript.jsonl'),
			`${JSON.stringify({ seq: 1, type: 'text_delta', runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584', messageId: '5beb2a6b-4ab4-4213-b124-96481a5b058a' })}\n`,
		)

		const common = `const { DiskMessageFeedbackStore } = await import(${JSON.stringify(DIST)})
			const store = new DiskMessageFeedbackStore({ rootDir: ${JSON.stringify(feedbackDir)}, runsDir: ${JSON.stringify(runsDir)} })`

		run(`(async () => {
			${common}
			await store.putMessageFeedback({ runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584', messageId: '5beb2a6b-4ab4-4213-b124-96481a5b058a', rating: 'bad', note: 'wrong file', expectedVersion: 0 })
		})()`)

		const out = run(`(async () => {
			${common}
			const listed = await store.listMessageFeedback({ runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584' })
			process.stdout.write(JSON.stringify(listed))
		})()`)

		expect(JSON.parse(out)).toEqual([
			expect.objectContaining({
				runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584',
				messageId: '5beb2a6b-4ab4-4213-b124-96481a5b058a',
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
		const runsDir = join(root, 'runs')
		await mkdir(join(runsDir, 'ea18dfb2-57ba-47cc-b667-56a2426d0584'), { recursive: true })
		await writeFile(
			join(runsDir, 'ea18dfb2-57ba-47cc-b667-56a2426d0584', 'transcript.jsonl'),
			`${JSON.stringify({ seq: 1, type: 'text_delta', runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584', messageId: '5beb2a6b-4ab4-4213-b124-96481a5b058a' })}\n`,
		)
		const feedbackDir = join(root, 'feedback')

		const write = (rating: string) => `(async () => {
			const { DiskMessageFeedbackStore } = await import(${JSON.stringify(DIST)})
			const store = new DiskMessageFeedbackStore({ rootDir: ${JSON.stringify(feedbackDir)}, runsDir: ${JSON.stringify(runsDir)} })
			try {
				await store.putMessageFeedback({ runId: 'ea18dfb2-57ba-47cc-b667-56a2426d0584', messageId: '5beb2a6b-4ab4-4213-b124-96481a5b058a', rating: '${rating}', expectedVersion: 0 })
				process.stdout.write('ok')
			} catch (err) { process.stdout.write(err.name) }
		})()`

		expect(run(write('good'))).toBe('ok')
		expect(run(write('bad'))).toBe('StaleFeedbackError')
	})

	it('admits one version-one update per message across real processes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-feedback-update-proc-'))
		dirs.push(root)
		const runsDir = join(root, 'runs')
		const feedbackDir = join(root, 'feedback')
		const runId = randomUUID()
		const runDir = join(runsDir, runId)
		const ids = Array.from({ length: UPDATE_RECORDS }, () => randomUUID())
		await mkdir(runDir, { recursive: true })
		await writeFile(
			join(runDir, 'transcript.jsonl'),
			`${ids
				.map((messageId, index) =>
					JSON.stringify({
						seq: index + 1,
						type: 'text_delta',
						runId,
						messageId,
					}),
				)
				.join('\n')}\n`,
		)

		const { DiskMessageFeedbackStore } = await import('../disk.js')
		const seed = new DiskMessageFeedbackStore({
			rootDir: feedbackDir,
			runsDir,
		})
		for (const messageId of ids) {
			await seed.putMessageFeedback({
				runId: runId as never,
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
					[
						WORKER,
						DIST_DIR,
						feedbackDir,
						runsDir,
						JSON.stringify({ runId, ids }),
						`w${index}`,
						barrier,
					],
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

		const durable = await new DiskMessageFeedbackStore({
			rootDir: feedbackDir,
			runsDir,
		}).listMessageFeedback({ runId: runId as never })
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
