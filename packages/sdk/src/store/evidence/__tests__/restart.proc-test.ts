import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

/**
 * Evidence read back by a process other than the one that wrote the session
 * log: the address, the cursor and the retained text must mean the same
 * thing to every reader of `<session-id>.jsonl`, and reading must never
 * write to the log.
 *
 * Every process imports the BUILT package, as a host does.
 */

const exec = promisify(execFile)
const sdk = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))

/**
 * One script, many roles. argv: sdk, root, scope (JSON), mode, input (JSON).
 *
 * - `open` claims the session, starts it and begins the turn.
 * - `append` appends each draft in `input` under a fresh claim of the lease
 *   (the previous writer's lease was given back or has lapsed).
 * - `close` settles the turn.
 * - `search` / `read` / `tools` open a fresh source and call it with `input`.
 */
const worker = `
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const root = process.argv[3], scope = JSON.parse(process.argv[4]), mode = process.argv[5]
const input = process.argv[6] ? JSON.parse(process.argv[6]) : undefined
const logPath = join(root, scope.sessionId + '.jsonl')
const log = new sdk.DiskSessionLog({ sessionId: scope.sessionId, file: logPath, sessionDir: join(root, scope.sessionId) })
const settlement = { status: 'completed', iterations: 1, durationMs: 1, resultSource: 'model', abandonedTaskIds: [], abandonedJobIds: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
  cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 } }
async function writing(body) {
  const lease = await log.claim({ holder: mode + ':' + process.pid, ttlMs: 60000 })
  if (!lease) throw new Error('the session is held')
  await body(lease)
  await log.release(lease)
}
const { topicId, ...evidenceScope } = scope
const source = (options = {}) => sdk.createSessionTextEvidenceSource({ scope: evidenceScope, logPath, ...options })
if (mode === 'open') {
  await writing(async (lease) => {
    await log.append(lease, { type: 'session_started', projectId: scope.projectId, tenantId: scope.tenantId,
      topicId, cwd: root, agent: { id: 'evidence', name: 'Evidence' } })
    await log.beginTurn(lease, { turnId: scope.turnId, userMessageId: sdk.generateMessageId(),
      config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 } })
  })
} else if (mode === 'append') {
  await writing(async (lease) => {
    const resumed = await log.activeTurn({ lease })
    // A new holder resumes the turn it did not start before writing to it.
    if (resumed?.state === 'interrupted') await log.append(lease, { type: 'turn_resuming', turnId: scope.turnId,
      fromCheckpointId: '00000000-0000-4000-8000-000000000000' })
    for (const draft of input) {
      if (draft.type === 'user') {
        const content = sdk.createUserMessage(draft.text, draft.attachmentBytes
          ? [{ data: 'A'.repeat(draft.attachmentBytes), mediaType: 'image/png' }] : undefined)
        await log.append(lease, { type: draft.shed ? 'compaction_shed' : 'message', turnId: scope.turnId,
          ...(draft.shed ? { iteration: 1, reason: 'threshold', messages: [content] }
            : { messageId: sdk.generateMessageId(), role: 'user', content }) })
      } else await log.append(lease, { turnId: scope.turnId, ...draft })
    }
  })
} else if (mode === 'close') {
  await writing((lease) => log.append(lease, { type: 'turn_completed', turnId: scope.turnId, result: 'done', settlement }))
} else if (mode === 'search') {
  console.log(JSON.stringify(await source(input.options).search(input.query)))
} else if (mode === 'read') {
  console.log(JSON.stringify(await source(input.options).read({ address: input.address })))
} else if (mode === 'tools') {
  const tools = sdk.createSessionEvidenceSource({ scope: evidenceScope, logPath })
  console.log(JSON.stringify(await tools[input.method](input.input)))
} else if (mode === 'shed') {
  const { entries } = await log.readAll()
  const shed = entries.map((e) => e.record).find((r) => r.type === 'compaction_shed')
  console.log(JSON.stringify({ imageBytes: shed.messages[0].attachments[0].data.length, gen: shed.gen }))
}
`

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function session() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-evidence-restart-'))
	roots.push(root)
	const script = join(root, 'worker.mjs')
	await writeFile(script, worker)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		topicId: randomUUID(),
		sessionId: randomUUID(),
		turnId: randomUUID(),
	}
	const child = async (mode: string, input?: unknown): Promise<any> => {
		const args = [script, sdk, root, JSON.stringify(scope), mode]
		if (input !== undefined) args.push(JSON.stringify(input))
		const { stdout } = await exec(process.execPath, args, {
			timeout: 20_000,
			maxBuffer: 1_000_000,
		})
		const line = stdout.trim()
		return line ? JSON.parse(line) : undefined
	}
	await child('open')
	return { root, scope, child, logPath: join(root, `${scope.sessionId}.jsonl`) }
}

it.each([false, true])(
	'reopens a turn still running across processes without repairing its log (torn: %s)',
	async (torn) => {
		const s = await session()
		await s.child('append', [
			{
				type: 'user',
				shed: true,
				text: 'ORCHID exact original α🦉',
				attachmentBytes: 3 * 1024 * 1024,
			},
		])
		if (torn) await writeFile(s.logPath, `${await readFile(s.logPath, 'utf8')}{"type":"unfinished`)
		const original = await readFile(s.logPath)

		const options = { consistency: 'snapshot' }
		const search = await s.child('search', { options, query: { query: 'ORCHID' } })
		// The turn is still open, so the evidence may grow.
		expect(search.incomplete).toBe(true)
		expect(search.unavailable).toEqual([])
		expect(search.matches).toHaveLength(1)
		const read = await s.child('read', { options, address: search.matches[0].address })
		expect(read.text).toBe('ORCHID exact original α🦉')
		expect(read.retained).toBe('full')
		expect(read.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		// A reader never truncates a torn tail, and never writes anything else.
		expect(await readFile(s.logPath)).toEqual(original)
	},
	60_000,
)

it('reads retained compaction text across processes, and the log keeps the whole attachment', async () => {
	const s = await session()
	await s.child('append', [
		{
			type: 'user',
			shed: true,
			text: 'ORCHID exact original A17',
			attachmentBytes: 3 * 1024 * 1024,
		},
	])
	await s.child('close')
	const first = await s.child('search', { query: { query: 'ORCHID' } })
	expect(first.incomplete).toBe(false)
	expect(first.matches).toHaveLength(1)
	const next = await s.child('read', { address: first.matches[0].address })
	expect(next.text).toBe('ORCHID exact original A17')
	expect(next.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
	const shed = await s.child('shed')
	expect(shed.imageBytes).toBe(3 * 1024 * 1024)
	expect(shed.gen).toBeGreaterThan(0)
}, 60_000)

it.each(['query', 'terms', 'tokens', 'refined'] as const)(
	'hands one process a cursor and an address that another process honours (%s)',
	async (mode) => {
		const search =
			mode === 'query'
				? { query: 'RECEIPT' }
				: {
						terms: ['absent', 'RECEIPT'],
						...(['tokens', 'refined'].includes(mode) ? { matchMode: 'token' } : {}),
					}
		const s = await session()
		await s.child(
			'append',
			Array.from({ length: 80 }, (_, i) => ({
				type: 'tool_completed',
				toolUseId: `call-${i}`,
				toolName: 'observe',
				isError: false,
				result: i === 79 ? 'ORIGINAL RECEIPT 🦉' : 'earlier unrelated output',
			})),
		)
		await s.child('close')
		const original = await readFile(s.logPath, 'utf8')
		const tools = (method: 'search' | 'read', input: unknown) => s.child('tools', { method, input })

		// Two processes at once page the same log the same way.
		const first = await Promise.all([tools('search', search), tools('search', search)])
		expect(first.every((page) => page.matches.length === 0 && page.nextCursor)).toBe(true)
		expect(first[0].nextCursor).toBe(first[1].nextCursor)
		// A third continues from the cursor the first one handed out.
		const found = await tools('search', {
			...search,
			cursor: first[0].nextCursor,
			...(mode === 'refined' ? { refineTerms: ['RECEIPT'] } : {}),
		})
		if (mode === 'refined') {
			const broadAgain = await tools('search', { ...search, cursor: first[0].nextCursor })
			expect(broadAgain.matches).toEqual(found.matches)
		}
		expect(found.matches).toHaveLength(1)
		const recordedAt = found.matches[0].recordedAt
		expect(typeof recordedAt).toBe('number')
		// And a fourth reads the address the third found.
		const read = await tools('read', { address: found.matches[0].address })
		expect(read.text).toBe('ORIGINAL RECEIPT 🦉')
		expect(read.recordedAt).toBe(recordedAt)
		expect(await readFile(s.logPath, 'utf8')).toBe(original)
	},
	60_000,
)

it('reads the same evidence after another process resumed the turn and wrote more', async () => {
	const s = await session()
	await s.child('append', [{ type: 'message_completed', content: 'original receipt 🦉' }])
	const options = { consistency: 'snapshot' }
	const first = await s.child('search', { options, query: { query: 'original receipt' } })
	expect(first.matches).toHaveLength(1)
	const firstRead = await s.child('read', { options, address: first.matches[0].address })
	expect(firstRead.text).toBe('original receipt 🦉')

	// A new holder takes the session, resumes the turn and writes to it.
	await s.child('append', [{ type: 'message_completed', content: 'new writer' }])

	const next = await s.child('search', { options, query: { query: 'original receipt' } })
	expect(next.matches).toHaveLength(1)
	// The record keeps its seq: the new writer appended after it, and nothing
	// before it moved.
	expect(next.matches[0].seq).toBe(first.matches[0].seq)
	expect(next.incomplete).toBe(true)
	const nextRead = await s.child('read', { options, address: next.matches[0].address })
	expect(nextRead.text).toBe(firstRead.text)
}, 60_000)
