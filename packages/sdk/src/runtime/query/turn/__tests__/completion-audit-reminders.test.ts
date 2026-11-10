import { describe, expect, it } from 'vitest'

import type { TurnOutcome, TurnOutcomeCheck } from '../../../../types/session/outcome.js'
import {
	COMPLETION_AUDIT_MAX_COMMAND_CHARS,
	COMPLETION_AUDIT_MESSAGE,
	CompletionAudit,
	auditCommandText,
} from '../completion-audit.js'

const edit = { toolName: 'edit', input: {} }
const check = { toolName: 'bash', input: { command: 'pnpm test' } }

function record(verdict: TurnOutcome['verdict'], checks: TurnOutcomeCheck[]): TurnOutcome {
	return {
		verdict,
		basis: 'calls',
		changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
		checks,
	}
}
const row = (command: string, result: TurnOutcomeCheck['result']): TurnOutcomeCheck => ({
	command,
	step: 1,
	result,
})

describe('the one reminder, worded from the outcome record', () => {
	it('says a check ran with its status hidden, names it, and asks for it without the pipe', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, { toolName: 'bash', input: { command: 'npm test 2>&1 | tail -15' } }])
		expect(audit.takeBlock()).toBe(false) // the old rule alone would let this turn end
		const again = new CompletionAudit()
		again.observe([edit, { toolName: 'bash', input: { command: 'npm test 2>&1 | tail -15' } }])
		const message = again.takeReminder(() =>
			record('inconclusive', [row('npm test 2>&1 | tail -15', 'masked')]),
		)
		expect(message).toContain('`npm test 2>&1 | tail -15`')
		expect(message).toContain('exit status hidden')
		expect(message).toContain('without the pipe')
	})

	it('says a passed check went stale, naming the latest pass', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, check, edit])
		const message = audit.takeReminder(() =>
			record('stale', [row('pnpm lint', 'passed'), row('pnpm test', 'passed')]),
		)
		expect(message).toContain('`pnpm test` passed')
		expect(message).toContain('changed after it')
	})

	it('names the failing command, even when another check passed later', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, check])
		const message = audit.takeReminder(() =>
			record('failing', [row('pnpm test', 'failed'), row('pnpm lint', 'passed')]),
		)
		expect(message).toContain('`pnpm test` failed')
	})

	it('keeps the original message byte for byte when nothing was checked', () => {
		const audit = new CompletionAudit()
		audit.observe([edit])
		expect(audit.takeReminder(() => record('unchecked', []))).toBe(COMPLETION_AUDIT_MESSAGE)
		const noRecord = new CompletionAudit()
		noRecord.observe([edit])
		expect(noRecord.takeReminder()).toBe(COMPLETION_AUDIT_MESSAGE)
	})

	it('says nothing for a checked or unsettled record', () => {
		for (const r of [
			record('checked', [row('pnpm test', 'passed')]),
			record('inconclusive', [row('pnpm test', 'unsettled')]),
		]) {
			const audit = new CompletionAudit()
			audit.observe([edit, check])
			expect(audit.takeReminder(() => r)).toBeUndefined()
		}
	})

	it('says nothing when no write tool changed a file, even if a check failed', () => {
		const audit = new CompletionAudit()
		audit.observe([check])
		let asked = false
		expect(
			audit.takeReminder(() => {
				asked = true
				return record('failing', [row('pnpm test', 'failed')])
			}),
		).toBeUndefined()
		expect(asked).toBe(false)
	})

	it('gives at most one reminder across every wording', () => {
		const audit = new CompletionAudit()
		audit.observe([edit])
		expect(audit.takeReminder(() => record('failing', [row('pnpm test', 'failed')]))).toBeDefined()
		expect(audit.takeReminder(() => record('stale', [row('pnpm test', 'passed')]))).toBeUndefined()
		expect(audit.takeReminder(() => record('unchecked', []))).toBeUndefined()
		expect(audit.takeBlock()).toBe(false)
	})
})

describe('the command a reminder repeats', () => {
	it('is one line, without backticks or control characters', () => {
		expect(auditCommandText('pnpm  test\n`rm -rf x`\t--bail')).toBe('pnpm test rm -rf x --bail')
	})

	it('is cut at 120 characters', () => {
		const out = auditCommandText(`pnpm test ${'x'.repeat(500)}`)
		expect(out).toHaveLength(COMPLETION_AUDIT_MAX_COMMAND_CHARS)
		expect(out.endsWith('...')).toBe(true)
	})

	it('keeps every variant bounded and to one command', () => {
		const long = `pnpm test ${'y'.repeat(900)}`
		const audit = new CompletionAudit()
		audit.observe([edit])
		const message = audit.takeReminder(() => record('inconclusive', [row(long, 'masked')])) ?? ''
		expect(message.length).toBeLessThan(700)
		expect(message.split('`')).toHaveLength(3)
	})

	it('does not claim the masked check was the only one when another is unsettled', () => {
		const audit = new CompletionAudit()
		audit.observe([edit])
		const message =
			audit.takeReminder(() =>
				record('inconclusive', [
					row('npm test 2>&1 | tail', 'masked'),
					row('pnpm lint', 'unsettled'),
				]),
			) ?? ''
		expect(message).toContain('a check run, `npm test 2>&1 | tail`, had its exit status hidden')
		expect(message).not.toContain('only check')
	})
})
