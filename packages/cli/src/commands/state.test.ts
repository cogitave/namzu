import { describe, expect, it, vi } from 'vitest'

import type { NamzuStateReport } from '../integrations/state/report.js'
import type { Formatter } from '../output/index.js'
import { createStateCommand, renderStateReport } from './state.js'

function report(path = '/work/.namzu'): NamzuStateReport {
	const zero = { files: 0, logicalBytes: 0 }
	return {
		version: 1,
		readOnly: true,
		snapshot: {
			consistency: 'best-effort-unlocked',
			detail: 'Concurrent writers may move the snapshot.',
		},
		complete: true,
		scopeRoots: {
			project: path,
			user: '/home/a/.namzu',
			overlap: false,
		},
		physicalTotals: { roots: 1, files: 0, logicalBytes: 0 },
		roots: [
			{
				path,
				roles: ['project'],
				exists: true,
				complete: true,
				files: 0,
				directories: 0,
				logicalBytes: 0,
				categories: {
					authored: zero,
					configuration: zero,
					runtime: zero,
					control: zero,
					transient: zero,
					unknown: zero,
				},
				inventory: {
					sessions: { ...zero, directories: 0, invalidOrMissingRecords: 0 },
					originOnlySessionCandidates: {
						...zero,
						complete: true,
						limitation: 'No deletion claim.',
					},
					runs: { ...zero, directories: 0, invalidOrMissingRecords: 0 },
					checkpointFiles: zero,
					emergencyDumpFiles: zero,
					attachments: {
						...zero,
						pairs: 0,
						orphanedDataFiles: 0,
						orphanedTypeFiles: 0,
					},
				},
				privacy: [],
				issues: [],
				omittedIssues: 0,
			},
		],
		projectConfig: {
			path: '/work/namzu.config.json',
			status: 'absent',
			logicalBytes: 0,
		},
		projectBinding: { status: 'uninitialized', detail: 'No pointer.' },
	}
}

function harness(value = report()) {
	const printed: unknown[] = []
	const errors: unknown[] = []
	const formatter: Formatter = {
		name: 'text',
		print: (payload) => printed.push(payload),
		info: () => undefined,
		error: (payload) => errors.push(payload),
	}
	const inspect = vi.fn(async () => value)
	const command = createStateCommand({ inspect })
	const invoke = (rawArgs: readonly string[] = []) =>
		command.handler({ ctx: { config: {}, formatter }, rawArgs })
	return { command, invoke, inspect, printed, errors }
}

describe('namzu state command', () => {
	it('is deliberately self-parsed so later state subcommands do not rewrite its front door', async () => {
		const h = harness()
		expect(h.command.passThrough).toBe(true)
		expect(await h.invoke(['report'])).toBe(0)
		expect(h.inspect).toHaveBeenCalledOnce()
		expect(h.printed).toEqual([
			expect.objectContaining({
				readOnly: true,
				text: expect.stringContaining('No files were changed'),
			}),
		])
	})

	it('refuses unknown state actions before inspecting anything', async () => {
		const h = harness()
		expect(await h.invoke(['prune'])).toBe(64)
		expect(h.inspect).not.toHaveBeenCalled()
		expect(h.errors).toEqual([
			expect.objectContaining({
				message: expect.stringContaining('namzu state [report]'),
			}),
		])
	})

	it('escapes terminal controls, newlines and bidi controls from disk-derived paths', () => {
		const unsafe = '/work/line\nname\u001b]8;;link\u0007\u202e/.namzu'
		const rendered = renderStateReport(report(unsafe))
		expect(rendered).toContain('line\\nname')
		expect(rendered).toContain('\\u{001b}')
		expect(rendered).toContain('\\u{0007}')
		expect(rendered).toContain('\\u{202e}')
		expect(rendered).not.toContain('\u001b]8;;')
	})
})
