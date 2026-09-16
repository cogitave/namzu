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
 * @param {object} opts
 * @param {string} opts.cliPackageRoot - absolute path to packages/cli, used to resolve @xterm/headless the same way the package's own tests do
 * @param {Buffer} opts.bytes - the full raw capture
 * @param {number} opts.upTo - byte offset (exclusive) to replay up to
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @returns {Promise<string[]>} the visible rows, trailing whitespace trimmed
 */
export async function renderCheckpoint({ cliPackageRoot, bytes, upTo, cols, rows }) {
	const require = createRequire(`${cliPackageRoot}/package.json`)
	const { Terminal } = require('@xterm/headless')
	const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 })
	const slice = bytes.subarray(0, upTo)
	await new Promise((resolve) => terminal.write(slice, resolve))
	const lines = []
	for (let i = 0; i < terminal.rows; i++) {
		const line = terminal.buffer.active.getLine(i)
		lines.push((line ? line.translateToString(false) : '').replace(/\s+$/u, ''))
	}
	terminal.dispose()
	return lines
}

/** Load a raw capture file written by `tui-footer-order-drive.py`. */
export async function loadCapture(path) {
	return readFile(path)
}
