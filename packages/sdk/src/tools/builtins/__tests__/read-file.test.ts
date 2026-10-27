import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import { findPortableSchemaViolations } from '../../../registry/tool/portable.js'
import { renderToolSchema } from '../../../registry/tool/schema.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { fingerprintContent } from '../content-fingerprint.js'
import { ReadFileTool } from '../read-file.js'
import { renderNumberedRead } from '../read-render.js'

function makeContext(workingDirectory: string, extras: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
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

describe("read's window, as the model is shown it", () => {
	/**
	 * `readRange` was the only `z.tuple` in the first-party tool surface, and
	 * it rendered as the draft-07 tuple `items: [a, b]` — which the Zen Console
	 * gateway, validating `parameters` against the JSON Schema 2020-12
	 * metaschema, refused with
	 *
	 *     [{'minimum': 1, 'type': 'integer'}, {'minimum': 1, 'type': 'integer'}]
	 *     is not of type 'object', 'boolean'
	 *
	 * taking every other tool in the request down with it. The parameter is now
	 * a length-pinned array of the same element, which both dialects spell
	 * identically. What the model writes did not change.
	 */
	it('spells the range as one element schema plus a pinned length', () => {
		const rendered = renderToolSchema(ReadFileTool.inputSchema) as {
			properties: { readRange: Record<string, unknown> }
		}

		expect(rendered.properties.readRange).toMatchObject({
			type: 'array',
			items: { type: 'integer', minimum: 1 },
			minItems: 2,
			maxItems: 2,
		})
		expect(Array.isArray(rendered.properties.readRange.items)).toBe(false)
		expect(findPortableSchemaViolations(rendered)).toEqual([])
	})

	it.each([
		[[10, 40], true],
		[['10', '40'], true],
		[[10], false],
		[[10, 20, 30], false],
		[['a', 'b'], false],
		[[0, 5], false],
		[[1.5, 2], false],
		[[], false],
	])('parses %j exactly as the tuple did (%s)', (readRange, accepted) => {
		// The model-facing contract, pinned against the shape it replaced. A
		// wire schema that describes a looser parameter than the parser accepts
		// is a hint the model can only get wrong once.
		const result = ReadFileTool.inputSchema.safeParse({ path: 'a.txt', readRange })
		expect(result.success).toBe(accepted)
		if (result.success) expect(result.data.readRange).toEqual([10, 40])
	})

	it('still describes the range to the model as [start, end]', () => {
		expect(ReadFileTool.description).toContain('readRange ([start,end], 1-indexed inclusive)')
	})
})

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

	it('directs actual image bytes to visual inspection instead of recording a text observation', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		const bytes = Buffer.from(
			encode({ width: 1, height: 1, channels: 3, data: new Uint8Array([90, 90, 90]) }),
		)
		writeFileSync(join(dir, 'reference.txt'), bytes)
		const tracker = createFileReadTracker()
		const result = await ReadFileTool.execute(
			{ path: 'reference.txt' },
			makeContext(dir, { fileReadTracker: tracker }),
		)
		expect(result.success).toBe(false)
		expect(result.output).toContain('PNG raster image')
		expect(result.output).toContain('view_image')
		expect(result.data).toMatchObject({ binary: true })
		expect(tracker.hasRead(join(dir, 'reference.txt'))).toBe(false)
	})

	it('does not classify ordinary text as an image just because its extension is .png', async () => {
		const result = await ReadFileTool.execute(
			{ path: 'notes.png' },
			makeContext('/host', { sandbox: sandboxOver('ordinary text') }),
		)
		expect(result.success).toBe(true)
		expect(result.output).toBe('1\tordinary text')
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

describe("read opens this session's own retained output, and nothing else outside the roots", () => {
	const setup = () => {
		const work = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-read-work-')))
		const retained = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-read-retained-')))
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-read-outside-')))
		return {
			work,
			retained,
			outside,
			context: makeContext(work, { retainedOutputDirectory: retained }),
		}
	}

	it('reads a regular retained file in its usual line windows', async () => {
		const { retained, context } = setup()
		const file = join(retained, 'abc.txt')
		writeFileSync(file, 'one\ntwo\nthree\nfour\n')

		const out = await ReadFileTool.execute({ path: file, offset: 1, limit: 2 }, context)

		expect(out.success).toBe(true)
		expect(out.output).toContain('two')
		expect(out.output).toContain('three')
		expect(out.output).not.toContain('four')
	})

	it('reads a file kept in a subdirectory of the retained directory', async () => {
		const { retained, context } = setup()
		mkdirSync(join(retained, 'content'))
		const file = join(retained, 'content', 'abc.txt')
		writeFileSync(file, 'nested\n')

		expect((await ReadFileTool.execute({ path: file }, context)).success).toBe(true)
	})

	it('refuses the same file when the turn retains no output', async () => {
		const { retained, work } = setup()
		const file = join(retained, 'abc.txt')
		writeFileSync(file, 'secret\n')

		expect((await ReadFileTool.execute({ path: file }, makeContext(work))).success).toBe(false)
	})

	it.each([
		['a file outside the directory', (_r: string, o: string) => join(o, 'x.txt'), 'plain'],
		[
			'a path that climbs out of it',
			(r: string, o: string) => join(r, '..', basename(o), 'x.txt'),
			'plain',
		],
		['a file that is not text output', (r: string) => join(r, 'x.manifest.json'), 'plain'],
	])('refuses %s', async (_name, pathFor, _kind) => {
		const { retained, outside, context } = setup()
		writeFileSync(join(outside, 'x.txt'), 'outside\n')
		writeFileSync(join(retained, 'x.manifest.json'), '{}')
		expect(
			(await ReadFileTool.execute({ path: pathFor(retained, outside) }, context)).success,
		).toBe(false)
	})

	it('refuses a symbolic link, even one pointing at a file in the directory', async () => {
		const { retained, outside, context } = setup()
		writeFileSync(join(retained, 'real.txt'), 'real\n')
		symlinkSync(join(retained, 'real.txt'), join(retained, 'link.txt'))
		writeFileSync(join(outside, 'target.txt'), 'outside\n')
		symlinkSync(join(outside, 'target.txt'), join(retained, 'escape.txt'))

		expect(
			(await ReadFileTool.execute({ path: join(retained, 'link.txt') }, context)).success,
		).toBe(false)
		expect(
			(await ReadFileTool.execute({ path: join(retained, 'escape.txt') }, context)).success,
		).toBe(false)
	})

	it('refuses a directory that is a link to somewhere else', async () => {
		const { retained, outside, context } = setup()
		writeFileSync(join(outside, 'x.txt'), 'outside\n')
		symlinkSync(outside, join(retained, 'dir'))

		expect(
			(await ReadFileTool.execute({ path: join(retained, 'dir', 'x.txt') }, context)).success,
		).toBe(false)
	})

	it('refuses a file with a second hard link', async () => {
		const { retained, outside, context } = setup()
		writeFileSync(join(outside, 'x.txt'), 'outside\n')
		linkSync(join(outside, 'x.txt'), join(retained, 'linked.txt'))

		expect(
			(await ReadFileTool.execute({ path: join(retained, 'linked.txt') }, context)).success,
		).toBe(false)
	})

	it('reads it from the host even when the turn has a sandbox', async () => {
		const { retained, work } = setup()
		const file = join(retained, 'abc.txt')
		writeFileSync(file, 'host text\n')
		const context = makeContext(work, {
			retainedOutputDirectory: retained,
			sandbox: sandboxOver('sandbox text'),
		})

		const out = await ReadFileTool.execute({ path: file }, context)

		expect(out.output).toContain('host text')
	})
})

describe('a window the file cannot fill', () => {
	const read = async (body: string | Buffer, input: Record<string, unknown>) => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-range-'))
		writeFileSync(join(dir, 'f.txt'), body)
		return ReadFileTool.execute({ path: 'f.txt', ...input } as never, makeContext(dir))
	}
	const lines = (n: number) =>
		`${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`

	it('says the file is shorter than the start, with its line count, as a success', async () => {
		const out = await read(lines(1502), { offset: 5000 })

		expect(out.success).toBe(true)
		expect(out.output).toBe(
			'Warning: the file is shorter than the requested start (line 5001). It has 1502 lines.',
		)
		expect(out.output).not.toContain('PARTIAL')
		expect(out.data).toMatchObject({ returnedLines: 0, truncated: true })
	})

	it('treats the line after the last as past the end, for offset and for a range', async () => {
		expect((await read(lines(3), { offset: 3 })).output).toContain('It has 3 lines.')
		expect((await read(lines(3), { readRange: [4, 9] })).output).toContain('(line 4)')
		expect((await read(lines(3), { offset: 2 })).output).toContain('3\tline 3')
	})

	it('uses the singular for a one-line file', async () => {
		expect((await read('only', { offset: 4 })).output).toContain('It has 1 line.')
	})

	it('does not let the past-the-end answer stand in for the file in the ledger', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-range-'))
		writeFileSync(join(dir, 'f.txt'), lines(3))
		const tracker = createFileReadTracker()
		await ReadFileTool.execute(
			{ path: 'f.txt', offset: 10 } as never,
			makeContext(dir, { fileReadTracker: tracker, toolUseId: 'call-1' }),
		)
		expect(tracker.readWitness?.(join(dir, 'f.txt'))).toBeUndefined()
	})

	it('says an empty file is empty', async () => {
		const out = await read('', {})

		expect(out.success).toBe(true)
		expect(out.output).toBe('Warning: the file exists but is empty.')
		expect(out.data).toMatchObject({ returnedLines: 0, truncated: false })
	})
})

describe('content that is not text', () => {
	it('gets a short note with its size and the next step', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-binary-'))
		writeFileSync(join(dir, 'blob.dat'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 9, 0, 0]))

		const out = await ReadFileTool.execute({ path: 'blob.dat' }, makeContext(dir))

		expect(out.success).toBe(false)
		expect(out.output).toContain('not readable as text')
		expect(out.output).toContain('10 B')
		expect(out.output).toContain('xxd')
		expect(out.output).not.toContain('1\t')
		expect(out.facts).toMatchObject({ kind: 'read', binary: true, bytes: 10 })
	})

	it('gets the same note from inside a sandbox', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-binary-'))
		const out = await ReadFileTool.execute(
			{ path: 'blob.dat' },
			makeContext(dir, { sandbox: sandboxOver('a\u0000b\u0000c') }),
		)

		expect(out.success).toBe(false)
		expect(out.output).toContain('not readable as text')
	})
})

describe("read's saved-output route refuses a path it was not given", () => {
	const setup = () => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-spills-')))
		const mine = join(parent, 'session-mine')
		const theirs = join(parent, 'session-theirs')
		mkdirSync(mine)
		mkdirSync(theirs)
		writeFileSync(join(mine, 'ok.txt'), 'mine\n')
		writeFileSync(join(theirs, 'spill.txt'), 'OTHER-SESSION-BODY\n')
		const work = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-read-work-')))
		return { mine, theirs, context: makeContext(work, { retainedOutputDirectory: mine }) }
	}

	it('refuses a path that climbs out of the directory', async () => {
		const { mine, context } = setup()
		const out = await ReadFileTool.execute(
			{ path: join(mine, '..', 'session-theirs', 'spill.txt') },
			context,
		)
		expect(out.success).toBe(false)
		expect(`${out.output}${out.error ?? ''}`).not.toContain('OTHER-SESSION-BODY')
	})

	it("refuses another session's saved output by its own path", async () => {
		const { theirs, context } = setup()
		const out = await ReadFileTool.execute({ path: join(theirs, 'spill.txt') }, context)
		expect(out.success).toBe(false)
		expect(`${out.output}${out.error ?? ''}`).not.toContain('OTHER-SESSION-BODY')
	})

	it('still reads its own', async () => {
		const { mine, context } = setup()
		const out = await ReadFileTool.execute({ path: join(mine, 'ok.txt') }, context)
		expect(out.success).toBe(true)
	})
})
