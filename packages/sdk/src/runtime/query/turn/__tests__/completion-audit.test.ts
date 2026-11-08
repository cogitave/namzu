import { describe, expect, it } from 'vitest'

import {
	COMPLETION_AUDIT_MESSAGE,
	CompletionAudit,
	isVerificationCommand,
} from '../completion-audit.js'

describe('which commands check work', () => {
	it.each([
		'pnpm test',
		'pnpm --filter @namzu/sdk test -- src/a.test.ts',
		'npm run lint',
		'cargo clippy --all-targets',
		'go test ./...',
		'make check',
		'npx vitest run',
		'pytest -q',
		'tsc --noEmit',
		'cd pkg && biome check .',
	])('%s', (command) => {
		expect(isVerificationCommand(command)).toBe(true)
	})

	it.each(['ls -la', 'cat package.json', 'git status', 'echo test', 'node script.js'])(
		'%s is not one',
		(command) => {
			expect(isVerificationCommand(command)).toBe(false)
		},
	)
})

describe('the completion audit', () => {
	const edit = { toolName: 'edit', input: {} }
	const check = { toolName: 'bash', input: { command: 'pnpm test' } }

	it('lets a turn that changed nothing end', () => {
		const audit = new CompletionAudit()
		audit.observe([{ toolName: 'read' }])
		expect(audit.takeBlock()).toBe(false)
	})

	it('holds back a turn that changed a file and checked nothing, once', () => {
		const audit = new CompletionAudit()
		audit.observe([edit])
		expect(audit.takeBlock()).toBe(true)
		expect(audit.takeBlock()).toBe(false)
	})

	it('lets a turn end whose last change was followed by a check', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, check])
		expect(audit.takeBlock()).toBe(false)
	})

	it('wants a check after the last change, not before it', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, check, edit])
		expect(audit.takeBlock()).toBe(true)
	})

	it('does not count a failed edit, or a failed or missing check as the right thing', () => {
		const failedEdit = new CompletionAudit()
		failedEdit.observe([{ toolName: 'edit', isError: true }])
		expect(failedEdit.takeBlock()).toBe(false)
		const noCheck = new CompletionAudit()
		noCheck.observe([edit, { toolName: 'bash', input: { command: 'ls' } }])
		expect(noCheck.takeBlock()).toBe(true)
	})

	it('does not count a check that failed', () => {
		const audit = new CompletionAudit()
		audit.observe([edit, { toolName: 'bash', input: { command: 'pnpm test' }, isError: true }])
		expect(audit.takeBlock()).toBe(true)
	})

	it('asks to name a throwaway file, never to remove one', () => {
		expect(COMPLETION_AUDIT_MESSAGE).toContain('name any throwaway file you made')
		expect(COMPLETION_AUDIT_MESSAGE).not.toMatch(/\b(delete|remove|rm)\b/i)
	})
})
