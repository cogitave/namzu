import { describe, expect, it } from 'vitest'

import { CappedStream } from '../provider/local.js'

/**
 * `SandboxExecResult` carries `stdoutTruncated` / `stderrTruncated`, added
 * when the other backend needed to report a clipped stream. The local
 * backend clipped at the same cap and never set them, so the model read a
 * complete-looking result whose tail was gone — against the contract's own
 * note that the kernel does not truncate silently. The tool layer already
 * renders the flag; nothing ever raised it.
 */

function push(stream: CappedStream, text: string): void {
	stream.push(Buffer.from(text, 'utf-8'))
}

describe('a clipped stream says it was clipped', () => {
	it('reports nothing truncated while under the cap', () => {
		const stream = new CappedStream(10)
		push(stream, 'abc')

		expect(stream.text).toBe('abc')
		expect(stream.truncated).toBe(false)
	})

	it('reports nothing truncated at exactly the cap', () => {
		const stream = new CappedStream(4)
		push(stream, 'abcd')

		expect(stream.text).toBe('abcd')
		// Everything arrived and everything was kept. A boundary that
		// reported truncation here would cry wolf on every exact fit.
		expect(stream.truncated).toBe(false)
	})

	it('reports truncated on the first byte past the cap', () => {
		const stream = new CappedStream(4)
		push(stream, 'abcde')

		expect(stream.text).toBe('abcd')
		expect(stream.truncated).toBe(true)
	})

	it('keeps the head across chunks and clips the rest', () => {
		const stream = new CappedStream(5)
		push(stream, 'abc')
		push(stream, 'def')
		push(stream, 'ghi')

		expect(stream.text).toBe('abcde')
		expect(stream.truncated).toBe(true)
	})

	it('stays truncated once it has been, however quiet the stream goes', () => {
		const stream = new CappedStream(2)
		push(stream, 'abcdef')
		push(stream, '')

		expect(stream.truncated).toBe(true)
	})

	it('is empty and untruncated before anything arrives', () => {
		const stream = new CappedStream(8)

		expect(stream.text).toBe('')
		expect(stream.truncated).toBe(false)
	})
})

describe('the sandbox hands the flag to its caller', () => {
	it('marks a real over-cap run as truncated', async () => {
		const { LocalSandboxProvider } = await import('../provider/local.js')
		const { getRootLogger } = await import('../../utils/logger.js')
		const { SANDBOX_MAX_OUTPUT_BYTES } = await import('../../constants/sandbox/index.js')

		const sandbox = await new LocalSandboxProvider(getRootLogger()).create()
		try {
			const over = SANDBOX_MAX_OUTPUT_BYTES + 1024
			const result = await sandbox.exec('node', ['-e', `process.stdout.write('a'.repeat(${over}))`])

			expect(result.stdoutTruncated).toBe(true)
			expect(result.stdout.length).toBe(SANDBOX_MAX_OUTPUT_BYTES)
			// The other stream is untouched, so a clip on one must not be
			// reported on both.
			expect(result.stderrTruncated).toBe(false)
		} finally {
			await sandbox.destroy()
		}
	}, 30_000)

	it('leaves an under-cap run unflagged', async () => {
		const { LocalSandboxProvider } = await import('../provider/local.js')
		const { getRootLogger } = await import('../../utils/logger.js')

		const sandbox = await new LocalSandboxProvider(getRootLogger()).create()
		try {
			const result = await sandbox.exec('node', ['-e', "process.stdout.write('small')"])

			expect(result.stdout).toBe('small')
			expect(result.stdoutTruncated).toBe(false)
		} finally {
			await sandbox.destroy()
		}
	}, 30_000)
})
