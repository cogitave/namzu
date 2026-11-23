import { describe, expect, it, vi } from 'vitest'

import type { NamzuStateReport } from '../integrations/state/report.js'
import type { Formatter } from '../output/index.js'
import { createStateCommand, renderStateReport } from './state.js'

function report(path = '/work/.namzu'): NamzuStateReport {
	const zero = { files: 0, logicalBytes: 0 }
	return {
		version: 2,
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
					legacy: zero,
					control: zero,
					transient: zero,
					unknown: zero,
				},
				inventory: {
					projects: 0,
					sessionLogs: zero,
					subagentLogs: zero,
					checkpointFiles: zero,
					toolResultFiles: zero,
					attachments: {
						...zero,
						pairs: 0,
						orphanedDataFiles: 0,
						orphanedTypeFiles: 0,
					},
				},
				legacy: [{ path: 'sessions', kind: 'top-level', files: 3, logicalBytes: 2048 }],
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
		legacyLocalConfig: {
			path: '/work/namzu.config.local.json',
			status: 'absent',
			logicalBytes: 0,
		},
		projectBinding: { status: 'uninitialized', detail: 'No project yet.' },
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
				message: expect.stringContaining('namzu state [report | move legacy [--dry-run] | purge'),
			}),
		])
	})

	it('lists legacy paths with their byte counts and says they were not changed', () => {
		const rendered = renderStateReport(report())
		expect(rendered).toContain('legacy (state an earlier Namzu kept in this folder')
		expect(rendered).toContain('sessions — 2.00 KiB · 3 files')
		expect(rendered).toContain('namzu state move legacy moves it into the Namzu home')
		expect(rendered).toContain('No files were changed.')
	})

	it('names the old layout in the Namzu home without offering to move it', () => {
		const value = report('/home/a/.namzu')
		const rendered = renderStateReport({
			...value,
			roots: value.roots.map((root) => ({ ...root, roles: ['user'] as const })),
		})
		expect(rendered).toContain('legacy (the layout before session logs')
		expect(rendered).not.toContain('move legacy')
	})

	it('runs move legacy only when asked, and passes --dry-run through', async () => {
		const printed: unknown[] = []
		const errors: unknown[] = []
		const formatter: Formatter = {
			name: 'text',
			print: (payload) => printed.push(payload),
			info: () => undefined,
			error: (payload) => errors.push(payload),
		}
		const inspect = vi.fn(async () => report())
		const moveLegacy = vi.fn(async ({ dryRun }: { dryRun: boolean }) => ({
			state: 'done' as const,
			root: '/work/.namzu',
			dryRun,
			destination: '/home/a/.namzu/legacy/-work',
			outcomes: [
				{
					kind: 'moved' as const,
					name: 'sessions',
					to: '/home/a/.namzu/legacy/-work/<time>/sessions',
					how: 'renamed' as const,
				},
				{ kind: 'kept' as const, name: 'checkpoints', reason: 'git tracks files in it' },
			],
		}))
		const command = createStateCommand({ inspect, moveLegacy })
		const invoke = (rawArgs: readonly string[]) =>
			command.handler({ ctx: { config: {}, formatter }, rawArgs })

		expect(await invoke(['move', 'legacy', '--dry-run'])).toBe(0)
		expect(moveLegacy).toHaveBeenCalledExactlyOnceWith({ dryRun: true })
		expect(inspect).not.toHaveBeenCalled()
		const text = (printed[0] as { text: string }).text
		expect(text).toContain('Would move to')
		expect(text).toContain('.namzu/sessions')
		expect(text).toContain('Left in place:\n  .namzu/checkpoints: git tracks files in it')

		expect(await invoke(['move', 'legacy', '--force'])).toBe(64)
		expect(moveLegacy).toHaveBeenCalledOnce()

		// The old spelling runs nothing and names the new one.
		expect(await invoke(['move-legacy', '--dry-run'])).toBe(64)
		expect(moveLegacy).toHaveBeenCalledOnce()
		expect(errors).toContainEqual(
			expect.objectContaining({ message: 'This command is now `namzu state move legacy`.' }),
		)
	})

	it('says why a move was refused and exits unavailable', async () => {
		const errors: unknown[] = []
		const formatter: Formatter = {
			name: 'text',
			print: () => undefined,
			info: () => undefined,
			error: (payload) => errors.push(payload),
		}
		const command = createStateCommand({
			inspect: vi.fn(async () => report()),
			moveLegacy: async () => ({
				state: 'refused',
				reason: 'Namzu moves files only out of a folder you trust.',
			}),
		})
		expect(
			await command.handler({ ctx: { config: {}, formatter }, rawArgs: ['move', 'legacy'] }),
		).toBe(69)
		expect(errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining('you trust') }),
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
