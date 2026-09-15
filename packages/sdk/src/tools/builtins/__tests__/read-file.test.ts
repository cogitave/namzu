import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { fingerprintContent } from '../content-fingerprint.js'
import { ReadFileTool } from '../read-file.js'
import { renderNumberedRead } from '../read-render.js'

function makeContext(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
	return {
		runId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extras,
	}
}

/** A sandbox whose only file is `body`, whatever path is asked for. */
function sandboxOver(body: string): Sandbox {
	return {
		id: 'f0f0d1d0-6a4c-4a3f-9ba7-2f8a7cf6b1c4' as Sandbox['id'],
		status: 'ready',
		rootDir: '/sandbox',
		environment: 'basic',
		readFile: async () => Buffer.from(body, 'utf-8'),
	} as unknown as Sandbox
}

describe('ReadFileTool', () => {
	it('accepts readRange as a 1-indexed inclusive line range', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'doc.md'), ['one', 'two', 'three', 'four'].join('\n'))

		const result = await ReadFileTool.execute(
			{ path: 'doc.md', readRange: [2, 3] },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('2\ttwo\n3\tthree')
		// A window over a longer file now says so: the model must be able to
		// tell "these are all the lines" from "these are the lines I asked
		// for", or it reasons about a fragment as if it were the file.
		expect(result.output).toContain('PARTIAL view — lines 2-3 of 4')
		expect(result.data).toMatchObject({ truncated: true, returnedLines: 2, totalLines: 4 })
	})

	it('adds no partial-view notice when the whole file was returned', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'doc.md'), ['one', 'two'].join('\n'))

		const result = await ReadFileTool.execute({ path: 'doc.md' }, makeContext(dir))

		expect(result.output).toBe('1\tone\n2\ttwo')
		expect(result.data).toMatchObject({ truncated: false })
	})

	it('defaults to a bounded window instead of returning an entire large file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
		writeFileSync(join(dir, 'big.txt'), lines.join('\n'))

		const result = await ReadFileTool.execute({ path: 'big.txt' }, makeContext(dir))

		expect(result.data).toMatchObject({ returnedLines: 2000, totalLines: 5000, truncated: true })
		expect(result.output).toContain('PARTIAL view — lines 1-2000 of 5000')
		// The notice names the exact next call rather than describing it.
		expect(result.output).toContain('offset: 2000')
	})

	it('guides binary Office documents through extractor tooling', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'transcript.docx'), Buffer.from('PK\x03\x04binary-docx'))

		const result = await ReadFileTool.execute({ path: 'transcript.docx' }, makeContext(dir))

		expect(result.success).toBe(false)
		expect(result.output).toContain('DOCX document package')
		expect(result.output).toContain('python-docx')
		expect(result.data).toMatchObject({ binary: true })
	})
})

/**
 * Canonical, because the tool keys the observation ledger through
 * `resolveWithinAnyReal` (realpath) and `os.tmpdir()` is itself a symlink on
 * macOS — a host-branch expectation keyed on the raw temp dir would find
 * nothing there.
 */
function mkRealTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * What the ledger learns from a read, which is two separate things.
 *
 * The fingerprint is of the FILE and is the drift guard's — a window must not
 * move it, or the next edit is checked against a fragment. The witness is of
 * this CALL's rendering and only a whole-file read has one, because a window
 * shows a fragment and no fingerprint of the file says which.
 */
describe('what a read tells the observation ledger', () => {
	const body = ['one', 'two', 'three', 'four'].join('\n')

	for (const [branch, contextFor] of [
		[
			'on the host',
			(dir: string, tracker: FileReadTracker) => {
				writeFileSync(join(dir, 'doc.md'), body)
				return makeContext(dir, { fileReadTracker: tracker, toolUseId: 'call-1' })
			},
		],
		[
			'in a sandbox',
			(dir: string, tracker: FileReadTracker) =>
				makeContext(dir, {
					fileReadTracker: tracker,
					toolUseId: 'call-1',
					sandbox: sandboxOver(body),
				}),
		],
	] as const) {
		it(`fingerprints the whole file and witnesses only the unwindowed read ${branch}`, async () => {
			const dir = mkRealTempDir('namzu-read-ledger-')
			const key = branch === 'in a sandbox' ? 'doc.md' : join(dir, 'doc.md')

			for (const window of [
				{ readRange: [2, 3] as [number, number] },
				{ offset: 1 },
				{ limit: 2 },
			]) {
				const tracker = createFileReadTracker()
				const result = await ReadFileTool.execute(
					{ path: 'doc.md', ...window },
					contextFor(dir, tracker),
				)
				expect(result.data).toMatchObject({ truncated: true })
				expect(tracker.fingerprint?.(key)).toBe(fingerprintContent(body))
				expect(tracker.readWitness?.(key)).toBeUndefined()
			}

			const tracker = createFileReadTracker()
			const whole = await ReadFileTool.execute({ path: 'doc.md' }, contextFor(dir, tracker))
			expect(whole.data).toMatchObject({ truncated: false })
			expect(tracker.fingerprint?.(key)).toBe(fingerprintContent(body))
			// The witness is of what the model will SEE, not of the body: the
			// receipt is the only place that body still exists for a later turn.
			expect(tracker.readWitness?.(key)).toEqual({
				callId: 'call-1',
				renderedFingerprint: fingerprintContent(whole.output),
			})
			expect(fingerprintContent(whole.output)).toBe(
				fingerprintContent(renderNumberedRead(body, {}).output),
			)
		})
	}

	it('records an ordinary observation against a tracker that cannot hold a witness', async () => {
		const dir = mkRealTempDir('namzu-read-ledger-')
		writeFileSync(join(dir, 'doc.md'), body)
		const seen = new Map<string, string | undefined>()
		const older: FileReadTracker = {
			recordRead: (key, content) => void seen.set(key, content),
			hasRead: (key) => seen.has(key),
		}

		await ReadFileTool.execute(
			{ path: 'doc.md' },
			makeContext(dir, { fileReadTracker: older, toolUseId: 'call-1' }),
		)

		expect(seen.get(join(dir, 'doc.md'))).toBe(body)
	})

	it('witnesses nothing when the executor gave the call no id', async () => {
		const dir = mkRealTempDir('namzu-read-ledger-')
		writeFileSync(join(dir, 'doc.md'), body)
		const tracker = createFileReadTracker()

		await ReadFileTool.execute({ path: 'doc.md' }, makeContext(dir, { fileReadTracker: tracker }))

		expect(tracker.fingerprint?.(join(dir, 'doc.md'))).toBe(fingerprintContent(body))
		expect(tracker.readWitness?.(join(dir, 'doc.md'))).toBeUndefined()
	})
})
