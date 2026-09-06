import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { formatTuiExitSummary } from './exit-summary.js'

describe('the shell handoff after the TUI exits', () => {
	it('prints a copy-pasteable shell command for the durable conversation', () => {
		expect(formatTuiExitSummary({ conversationId: '5be5e0e7-6c3c-4013-971a-f75c0d2d2538' })).toBe(
			'To resume this conversation, run: namzu resume 5be5e0e7-6c3c-4013-971a-f75c0d2d2538\n',
		)
	})

	it('prints nothing before a durable conversation exists', () => {
		expect(formatTuiExitSummary(null)).toBe('')
		expect(formatTuiExitSummary({})).toBe('')
		expect(
			formatTuiExitSummary({}, { cwd: '/workspace', command: ['/node', '/checkout/bin.js'] }),
		).toBe('')
	})

	it('keeps the executable and working directory explicit instead of resolving another namzu on PATH', () => {
		expect(
			formatTuiExitSummary(
				{ conversationId: '5be5e0e7-6c3c-4013-971a-f75c0d2d2538' },
				{
					cwd: '/home/operator',
					command: ['/opt/node/bin/node', '/checkout/namzu/packages/cli/dist/bin.js'],
				},
			),
		).toBe(
			'To resume this conversation, run: cd /home/operator && /opt/node/bin/node /checkout/namzu/packages/cli/dist/bin.js resume 5be5e0e7-6c3c-4013-971a-f75c0d2d2538\n',
		)
	})

	it.skipIf(process.platform === 'win32')(
		'executes quoted paths and arguments without shell expansion',
		() => {
			const root = mkdtempSync(join(tmpdir(), 'namzu-exit-command-'))
			try {
				const cwd = join(root, "project's $(printf WRONG) folder")
				mkdirSync(cwd)
				const entry = join(root, "entry's $(printf WRONG) script.cjs")
				writeFileSync(
					entry,
					'process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))',
				)
				const id = '5be5e0e7-6c3c-4013-971a-f75c0d2d2538'
				const line = formatTuiExitSummary(
					{ conversationId: id },
					{ cwd, command: [process.execPath, entry] },
				)
				const command = line.slice('To resume this conversation, run: '.length).trimEnd()
				expect(JSON.parse(execFileSync('sh', ['-c', command], { encoding: 'utf8' }))).toEqual({
					cwd,
					args: ['resume', id],
				})
			} finally {
				removeTempDir(root)
			}
		},
	)

	it('renders terminal control bytes visibly', () => {
		const output = formatTuiExitSummary({
			conversationId: 'ses_safe\u001b]2;spoof\u0007',
		})
		expect(output).toContain('\\u{001b}')
		expect(output).toContain('\\u{0007}')
		expect(output).not.toContain('\u001b')
		expect(output).not.toContain('\u0007')
	})
})
