import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { IS_WINDOWS } from '../../../test-support/paths.js'

import {
	DEFAULT_MAX_TOOL_OUTPUT_CHARS,
	SPILL_MARKER,
	applyToolOutputBudget,
} from '../tool-output-budget.js'

/**
 * Nothing capped tool output. `read` returned a whole file when `limit` was
 * omitted, `bash` allowed a 100 MB buffer, and the MCP adapter joined every
 * text block uncapped — so a 2 MB lockfile became ~500k tokens in a single
 * `tool_result` and the run died on a provider error with everything lost.
 */

describe('applyToolOutputBudget', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-spill-'))
	})
	afterEach(() => {
		removeTempDir(dir)
	})

	const base = { toolName: 'read', toolUseId: 'call_1' }

	it('passes an under-budget result through untouched', () => {
		const out = applyToolOutputBudget({ ...base, output: 'small', maxChars: 100 })
		expect(out.output).toBe('small')
		expect(out.truncated).toBe(false)
		expect(out.spillPath).toBeUndefined()
	})

	it('spills an over-budget result and hands the model a path, not a wall of text', () => {
		const huge = 'x'.repeat(200_000)
		const out = applyToolOutputBudget({
			...base,
			output: huge,
			maxChars: 1_000,
			spillDir: dir,
		})

		expect(out.truncated).toBe(true)
		expect(out.originalLength).toBe(200_000)
		// The configured model-visible cap includes the omission and recovery
		// lines. A cap that budgets only the head+tail and appends its own
		// diagnostics afterwards is not a cap.
		expect(out.output.length).toBeLessThanOrEqual(1_000)
		// ...and nothing was actually lost.
		expect(out.spillPath).toBeDefined()
		expect(readFileSync(out.spillPath as string, 'utf-8')).toBe(huge)
		expect(out.output).toContain(out.spillPath as string)
	})

	it('keeps head AND tail — the two ends carry different information', () => {
		const output = `HEAD-MARKER${'.'.repeat(200_000)}TAIL-MARKER`
		const out = applyToolOutputBudget({ ...base, output, maxChars: 1_000, spillDir: dir })
		expect(out.output).toContain('HEAD-MARKER')
		expect(out.output).toContain('TAIL-MARKER')
	})

	it('tells the model how much was omitted and how to get it back', () => {
		const out = applyToolOutputBudget({
			...base,
			output: 'y'.repeat(100_000),
			maxChars: 1_000,
			spillDir: dir,
		})
		expect(out.output).toContain('characters omitted')
		expect(out.output).toMatch(/read.*offset\/limit|grep/i)
	})

	it('degrades to middle-elision when there is nowhere to spill', () => {
		const out = applyToolOutputBudget({ ...base, output: 'z'.repeat(100_000), maxChars: 1_000 })
		expect(out.truncated).toBe(true)
		expect(out.spillPath).toBeUndefined()
		expect(out.output).toContain('not retained')
		expect(out.output).toContain('do not repeat a state-changing action')
		expect(out.output.length).toBeLessThanOrEqual(1_000)
	})

	it.each([
		'../escaped',
		'../../escaped',
		'/absolute/path',
		'nested/call',
		'C:\\outside',
		'nul\0id',
	])('keeps the opaque correlation ID %j inside the spill directory', (toolUseId) => {
		const spillDir = join(dir, 'outputs')
		const out = applyToolOutputBudget({
			...base,
			toolUseId,
			output: 'x'.repeat(2_000),
			maxChars: 1_000,
			spillDir,
		})
		expect(out.spillPath).toBeDefined()
		expect(dirname(out.spillPath as string)).toBe(spillDir)
		expect(readFileSync(out.spillPath as string, 'utf-8')).toBe('x'.repeat(2_000))
	})

	it('honours a small positive cap even when the full diagnostic cannot fit', () => {
		const out = applyToolOutputBudget({
			...base,
			output: 'z'.repeat(100_000),
			maxChars: 64,
		})

		expect(out.truncated).toBe(true)
		expect(out.output.length).toBeLessThanOrEqual(64)
	})

	it('keeps the spill pointer when only a compact recovery notice fits beside an omission', () => {
		const output = 'model evidence '.repeat(1_000)
		const out = applyToolOutputBudget({
			...base,
			output,
			maxChars: 350,
			notice: '[1 image omitted]',
			spillDir: dir,
		})
		expect(out.output.length).toBeLessThanOrEqual(350)
		expect(out.output).toContain('[1 image omitted]')
		expect(out.output).toContain(`${SPILL_MARKER} ${out.spillPath}`)
		expect(readFileSync(out.spillPath as string, 'utf8')).toBe(output)
	})

	it('never throws when the spill directory is unusable — the call still returns', () => {
		const out = applyToolOutputBudget({
			...base,
			output: 'q'.repeat(100_000),
			maxChars: 1_000,
			// A path under a FILE, so mkdir must fail.
			spillDir: join(dir, 'not-a-dir\0bad'),
		})
		expect(out.truncated).toBe(true)
		expect(out.spillPath).toBeUndefined()
	})

	it('treats a non-positive cap as "no budget"', () => {
		const huge = 'x'.repeat(100_000)
		expect(applyToolOutputBudget({ ...base, output: huge, maxChars: 0 }).output).toBe(huge)
		expect(applyToolOutputBudget({ ...base, output: huge, maxChars: -1 }).output).toBe(huge)
	})

	it('documents its default so a change is deliberate', () => {
		expect(DEFAULT_MAX_TOOL_OUTPUT_CHARS).toBe(40_000)
	})
})

/**
 * What the spill is allowed to write over, and who is allowed to read it.
 *
 * The spill path is `<spillDir>/<sha256(toolUseId)>.txt` — fully predictable to
 * anything that has seen the tool call. The write used the default `w` flag,
 * which creates-or-truncates and follows a symlink, so anything able to create
 * a file in that directory first could redirect the kernel's write onto a file
 * of its choosing. The directory and file were also created world-readable,
 * and a spilled output is routinely the largest and most sensitive thing a run
 * produces.
 */
describe('the spill refuses to write through something already at its path', () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-spill-guard-'))
	})
	afterEach(() => {
		removeTempDir(dir)
	})

	const base = { toolName: 'read', toolUseId: 'call_1' }
	const huge = 'x'.repeat(100_000)

	it('leaves a symlinked victim untouched and reports no path', () => {
		// Restoring the default `'w'` flag overwrites the victim and fails here.
		const victim = join(dir, 'victim.txt')
		writeFileSync(victim, 'ORIGINAL', 'utf-8')
		const spillDir = join(dir, 'spill')
		mkdirSync(spillDir, { recursive: true })
		symlinkSync(
			victim,
			join(spillDir, `${createHash('sha256').update('call_1').digest('hex')}.txt`),
		)

		const errors: string[] = []
		const out = applyToolOutputBudget({
			...base,
			output: huge,
			maxChars: 1_000,
			spillDir,
			onError: (m) => errors.push(m),
		})

		expect(readFileSync(victim, 'utf-8'), 'the symlink target was overwritten').toBe('ORIGINAL')
		expect(out.spillPath).toBeUndefined()
		expect(out.truncated).toBe(true)
		expect(errors).toHaveLength(1)
	})

	it('still gives the model a usable preview when it refuses', () => {
		// Refusing to write must not cost the model the result it can still
		// act on — it loses the path, not the preview.
		const spillDir = join(dir, 'spill')
		mkdirSync(spillDir, { recursive: true })
		writeFileSync(
			join(spillDir, `${createHash('sha256').update('call_1').digest('hex')}.txt`),
			'squatter',
			'utf-8',
		)

		const errors: string[] = []
		const out = applyToolOutputBudget({
			...base,
			output: huge,
			maxChars: 1_000,
			spillDir,
			onError: (m) => errors.push(m),
		})

		expect(out.truncated).toBe(true)
		expect(out.spillPath).toBeUndefined()
		expect(out.output).toContain('The full output was not retained')
		expect(errors).toHaveLength(1)
		// The two causes of a refusal lead to opposite next moves, so the
		// message has to distinguish them. Folding EEXIST back into the
		// generic message fails this.
		expect(errors[0]).toContain('Refused to overwrite')
		expect(
			readFileSync(
				join(spillDir, `${createHash('sha256').update('call_1').digest('hex')}.txt`),
				'utf-8',
			),
		).toBe('squatter')
	})

	it.skipIf(IS_WINDOWS)('creates the directory and the file owner-only', () => {
		// `spillDir` is one this call has to CREATE — a directory the test
		// made itself would carry mkdtemp's mode and prove nothing about
		// the mode this code passes. Dropping either `mode` fails this.
		const spillDir = join(dir, 'created-by-spill')
		const out = applyToolOutputBudget({
			...base,
			output: huge,
			maxChars: 1_000,
			spillDir,
		})

		expect(out.spillPath).toBeDefined()
		expect(statSync(spillDir).mode & 0o777).toBe(0o700)
		expect(statSync(out.spillPath as string).mode & 0o777).toBe(0o600)
	})
})
