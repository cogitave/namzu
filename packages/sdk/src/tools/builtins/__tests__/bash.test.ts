import { describe, expect, it } from 'vitest'

import { BashTool } from '../bash.js'

/**
 * What `bash` promises before it runs anything.
 *
 * These need no shell, so they stay in the unit suite. The ones that actually
 * execute a command live in `bash.proc-test.ts` — spawning real processes
 * beside 2594 unit tests flaked four unrelated timing-sensitive ones, so the
 * process suite is separate and has its own CI step.
 */

describe('the two clocks agree', () => {
	it('declares a deadline of its own', () => {
		// The executor reads a tool's `timeoutMs` before falling back to its
		// generic default. With none declared, `bash` inherited that default —
		// the same two minutes as its OWN default — so the two agreed by
		// coincidence and diverged the moment a model asked for longer because
		// it knew a build was slow. It got two minutes, from a clock it had not
		// been told about, reported as an abandoned tool rather than as a
		// command that ran out of time.
		expect(BashTool.timeoutMs).toBeDefined()
	})

	it('puts that deadline above the longest the model may request', () => {
		// So this tool's own clock is the one that fires, and the executor's is
		// a backstop rather than a second clock racing it.
		const accepted = BashTool.inputSchema.safeParse({ command: 'true', timeout: 10 * 60 * 1000 })

		expect(accepted.success).toBe(true)
		expect(BashTool.timeoutMs as number).toBeGreaterThan(10 * 60 * 1000)
	})

	it('clamps an over-long request to the ceiling instead of refusing it', () => {
		const clamped = BashTool.inputSchema.safeParse({
			command: 'true',
			timeout: 60 * 60 * 1000,
		})

		expect(clamped.success).toBe(true)
		expect(clamped.success && clamped.data.timeout).toBe(10 * 60 * 1000)
	})

	it('leaves a request under the ceiling alone', () => {
		expect(BashTool.inputSchema.parse({ command: 'true', timeout: 5000 }).timeout).toBe(5000)
	})

	it('refuses a nonsensical deadline', () => {
		expect(BashTool.inputSchema.safeParse({ command: 'true', timeout: 0 }).success).toBe(false)
		expect(BashTool.inputSchema.safeParse({ command: 'true', timeout: -1 }).success).toBe(false)
	})

	it('applies its default when none is given', () => {
		const parsed = BashTool.inputSchema.parse({ command: 'true' })

		expect(parsed.timeout).toBeGreaterThan(0)
	})
})

describe('the input is closed before a shell ever sees it', () => {
	it('refuses an empty command', () => {
		expect(BashTool.inputSchema.safeParse({ command: '' }).success).toBe(false)
	})

	it('accepts a numeric timeout sent as a string', () => {
		// Providers do this, and the coercion is deliberate.
		const parsed = BashTool.inputSchema.parse({ command: 'true', timeout: '5000' })

		expect(parsed.timeout).toBe(5000)
	})
})

describe('the danger flag reads the command', () => {
	it('marks a destructive command destructive', () => {
		expect(BashTool.isDestructive?.({ command: 'rm -rf /', timeout: 1000 } as never)).toBe(true)
	})

	it('leaves an ordinary command alone', () => {
		expect(BashTool.isDestructive?.({ command: 'ls -la', timeout: 1000 } as never)).toBe(false)
	})
})
