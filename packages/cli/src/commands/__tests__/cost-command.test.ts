import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { writeSession } from '../../integrations/spend/__fixtures__/logs.js'

const roots: string[] = []

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function capture() {
	const out = { stdout: '', stderr: '' }
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		out.stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		out.stderr += String(chunk)
		return true
	})
	return out
}

function homeWithOneSession(): void {
	const home = mkdtempSync(join(tmpdir(), 'namzu-cost-command-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	// A few minutes ago, so it falls in today whatever the zone.
	const at = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString()
	writeSession(home, {
		turns: [
			{
				startAt: at(5 * 60_000),
				model: 'claude-opus-5-5',
				servingProvider: 'anthropic',
				calls: [{ at: at(4 * 60_000), prompt: 1000, completion: 100, costUsd: 0.5 }],
				endAt: at(3 * 60_000),
			},
		],
	})
}

it('prints the same view as JSON with --json, in a documented shape', async () => {
	homeWithOneSession()
	const out = capture()
	const code = await runCli({ argv: ['node', 'namzu', 'cost', '--json'] })
	expect(code).toBe(0)
	const report = JSON.parse(out.stdout) as {
		schemaVersion: number
		estimate: boolean
		totals: { estimatedCostUsd: number; partial: boolean; conversations: number }
		days: { models: { model: string }[] }[]
	}
	expect(report.schemaVersion).toBe(1)
	expect(report.estimate).toBe(true)
	expect(report.totals).toMatchObject({ estimatedCostUsd: 0.5, partial: false, conversations: 1 })
	expect(report.days[0]?.models[0]?.model).toBe('claude-opus-5-5')
})

it('prints text by default, and marks money as an estimate', async () => {
	homeWithOneSession()
	const out = capture()
	const code = await runCli({ argv: ['node', 'namzu', 'cost', '--days', '7'] })
	expect(code).toBe(0)
	expect(out.stdout).toContain('Spend over the last 7 days')
	expect(out.stdout).toContain('estimate from list prices')
	expect(out.stdout).toContain('claude-opus-5-5 (anthropic)')
	expect(out.stdout).toContain('$0.50')
})

it('answers an argument it does not take with the usage and exit 64', async () => {
	homeWithOneSession()
	const out = capture()
	const code = await runCli({ argv: ['node', 'namzu', 'cost', '--days', 'many'] })
	expect(code).toBe(64)
	expect(out.stderr).toContain('namzu cost [--days <n>] [--json]')
})

it('answers --help from the command without reading anything', async () => {
	const out = capture()
	const code = await runCli({ argv: ['node', 'namzu', 'cost', '--help'] })
	expect(code).toBe(0)
	expect(out.stdout).toContain('namzu cost')
})
