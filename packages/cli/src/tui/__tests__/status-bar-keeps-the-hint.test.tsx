/**
 * The hint survives a realistic working directory.
 *
 * The status bar is one line that truncates, and the hint is the only place any
 * key is advertised. Three separate fixes landed recently on the strength of
 * that advertisement — the trust gate naming `Esc`, the permission prompt
 * naming every key that decides it, the picker naming its exits — and every one
 * of them is sound about the wrong thing if the line the operator actually sees
 * ends before the hint begins.
 *
 * So these render at the harness's 100 columns, which is an ordinary terminal
 * width, with paths of the kind people really work in. A test that used a short
 * cwd would prove the hint is BUILT, which was never in doubt.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'

/** The picker's first-run hint: the only place its exits are named. */
const HINT = '↑↓ navigate · enter accept · esc or Ctrl+C exit'

/** Deep but unremarkable — a service inside a monorepo inside a work folder. */
const DEEP_CWD = '/home/dev/work/acme-platform/services/payments-api/packages/core'

/** What a Windows checkout of this very repository looks like. */
const WINDOWS_CWD =
	'C:/Users/dev/workspaces/acme/platform/.claude/worktrees/agent-ad836b8c7169f4871/packages/cli'

function frameFor(cwd: string, hint = HINT): string {
	const { lastFrame, unmount } = render(
		<StatusBar
			cwd={cwd}
			provider="anthropic-personal (anthropic)"
			model="claude-opus-4-7"
			state="idle"
			hint={hint}
		/>,
	)
	const frame = lastFrame() ?? ''
	unmount()
	return frame
}

describe('the hint at a realistic width', () => {
	it('survives a deep posix path', () => {
		const frame = frameFor(DEEP_CWD)
		expect(frame, 'the exit keys were truncated away').toContain('Ctrl+C')
		expect(frame).toContain('esc')
	})

	it('survives a deep windows path', () => {
		const frame = frameFor(WINDOWS_CWD)
		expect(frame, 'the exit keys were truncated away').toContain('Ctrl+C')
	})

	it('survives a path long enough to fill the line on its own', () => {
		// The ruling this file encodes: if the width cannot hold both, the path
		// goes and the keys stay. The path is recoverable — the banner carries
		// it, and the operator knows where they are. The key advertisement
		// exists in exactly one place on the screen.
		const frame = frameFor(`/${'very-long-directory-name/'.repeat(8)}leaf`)
		expect(frame, 'the exit keys lost to the path').toContain('Ctrl+C')
	})

	it('still shows where you are when there is room', () => {
		// The other half: shortening must not become "never show the path".
		const frame = frameFor('/home/dev/api')
		expect(frame).toContain('/home/dev/api')
		expect(frame).toContain('Ctrl+C')
	})

	it('keeps the leaf directory when it shortens a path', () => {
		// The leaf is the informative end — `core` tells you which package you
		// are in, `/home` tells you nothing you did not know.
		const frame = frameFor(DEEP_CWD)
		expect(frame, 'shortening dropped the part that identifies the folder').toContain('core')
	})

	it('leaves a short line completely alone', () => {
		const frame = frameFor('/w')
		expect(frame).toContain('/w')
		expect(frame).toContain('Ctrl+C')
		expect(frame).not.toContain('idle')
	})
})
