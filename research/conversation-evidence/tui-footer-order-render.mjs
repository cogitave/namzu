// Replays a raw PTY byte capture through a headless VT emulator and returns
// the screen as an array of plain-text rows.
//
// ANSI cursor state is sequential (cursor moves, erase sequences, scroll
// regions all depend on what came before), so the only trustworthy way to
// read "what the screen showed at byte offset N" is to feed a FRESH emulator
// every byte from 0 up to N — never to try to diff or resume a live one. See
// `cli-pty-dogfood-harness`: "distrust the renderer's dropped rows" applies
// doubly to hand-rolled ANSI parsing, which this file does not do; it defers
// to the same VT parser `packages/cli`'s own test screen support uses
// (`packages/cli/src/tui/__tests__/support/screen.ts`), just fed from a real
// subprocess instead of Ink's in-process renderer.

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

/**
 * The VIEWPORT starts at `buffer.active.baseY`, not at buffer row 0.
 *
 * The two are the same row only while nothing has scrolled. Once the frame
 * outgrows the terminal — which is the interesting case, and the one a
 * layout change is most likely to reach — buffer row 0 is the oldest line of
 * SCROLLBACK, and reading `rows` lines from there returns the top of the
 * session with the bottom of the screen missing. That reads exactly like "the
 * last rows of the panel fell off", which is a conclusion about the app drawn
 * from a defect in the reader: the same capture read from `baseY` shows those
 * rows on screen, with the oldest conversation scrolled off the top instead.
 * `packages/cli/src/tui/__tests__/support/screen.ts` reads from `baseY` for
 * this reason, and so does this.
 *
 * @param {object} opts
 * @param {string} opts.cliPackageRoot - absolute path to packages/cli, used to resolve @xterm/headless the same way the package's own tests do
 * @param {Buffer} opts.bytes - the full raw capture
 * @param {number} opts.upTo - byte offset (exclusive) to replay up to
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {boolean} [opts.fromBufferTop] - read from buffer row 0 instead of the viewport. Only to SHOW the difference the comment above describes; never for an assertion about what is on screen.
 * @returns {Promise<string[]>} the visible rows, trailing whitespace trimmed
 */
export async function renderCheckpoint({
	cliPackageRoot,
	bytes,
	upTo,
	cols,
	rows,
	fromBufferTop = false,
}) {
	const require = createRequire(`${cliPackageRoot}/package.json`)
	const { Terminal } = require('@xterm/headless')
	const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 })
	const slice = bytes.subarray(0, upTo)
	await new Promise((resolve) => terminal.write(slice, resolve))
	const top = fromBufferTop ? 0 : terminal.buffer.active.baseY
	const lines = []
	for (let i = 0; i < terminal.rows; i++) {
		const line = terminal.buffer.active.getLine(top + i)
		lines.push((line ? line.translateToString(false) : '').replace(/\s+$/u, ''))
	}
	terminal.dispose()
	return lines
}

/** Load a raw capture file written by `tui-footer-order-drive.py`. */
export async function loadCapture(path) {
	return readFile(path)
}
