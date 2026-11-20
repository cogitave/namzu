import { describe, expect, it } from 'vitest'

import { describeBroadAllows } from '../broad-allow.js'

describe('the permission allow rules doctor row', () => {
	it('passes when every rule names what it runs', () => {
		const result = describeBroadAllows([
			{
				source: 'user-file',
				path: '/u/config.yaml',
				permissions: { bash: { 'git status *': 'allow' } },
			},
		])
		expect(result.status).toBe('pass')
	})

	it('warns, naming the rule, the file and a rule to write instead', () => {
		const result = describeBroadAllows([
			{
				source: 'project-file',
				path: '/work/app/namzu.config.json',
				permissions: { bash: { 'python:*': 'allow' } },
			},
		])
		expect(result.status).toBe('warn')
		expect(result.message).toContain('Bash(python:*)')
		expect(result.message).toContain('/work/app/namzu.config.json')
		expect(result.message).toContain('such as Bash(python scripts/build.py *)')
		expect(result.remediation).toContain('keeps working as written')
	})
})
