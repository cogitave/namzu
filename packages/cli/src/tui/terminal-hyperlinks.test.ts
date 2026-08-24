import { describe, expect, it } from 'vitest'

import { terminalSupportsHyperlinks, terminalWebHyperlink } from './terminal-hyperlinks.js'

const ESC = '\u001b'

describe('terminalSupportsHyperlinks', () => {
	it('admits known terminal families only on a TTY', () => {
		expect(terminalSupportsHyperlinks({ TERM_PROGRAM: 'WezTerm' }, true)).toBe(true)
		expect(terminalSupportsHyperlinks({ TERM: 'xterm-kitty' }, true)).toBe(true)
		expect(terminalSupportsHyperlinks({ WT_SESSION: 'session' }, true)).toBe(true)
		expect(terminalSupportsHyperlinks({ TERM_PROGRAM: 'WezTerm' }, false)).toBe(false)
	})

	it('keeps links visible through unknown, remote, and multiplexed output paths', () => {
		expect(terminalSupportsHyperlinks({ TERM: 'xterm-256color' }, true)).toBe(false)
		expect(terminalSupportsHyperlinks({ TERM_PROGRAM: 'WezTerm', TMUX: '/tmp/tmux' }, true)).toBe(
			false,
		)
		expect(
			terminalSupportsHyperlinks({ TERM_PROGRAM: 'WezTerm', SSH_TTY: '/dev/pts/1' }, true),
		).toBe(false)
		expect(terminalSupportsHyperlinks({ TERM: 'dumb', VTE_VERSION: '7600' }, true)).toBe(false)
	})
})

describe('terminalWebHyperlink', () => {
	it('serializes an admitted web target into a bounded OSC 8 label', () => {
		expect(terminalWebHyperlink('docs', 'https://EXAMPLE.test/a b')).toBe(
			`${ESC}]8;;https://example.test/a%20b${ESC}\\docs${ESC}]8;;${ESC}\\`,
		)
	})

	it.each([
		['relative', '../secret'],
		['file', 'file:///tmp/secret'],
		['script', 'javascript:alert(1)'],
		['control', `https://example.test/${String.fromCodePoint(0x1b)}escape`],
		['bidi', `https://example.test/${String.fromCodePoint(0x202e)}spoof`],
		['oversized', `https://example.test/${'a'.repeat(4_096)}`],
	])('refuses a %s target', (_case, target) => {
		expect(terminalWebHyperlink('label', target)).toBeNull()
	})
})
