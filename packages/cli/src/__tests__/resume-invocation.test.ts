import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { resumeInvocation } from '../resume-invocation.js'
import { formatTuiExitSummary } from '../tui/exit-summary.js'

describe.skipIf(process.platform === 'win32')('public resume command', () => {
	it('uses the matching PATH executable, but preserves alternate installations and source loaders', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-resume-path-'))
		try {
			const bin = join(root, 'bin')
			mkdirSync(bin)
			const entry = join(root, 'bin.js')
			writeFileSync(entry, '')
			chmodSync(entry, 0o755)
			symlinkSync(entry, join(bin, 'namzu'))
			expect(resumeInvocation(entry, bin)).toEqual(['namzu'])
			expect(resumeInvocation(join(root, 'other.js'), bin)).toEqual([
				process.execPath,
				join(root, 'other.js'),
			])
			expect(resumeInvocation(entry, `.${delimiter}${bin}`)).toEqual([process.execPath, entry])
			const source = join(root, 'bin.ts')
			expect(resumeInvocation(source, bin)).toEqual([process.execPath, ...process.execArgv, source])
		} finally {
			removeTempDir(root)
		}
	})
	it('omits a redundant directory change in the current working directory', () => {
		expect(
			formatTuiExitSummary(
				{ conversationId: 'example' },
				{ cwd: process.cwd(), command: ['namzu'] },
			),
		).toBe('To resume this conversation, run: namzu resume example\n')
	})
})
