import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFormatter } from './index.js'

/**
 * A payload that brought its own rendering gets to use it.
 *
 * Without this a command has to choose between the structured payload the
 * `json` and `yaml` formats need and the human string `text` needs — so a
 * command that wants both passes the object, and the text format dumps a
 * nested object graph where a report was meant to be.
 *
 * `namzu eval` did exactly that in its default format, with the readable
 * version sitting unused one level down. No test caught it: the command's
 * own tests asserted on the payload, which was correct, and never on what
 * a person sees. It was found by running the built binary.
 */

describe('a payload carrying its own text', () => {
	let stdout: string
	let restore: typeof process.stdout.write

	beforeEach(() => {
		stdout = ''
		restore = process.stdout.write.bind(process.stdout)
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stdout.write
	})

	afterEach(() => {
		process.stdout.write = restore
	})

	const payload = {
		suite: 'kernel',
		report: { name: 'kernel-smoke', passed: 1, failed: 0 },
		text: 'kernel-smoke: 1/1 passed (mean 1.00)',
	}

	it('renders the text, not the object graph, in text format', () => {
		createFormatter('text', { quiet: false }).print(payload)

		expect(stdout.trim()).toBe('kernel-smoke: 1/1 passed (mean 1.00)')
		// The tell that this regressed: the reader sees field names.
		expect(stdout).not.toContain('suite:')
		expect(stdout).not.toContain('report:')
	})

	it('still emits the whole payload as json', () => {
		// The structured half is what a CI job parses; collapsing to the
		// string would trade one broken format for another.
		createFormatter('json', { quiet: false }).print(payload)

		const parsed = JSON.parse(stdout) as typeof payload
		expect(parsed.report.passed).toBe(1)
		expect(parsed.suite).toBe('kernel')
	})

	it('leaves a payload without a text field alone', () => {
		createFormatter('text', { quiet: false }).print({ tools: ['read', 'edit'] })
		expect(stdout).toContain('read')
	})

	it('does not treat a non-string text field as rendering', () => {
		// A payload whose `text` is a number is data, not a rendering; using
		// it would hide every other field.
		createFormatter('text', { quiet: false }).print({ text: 42, other: 'kept' })
		expect(stdout).toContain('other')
	})
})
