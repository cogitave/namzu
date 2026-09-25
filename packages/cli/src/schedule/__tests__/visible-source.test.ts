import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostCommandShell } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { addCommand, editCommand } from '../commands/add.js'
import { showCommand } from '../commands/list.js'
import { findJob } from '../store/jobs.js'
import { visibleScheduleMessage, visibleScheduleSource } from '../visible-source.js'
import { recordingContext, sandbox } from './fixtures.js'

const ESC = '\u001b'
const BIDI = '\u202e'

describe('schedule text shown to a person', () => {
	it('distinguishes an actual control from a literal backslash escape and preserves script lines', () => {
		const actual = visibleScheduleSource(`echo 'a${ESC}[2J'\necho second`)
		const literal = visibleScheduleSource(String.raw`echo 'a\u{001b}[2J'`)
		expect(actual.escaped).toBe(true)
		expect(actual.text).toBe("echo 'a\\u{001b}[2J'\necho second")
		expect(literal.escaped).toBe(true)
		expect(literal.text).toBe(String.raw`echo 'a\\u{001b}[2J'`)
		expect(actual.text).not.toBe(literal.text)
		expect(visibleScheduleSource("echo 'ordinary'\necho second")).toEqual({
			text: "echo 'ordinary'\necho second",
			escaped: false,
		})
		expect(visibleScheduleMessage(`bell\u0007, direction${BIDI}`)).not.toContain('\u0007')
		expect(visibleScheduleMessage(`bell\u0007, direction${BIDI}`)).not.toContain(BIDI)
	})

	it('makes actual script bytes visible on add, edit and show while keeping the stored and JSON body raw', async () => {
		const sb = sandbox()
		try {
			const permissions = join(sb.root, 'permissions.json')
			writeFileSync(permissions, JSON.stringify({ rules: { bash: 'allow' }, unmatched: 'deny' }))
			const body = `echo 'first${ESC}[2J${BIDI}second'\necho done`
			const add = recordingContext()
			expect(
				await addCommand(add, [
					'visible-script',
					'--home',
					sb.home,
					'--when',
					'every 1m',
					'--folder',
					sb.project,
					'--kind',
					'script',
					'--script',
					body,
					'--shell',
					hostCommandShell().dialect,
					'--permissions',
					permissions,
					'--yes',
				]),
				add.out.errors.join('\n'),
			).toBe(0)
			const preview = add.out.info.join('\n')
			expect(preview).not.toContain(ESC)
			expect(preview).not.toContain(BIDI)
			expect(preview).toContain("  echo 'first\\u{001b}[2J\\u{202e}second'\n  echo done")
			expect(preview).toContain('Hidden/control characters below')
			const stored = findJob(sb.paths, 'visible-script')
			expect(stored.script?.body).toBe(body)
			expect(JSON.parse(readFileSync(sb.paths.job(stored.id), 'utf8')).script.body).toBe(body)

			const show = recordingContext()
			expect(await showCommand(show, ['visible-script', '--home', sb.home])).toBe(0)
			const display = String(show.out.printed[0])
			expect(display).not.toContain(ESC)
			expect(display).not.toContain(BIDI)
			expect(display).toContain("echo 'first\\u{001b}[2J\\u{202e}second'")
			const json = recordingContext()
			expect(await showCommand(json, ['visible-script', '--home', sb.home, '--json'])).toBe(0)
			expect(JSON.parse(String(json.out.printed[0])).job.script.body).toBe(body)

			const edit = recordingContext()
			expect(
				await editCommand(edit, [
					'visible-script',
					'--home',
					sb.home,
					'--script',
					'echo edited',
					'--yes',
				]),
				edit.out.errors.join('\n'),
			).toBe(0)
			const changedPreview = edit.out.info.join('\n')
			expect(changedPreview).not.toContain(ESC)
			expect(changedPreview).not.toContain(BIDI)
			expect(changedPreview).toContain("- Script  echo 'first\\u{001b}[2J\\u{202e}second'")
		} finally {
			sb.cleanup()
		}
	})

	it('projects a script-check refusal before the CLI writes an error', async () => {
		const sb = sandbox()
		try {
			const permissions = join(sb.root, 'permissions.json')
			writeFileSync(permissions, JSON.stringify({ rules: { bash: 'allow' }, unmatched: 'deny' }))
			const ctx = recordingContext()
			expect(
				await addCommand(ctx, [
					'refused-script',
					'--home',
					sb.home,
					'--when',
					'every 1m',
					'--folder',
					sb.project,
					'--kind',
					'script',
					'--script',
					`sudo --bad${ESC}[2J /bin/true`,
					'--shell',
					hostCommandShell().dialect,
					'--permissions',
					permissions,
					'--yes',
				]),
			).toBe(64)
			expect(ctx.out.errors.join('\n')).not.toContain(ESC)
			expect(ctx.out.errors.join('\n')).toContain('\\u{001b}')
			expect(ctx.out.info).toEqual([])
		} finally {
			sb.cleanup()
		}
	})
})
