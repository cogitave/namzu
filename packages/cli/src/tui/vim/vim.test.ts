import { describe, expect, it } from 'vitest'
import {
	type VimEffect,
	type VimKey,
	type VimState,
	createVimState,
	resetVim,
	vimKey,
	vimKeys,
	vimOwnsEscape,
	vimSelection,
} from './index.js'

const NAMES: Record<string, string> = {
	Esc: 'Escape',
	CR: 'Enter',
	BS: 'Backspace',
	Del: 'Delete',
	Left: 'Left',
	Right: 'Right',
	Up: 'Up',
	Down: 'Down',
}

function tokens(keys: string): VimKey[] {
	const out: VimKey[] = []
	for (let i = 0; i < keys.length; i += 1) {
		if (keys[i] === '<') {
			const close = keys.indexOf('>', i)
			const name = keys.slice(i + 1, close)
			if (close > i && (NAMES[name] || name.startsWith('C-'))) {
				out.push(
					name.startsWith('C-')
						? { key: name.slice(2), ctrl: true }
						: { key: NAMES[name] as string },
				)
				i = close
				continue
			}
		}
		out.push({ key: keys[i] as string })
	}
	return out
}

interface Run {
	readonly out: string
	readonly state: VimState
	readonly effects: readonly VimEffect[]
	readonly unhandled: number
}

/**
 * `src` has `|` where the cursor stands. The keys run through the machine;
 * in INSERT, what the composer would do for a plain key is done here.
 * The output has `|` where the cursor ended.
 */
function run(src: string, keys: string, start: Partial<VimState> = {}): Run {
	let cursor = src.indexOf('|')
	let text = src.replace('|', '')
	let state: VimState = { ...createVimState(), mode: 'NORMAL', ...start }
	const effects: VimEffect[] = []
	let unhandled = 0
	for (const key of tokens(keys)) {
		const result = vimKey(state, text, cursor, key)
		if (result.handled) {
			state = result.state
			text = result.text
			cursor = result.cursor
			effects.push(...result.effects)
			continue
		}
		unhandled += 1
		if (state.mode === 'INSERT') {
			if (key.key === 'Backspace') {
				if (cursor > 0) {
					text = text.slice(0, cursor - 1) + text.slice(cursor)
					cursor -= 1
				}
			} else if (key.key === 'Enter') {
				text = `${text.slice(0, cursor)}\n${text.slice(cursor)}`
				cursor += 1
			} else {
				text = text.slice(0, cursor) + key.key + text.slice(cursor)
				cursor += key.key.length
			}
		}
	}
	return {
		out: `${text.slice(0, cursor)}|${text.slice(cursor)}`,
		state,
		effects,
		unhandled,
	}
}

const out = (src: string, keys: string, start: Partial<VimState> = {}): string =>
	run(src, keys, start).out

describe('modes and escape', () => {
	it('a fresh machine is in INSERT and reads only Escape', () => {
		const fresh = createVimState()
		expect(fresh.mode).toBe('INSERT')
		expect(vimKey(fresh, 'ab', 2, { key: 'x' }).handled).toBe(false)
		const left = vimKey(fresh, 'ab', 2, { key: 'Escape' })
		expect(left.handled).toBe(true)
		expect(left.state.mode).toBe('NORMAL')
		expect(left.cursor).toBe(1)
	})

	it('Escape steps the cursor one left, but not at the start of a line', () => {
		expect(out('abc|', '<Esc>', { mode: 'INSERT' })).toBe('ab|c')
		expect(out('|abc', '<Esc>', { mode: 'INSERT' })).toBe('|abc')
		expect(out('ab\n|cd', '<Esc>', { mode: 'INSERT' })).toBe('ab\n|cd')
	})

	it('Escape in NORMAL with nothing pending is left to the app', () => {
		const r = run('a|bc', '<Esc>')
		expect(r.unhandled).toBe(1)
		expect(r.state.mode).toBe('NORMAL')
	})

	it('Escape cancels a pending operator or count and is consumed', () => {
		const r = run('a|bc', 'd<Esc>')
		expect(r.unhandled).toBe(0)
		expect(r.out).toBe('a|bc')
		expect(run('a|bc', '2<Esc>').unhandled).toBe(0)
		expect(run('a|bc', 'f<Esc>x').out).toBe('a|c')
	})

	it('the machine owns Escape in INSERT, VISUAL and while a command is pending', () => {
		expect(vimOwnsEscape({ ...createVimState(), mode: 'INSERT' })).toBe(true)
		expect(vimOwnsEscape({ ...createVimState(), mode: 'NORMAL' })).toBe(false)
		expect(vimOwnsEscape(run('abc|', 'd').state)).toBe(true)
		expect(vimOwnsEscape(run('abc|', 'v').state)).toBe(true)
		expect(vimOwnsEscape(run('abc|', 'v<Esc>').state)).toBe(false)
	})

	it("Enter is the composer's in NORMAL and INSERT, and j in VISUAL", () => {
		expect(run('a|b', '<CR>').unhandled).toBe(1)
		expect(out('a|b\ncd', 'v<CR>')).toBe('ab\nc|d')
	})

	it('ctrl keys fall through in NORMAL and leave VISUAL', () => {
		expect(run('a|b', '<C-r>').unhandled).toBe(1)
		const r = run('a|b', 'v<C-r>')
		expect(r.state.mode).toBe('NORMAL')
		expect(r.unhandled).toBe(0)
	})

	it('a reset goes back to INSERT but keeps the register and the last change', () => {
		const used = run('a|bc def', 'dw').state
		const fresh = resetVim(used)
		expect(fresh.mode).toBe('INSERT')
		expect(fresh.register.text).toBe('bc ')
		expect(fresh.lastChange).not.toBeNull()
	})
})

describe('insert commands', () => {
	it('i, a, I, A', () => {
		expect(out('a|bc', 'iX<Esc>')).toBe('a|Xbc')
		expect(out('a|bc', 'aX<Esc>')).toBe('ab|Xc')
		expect(out('  a|bc', 'IX<Esc>')).toBe('  |Xabc')
		expect(out('a|bc', 'AX<Esc>')).toBe('abc|X')
	})

	it('o and O open a line and put the cursor on it', () => {
		expect(out('a|b\ncd', 'ox<Esc>')).toBe('ab\n|x\ncd')
		expect(out('ab\nc|d', 'Ox<Esc>')).toBe('ab\n|x\ncd')
		expect(out('a|b', 'ox<Esc>')).toBe('ab\n|x')
	})

	it('a on an empty line stays on it', () => {
		expect(out('|', 'ax<Esc>')).toBe('|x')
	})

	it('a count repeats typed text for i, a, I and A', () => {
		expect(out('|', '3ix<Esc>')).toBe('xx|x')
		expect(out('a|b', '2Aq<Esc>')).toBe('abq|q')
	})

	it('s, S, C substitute and change', () => {
		expect(out('a|bcd', 'sX<Esc>')).toBe('a|Xcd')
		expect(out('a|bcd', '2sX<Esc>')).toBe('a|Xd')
		expect(out('ab\nc|d\nef', 'SX<Esc>')).toBe('ab\n|X\nef')
		expect(out('a|bcd', 'CX<Esc>')).toBe('a|X')
	})

	it('the typed text can be undone by the host in one go: the machine reports nothing for typing', () => {
		const r = run('|', 'ihello<Esc>')
		expect(r.out).toBe('hell|o')
		expect(r.effects).toEqual([])
	})
})

describe('motions', () => {
	it('h and l stay on the line, and l stops on the last character', () => {
		expect(out('ab|c', 'h')).toBe('a|bc')
		expect(out('|abc', 'h')).toBe('|abc')
		expect(out('a|bc', '5l')).toBe('ab|c')
		expect(out('ab|c\nde', 'l')).toBe('ab|c\nde')
		expect(out('abcd|e', '3h')).toBe('a|bcde')
	})

	it('arrows are h, l, j and k, and Left on an empty draft is left alone', () => {
		expect(out('a|bc', '<Right>')).toBe('ab|c')
		expect(out('a|bc', '<Left>')).toBe('|abc')
		expect(run('|', '<Left>').unhandled).toBe(1)
		expect(out('a|b\ncd', '<Down>')).toBe('ab\nc|d')
		expect(out('ab\nc|d', '<Up>')).toBe('a|b\ncd')
	})

	it('space and backspace cross line ends', () => {
		expect(out('a|b\ncd', ' ')).toBe('ab\n|cd')
		expect(out('ab\n|cd', '<BS>')).toBe('a|b\ncd')
		expect(out('ab\n|\ncd', '<BS>')).toBe('a|b\n\ncd')
		expect(out('a|b\n\ncd', ' ')).toBe('ab\n|\ncd')
	})

	it('j and k keep the wanted column over short lines', () => {
		expect(out('abc|d\nx\nabcd', 'jj')).toBe('abcd\nx\nabc|d')
		expect(out('abcd\nx\nabc|d', 'kk')).toBe('abc|d\nx\nabcd')
	})

	it('$ is sticky for j and k, and ignores a count', () => {
		expect(out('a|b\ncdef', '$j')).toBe('ab\ncde|f')
		expect(out('|ab\ncdef', '3$')).toBe('a|b\ncdef')
	})

	it('0, ^ and $', () => {
		expect(out('  ab|c', '0')).toBe('|  abc')
		expect(out('  ab|c', '^')).toBe('  |abc')
		expect(out('a|bc', '$')).toBe('ab|c')
		expect(out('|ab\ncd', '$')).toBe('a|b\ncd')
	})

	it('0 continues a count and is a motion on its own', () => {
		expect(out('abcdefghijklm|n', '10h')).toBe('abc|defghijklmn')
		expect(out('abc|d', '0')).toBe('|abcd')
	})

	it('G and gg go to a line, with a count to that line', () => {
		expect(out('a|b\ncd\nef', 'G')).toBe('ab\ncd\n|ef')
		expect(out('ab\ncd\ne|f', 'gg')).toBe('|ab\ncd\nef')
		expect(out('ab\ncd\ne|f', '2G')).toBe('ab\n|cd\nef')
		expect(out('ab\ncd\ne|f', '2gg')).toBe('ab\n|cd\nef')
		expect(out('ab\ncd\ne|f', '9G')).toBe('ab\ncd\n|ef')
	})

	it('w and W by word class', () => {
		expect(out('|foo.bar baz', 'w')).toBe('foo|.bar baz')
		expect(out('|foo.bar baz', 'W')).toBe('foo.bar |baz')
		expect(out('|foo.bar baz', 'ww')).toBe('foo.|bar baz')
		expect(out('|foo bar baz', '2w')).toBe('foo bar |baz')
		expect(out('|foo\nbar', 'w')).toBe('foo\n|bar')
		expect(out('foo|\n\nbar', 'w')).toBe('foo\n|\nbar')
		expect(out('foo\n|\nbar', 'w')).toBe('foo\n\n|bar')
		expect(out('ba|r', 'w')).toBe('ba|r')
	})

	it('a letter with an accent, a digit and an underscore are all word characters', () => {
		expect(out('|café_9 x', 'w')).toBe('café_9 |x')
		expect(out('|über-x', 'w')).toBe('über|-x')
	})

	it('b and B', () => {
		expect(out('foo.bar ba|z', 'b')).toBe('foo.bar |baz')
		expect(out('foo.bar |baz', 'b')).toBe('foo.|bar baz')
		expect(out('foo.bar |baz', 'B')).toBe('|foo.bar baz')
		expect(out('foo\n|bar', 'b')).toBe('|foo\nbar')
		expect(out('|abc', 'b')).toBe('|abc')
		expect(out('foo\n\n|bar', 'b')).toBe('foo\n|\nbar')
	})

	it('e and E', () => {
		expect(out('|foo.bar baz', 'e')).toBe('fo|o.bar baz')
		expect(out('fo|o.bar baz', 'e')).toBe('foo|.bar baz')
		expect(out('|foo.bar baz', 'E')).toBe('foo.ba|r baz')
		expect(out('foo|\nbar', 'e')).toBe('foo\nba|r')
		expect(out('ba|r', 'e')).toBe('ba|r')
	})

	it('f, F, t, T, then ; and ,', () => {
		expect(out('|a.b.c.d', 'f.')).toBe('a|.b.c.d')
		expect(out('|a.b.c.d', '2f.')).toBe('a.b|.c.d')
		expect(out('a.b.c.|d', 'F.')).toBe('a.b.c|.d')
		expect(out('|a.b.c.d', 't.')).toBe('|a.b.c.d')
		expect(out('|ab.cd', 't.')).toBe('a|b.cd')
		expect(out('ab.cd|e', 'T.')).toBe('ab.|cde')
		expect(out('|a.b.c.d', 'f.;')).toBe('a.b|.c.d')
		expect(out('|a.b.c.d', 'f.;,')).toBe('a|.b.c.d')
		expect(out('|a.b.c.d', 't.;')).toBe('a.|b.c.d')
		expect(out('|abc', 'fz')).toBe('|abc')
		expect(out('|ab\ncd.', 'f.')).toBe('|ab\ncd.')
	})

	it('% finds the matching bracket, from the first one at or after the cursor', () => {
		expect(out('|(a[b]c)', '%')).toBe('(a[b]c|)')
		expect(out('(a[b]c|)', '%')).toBe('|(a[b]c)')
		expect(out('x |(a)', '%')).toBe('x (a|)')
		expect(out('|(a', '%')).toBe('|(a')
		expect(out('|(a)', '2%')).toBe('|(a)')
		expect(out('|abc', '%')).toBe('|abc')
	})

	it('j on the last line and k on the first ask for history', () => {
		expect(run('a|b', 'k').effects).toEqual(['history-up'])
		expect(run('a|b', 'j').effects).toEqual(['history-down'])
		expect(run('a|b\ncd', 'k').effects).toEqual(['history-up'])
		expect(run('ab\nc|d', 'j').effects).toEqual(['history-down'])
		expect(run('a|b\ncd', 'j').effects).toEqual([])
	})

	it('gj and gk are j and k without history', () => {
		expect(out('a|b\ncd', 'gj')).toBe('ab\nc|d')
		expect(run('a|b', 'gk').effects).toEqual([])
	})
})

describe('delete, change, yank', () => {
	it('x deletes to the end of the line and the cursor stays on a character', () => {
		expect(out('a|bc', 'x')).toBe('a|c')
		expect(out('ab|c', 'x')).toBe('a|b')
		expect(out('a|bcd', '2x')).toBe('a|d')
		expect(out('a|bc', '9x')).toBe('|a')
		expect(out('|', 'x')).toBe('|')
		expect(out('a|b\n\ncd', 'x')).toBe('|a\n\ncd')
		expect(out('ab\n|\ncd', 'x')).toBe('ab\n|\ncd')
	})

	it('dd deletes whole lines, and on the last line moves up', () => {
		expect(out('ab\nc|d\nef', 'dd')).toBe('ab\n|ef')
		expect(out('ab\ncd\ne|f', 'dd')).toBe('ab\n|cd')
		expect(out('a|b', 'dd')).toBe('|')
		expect(out('a|b\ncd\nef', '2dd')).toBe('|ef')
		expect(out('a|b\ncd', '5dd')).toBe('|')
		expect(out('  a|b\n  cd', 'dd')).toBe('  |cd')
	})

	it('D and C act to the end of the line', () => {
		expect(out('a|bc\nde', 'D')).toBe('|a\nde')
		expect(out('ab|c\nde', 'D')).toBe('a|b\nde')
	})

	it('dw, de, db, d$, d0, d^', () => {
		expect(out('|foo bar', 'dw')).toBe('|bar')
		expect(out('foo |bar baz', 'dw')).toBe('foo |baz')
		expect(out('|foo bar', 'de')).toBe('| bar')
		expect(out('foo b|ar', 'db')).toBe('foo |ar')
		expect(out('fo|o bar', 'd$')).toBe('f|o')
		expect(out('foo b|ar', 'd0')).toBe('|ar')
		expect(out('  fo|o', 'd^')).toBe('  |o')
		expect(out('a |b c', '2dw')).toBe('a| ')
	})

	it('dw on the last word of a line does not join the next line', () => {
		expect(out('foo |bar\nbaz', 'dw')).toBe('foo| \nbaz')
		expect(out('|foo\nbar', 'dw')).toBe('|\nbar')
	})

	it('dw on the last word of the draft deletes to the end', () => {
		expect(out('foo b|ar', 'dw')).toBe('foo |b')
	})

	it('cw is ce on a word, and changes only the blank on blanks', () => {
		expect(out('|foo bar', 'cwX<Esc>')).toBe('|X bar')
		expect(out('fo|o bar', 'cwX<Esc>')).toBe('fo|X bar')
		expect(out('foo| bar', 'cwX<Esc>')).toBe('foo|Xbar')
		expect(out('|foo bar baz', '2cwX<Esc>')).toBe('|X baz')
	})

	it('dj, dk, dG, dgg are linewise', () => {
		expect(out('a|b\ncd\nef', 'dj')).toBe('|ef')
		expect(out('ab\nc|d\nef', 'dk')).toBe('|ef')
		expect(out('ab\nc|d\nef', 'dG')).toBe('|ab')
		expect(out('ab\nc|d\nef', 'dgg')).toBe('|ef')
	})

	it('df, dt, dF, dT, dh, dl, d%', () => {
		expect(out('|a.b.c', 'df.')).toBe('|b.c')
		expect(out('|a.b.c', 'dt.')).toBe('|.b.c')
		expect(out('a.b|.c', 'dF.')).toBe('a|.c')
		expect(out('a|bc', 'dl')).toBe('a|c')
		expect(out('a|bc', 'dh')).toBe('|bc')
		expect(out('|(a b) c', 'd%')).toBe('| c')
		expect(out('|abc', 'dfz')).toBe('|abc')
	})

	it('a failed motion changes nothing and cancels the operator', () => {
		expect(out('|abc', 'dh')).toBe('|abc')
		expect(out('|abc', 'dhx')).toBe('|bc')
		expect(out('|abc', 'd;')).toBe('|abc')
	})

	it('yy, yw, y$ yank and leave the text', () => {
		const r = run('a|b cd\nef', 'yw')
		expect(r.out).toBe('a|b cd\nef')
		expect(r.state.register).toEqual({ text: 'b ', linewise: false })
		const line = run('ab\nc|d', 'yy')
		expect(line.state.register).toEqual({ text: 'cd\n', linewise: true })
		expect(line.out).toBe('ab\nc|d')
		expect(run('ab\nc|d', 'kyj').out).toBe('a|b\ncd')
		expect(run('a|bcd', 'y$').state.register.text).toBe('bcd')
		expect(run('ab\n|cd\nef', 'Y').state.register.text).toBe('cd\n')
	})

	it('the cursor goes to the start of what was yanked', () => {
		expect(out('ab c|d', 'yb')).toBe('ab |cd')
	})

	it('counts multiply: 2d3w equals 6dw', () => {
		const text = '|a b c d e f g h'
		expect(out(text, '2d3w')).toBe(out(text, '6dw'))
		expect(out(text, '2d3w')).toBe('|g h')
		expect(out('|a b c d', 'd2w')).toBe('|c d')
	})

	it('text objects', () => {
		expect(out('foo b|ar baz', 'diw')).toBe('foo | baz')
		expect(out('foo b|ar baz', 'daw')).toBe('foo |baz')
		expect(out('foo bar b|az', 'daw')).toBe('foo ba|r')
		expect(out('f.o b|ar', 'diW')).toBe('f.o| ')
		expect(out('a "b|c d" e', 'di"')).toBe('a "|" e')
		expect(out('a "b|c d" e', 'da"')).toBe('a |e')
		expect(out("a 'b|c' e", "ci'X<Esc>")).toBe("a '|X' e")
		expect(out('a `b|c` e', 'di`')).toBe('a `|` e')
		expect(out('f(a, |b)', 'di(')).toBe('f(|)')
		expect(out('f(a, |b)', 'da(')).toBe('|f')
		expect(out('f(a, |b)', 'dib')).toBe('f(|)')
		expect(out('x [a |b] y', 'di[')).toBe('x [|] y')
		expect(out('x {a |b} y', 'di}')).toBe('x {|} y')
		expect(out('x {a |b} y', 'diB')).toBe('x {|} y')
		expect(out('x <a |b> y', 'di<')).toBe('x <|> y')
		expect(out('((a|))', 'di(')).toBe('((|))')
		expect(out('((a|))', 'd2i(')).toBe('(|)')
	})

	it('a quote text object finds the pair after the cursor, and ignores an escaped quote', () => {
		expect(out('|a "bc" d', 'di"')).toBe('a "|" d')
		expect(out('"a\\"b|c"', 'di"')).toBe('"|"')
	})

	it('a text object that is not there changes nothing', () => {
		expect(out('a|bc', 'di(')).toBe('a|bc')
		expect(out('a|bc', 'di"')).toBe('a|bc')
		expect(out('a|bc', 'diz')).toBe('a|bc')
	})

	it('a text object across lines', () => {
		expect(out('f(a,\n|b)', 'di(')).toBe('f(|)')
	})

	it('yank with a text object leaves the cursor at its start', () => {
		const r = run('foo b|ar baz', 'yiw')
		expect(r.out).toBe('foo |bar baz')
		expect(r.state.register.text).toBe('bar')
	})
})

describe('put, join, replace, case, indent', () => {
	it('p and P with characters', () => {
		expect(out('|ab cd', 'dwp')).toBe('cab| d')
		expect(out('|ab', 'xp')).toBe('b|a')
		expect(out('a|b', 'xP')).toBe('|ba')
		expect(out('|ab', 'ylp')).toBe('a|ab')
		expect(out('|a', 'yl3p')).toBe('aaa|a')
		expect(out('|ab', 'p')).toBe('|ab')
	})

	it('p and P with lines', () => {
		expect(out('a|b\ncd', 'yyp')).toBe('ab\n|ab\ncd')
		expect(out('a|b\ncd', 'yyP')).toBe('|ab\nab\ncd')
		expect(out('a|b\ncd', 'yy2p')).toBe('ab\n|ab\nab\ncd')
		expect(out('a|b\ncd', 'jddP')).toBe('|cd\nab')
		expect(out('a|b', 'yyp')).toBe('ab\n|ab')
		expect(out('  a|b', 'yyp')).toBe('  ab\n  |ab')
	})

	it('p of text with a newline puts the cursor at its start', () => {
		const s = run('a|b\ncd', 'ylj').state
		expect(s.register.text).toBe('b')
		const multi = run('|ab\ncd', 'vjy$p').out
		expect(multi.includes('\n')).toBe(true)
	})

	it('the register is shared by delete, change and yank, and holds the last of them', () => {
		expect(run('|ab cd', 'dwyw').state.register.text).toBe('cd')
		expect(run('|ab cd', 'ywdw').state.register.text).toBe('ab ')
		expect(run('|ab cd', 'cwX<Esc>').state.register.text).toBe('ab')
		expect(run('|ab', 'x').state.register.text).toBe('a')
	})

	it('J joins lines with one space', () => {
		expect(out('a|b\ncd', 'J')).toBe('ab| cd')
		expect(out('a|b\n  cd\nef', '3J')).toBe('ab cd| ef')
		expect(out('ab \ncd', 'J')).toBe('ab |cd')
		expect(out('a|b', 'J')).toBe('a|b')
		expect(out('a|b\n\nc', 'J')).toBe('a|b\nc')
	})

	it('r replaces count characters, and does nothing past the end of the line', () => {
		expect(out('a|bc', 'rX')).toBe('a|Xc')
		expect(out('|abc', '2rX')).toBe('X|Xc')
		expect(out('|abc', '5rX')).toBe('|abc')
		expect(out('|', 'rX')).toBe('|')
		expect(out('a|bc', 'r<Esc>')).toBe('a|bc')
	})

	it('~ toggles case and moves on', () => {
		expect(out('|aBc', '~')).toBe('A|Bc')
		expect(out('|aBc', '3~')).toBe('Ab|C')
		expect(out('a|b', '~')).toBe('a|B')
	})

	it('> and < shift lines', () => {
		expect(out('a|b\ncd', '>>')).toBe('  |ab\ncd')
		expect(out('a|b\ncd', '>j')).toBe('  |ab\n  cd')
		expect(out('  a|b', '<<')).toBe('|ab')
		expect(out('\ta|b', '<<')).toBe('|ab')
		expect(out('a|b\n\ncd', '3>>')).toBe('  |ab\n\n  cd')
	})
})

describe('undo, history, search', () => {
	it('u asks the host to undo', () => {
		expect(run('a|b', 'u').effects).toEqual(['undo'])
	})

	it('/ opens the history search and goes to INSERT', () => {
		const r = run('a|b', '/')
		expect(r.effects).toEqual(['history-search'])
		expect(r.state.mode).toBe('INSERT')
	})

	it("Ctrl+R and the other ctrl keys are not the machine's, so redo does not exist", () => {
		expect(run('a|b', '<C-r>').unhandled).toBe(1)
	})
})

describe('dot repeat', () => {
	it('repeats x, dd, dw, p, J, r, ~, >>', () => {
		expect(out('|abcd', 'x.')).toBe('|cd')
		expect(out('|a\nb\nc\nd', 'dd.')).toBe('|c\nd')
		expect(out('|a b c d', 'dw.')).toBe('|c d')
		expect(out('|ab', 'xp.')).toBe('ba|a')
		expect(out('|a\nb\nc\nd', 'J.')).toBe('a b| c\nd')
		expect(out('|abcd', 'rX.')).toBe('|Xbcd')
		expect(out('|ab\ncd', '>>j.')).toBe('  ab\n  |cd')
	})

	it('repeats an insert with the text that was typed', () => {
		expect(out('|', 'ia<Esc>.')).toBe('|aa')
		expect(out('x|y', 'ahi<Esc>j.')).toBe(out('x|y', 'ahi<Esc>.'))
		expect(out('|a\nb', 'Ax<Esc>j.')).toBe('ax\nb|x')
		expect(out('|a', 'ox<Esc>.')).toBe('a\nx\n|x')
		expect(out('|abc def', 'cwX<Esc>w.')).toBe('X |X')
	})

	it('a count on . replaces the recorded count', () => {
		expect(out('|abcdefg', 'x3.')).toBe('|efg')
		expect(out('|a b c d e f', 'dw2.')).toBe('|d e f')
	})

	it('does not repeat a yank or a motion, and does nothing with no change yet', () => {
		expect(out('|abc', '.')).toBe('|abc')
		expect(out('|abc', 'xyl.')).toBe('|c')
		expect(out('|abc', 'xl.')).toBe('|b')
	})

	it('repeats a change through a text object and a find', () => {
		expect(out('|a.b.c.d', 'df..')).toBe('|c.d')
		expect(out('x "a" "b|"', 'ci"Z<Esc>')).toBe('x "a" "|Z"')
		expect(out('"a|" "b"', 'ci"Z<Esc>f"f"ci"Z<Esc>')).toBe('"Z" "|Z"')
	})
})

describe('VISUAL', () => {
	it('v selects, o swaps ends, Escape leaves', () => {
		const r = run('a|bcd', 'vl')
		expect(vimSelection(r.state, 'abcd', 2)).toEqual([1, 3])
		expect(run('a|bcd', 'vl<Esc>').state.mode).toBe('NORMAL')
		const swapped = run('a|bcd', 'vlo')
		expect(swapped.out).toBe('a|bcd')
		expect(vimSelection(swapped.state, 'abcd', 1)).toEqual([1, 3])
	})

	it('v again leaves, V switches to lines', () => {
		expect(run('a|b', 'vv').state.mode).toBe('NORMAL')
		expect(run('a|b', 'vV').state.mode).toBe('VISUAL LINE')
		expect(run('a|b', 'Vv').state.mode).toBe('VISUAL')
		expect(run('a|b', 'VV').state.mode).toBe('NORMAL')
	})

	it('d, x and Delete delete the selection and fill the register', () => {
		expect(out('a|bcd', 'vld')).toBe('a|d')
		expect(out('a|bcd', 'vlx')).toBe('a|d')
		expect(out('a|bcd', 'vl<Del>')).toBe('a|d')
		expect(run('a|bcd', 'vld').state.register.text).toBe('bc')
	})

	it('c and s delete and insert', () => {
		expect(out('a|bcd', 'vlcX<Esc>')).toBe('a|Xd')
		expect(out('a|bcd', 'vlsX<Esc>')).toBe('a|Xd')
	})

	it('y yanks and goes to the start', () => {
		const r = run('a|bcd', 'vly')
		expect(r.out).toBe('a|bcd')
		expect(r.state.register.text).toBe('bc')
		expect(run('a|bcd', 'vly').state.mode).toBe('NORMAL')
		expect(out('abc|d', 'vhhy')).toBe('a|bcd')
	})

	it('VISUAL LINE works on whole lines', () => {
		expect(out('a|b\ncd\nef', 'Vd')).toBe('|cd\nef')
		expect(out('a|b\ncd\nef', 'Vjd')).toBe('|ef')
		expect(run('a|b\ncd', 'Vy').state.register).toEqual({ text: 'ab\n', linewise: true })
		expect(out('a|b\ncd', 'VcX<Esc>')).toBe('|X\ncd')
	})

	it('Y, X, D act on the selected lines, C S R change them', () => {
		expect(run('a|b\ncd', 'vlY').state.register.linewise).toBe(true)
		expect(out('a|b\ncd', 'vX')).toBe('|cd')
		expect(out('a|b\ncd', 'vD')).toBe('|cd')
		expect(out('a|b\ncd', 'vCX<Esc>')).toBe('|X\ncd')
	})

	it('r replaces each selected character but not the break', () => {
		expect(out('a|bc\nde', 'vjrX')).toBe('a|XX\nXX')
	})

	it('~, u and U change case', () => {
		expect(out('a|bC', 'vl~')).toBe('a|Bc')
		expect(out('a|BC', 'vlu')).toBe('a|bc')
		expect(out('a|bc', 'vlU')).toBe('a|BC')
	})

	it('> and < shift the selected lines, J joins them', () => {
		expect(out('a|b\ncd\nef', 'Vj>')).toBe('  |ab\n  cd\nef')
		expect(out('  a|b\n  cd', 'Vj<')).toBe('|ab\ncd')
		expect(out('a|b\ncd\nef', 'VjJ')).toBe('ab| cd\nef')
		expect(out('a|b\ncd', 'vJ')).toBe('ab| cd')
	})

	it('p replaces the selection and the replaced text becomes the register', () => {
		const r = run('|ab cd', 'ywwviwp')
		expect(r.out).toBe('ab |ab ')
		expect(r.state.register.text).toBe('cd')
		const again = run('|ab cd', 'ywwviwP')
		expect(again.out).toBe(r.out)
	})

	it('i and a with an object select it', () => {
		expect(out('x "a|b" y', 'vi"d')).toBe('x "|" y')
		expect(out('x foo b|ar', 'viwd')).toBe('x foo| ')
		expect(out('f(a, |b)', 'vi(d')).toBe('f(|)')
		expect(out('f(a, |b)', 'va(d')).toBe('|f')
	})

	it('motions, counts, $ and find work in VISUAL', () => {
		expect(vimSelection(run('|abcdef', 'v3l').state, 'abcdef', 3)).toEqual([0, 4])
		expect(vimSelection(run('|abc\nde', 'v$').state, 'abc\nde', 2)).toEqual([0, 3])
		expect(out('|a.b.c', 'vf.d')).toBe('|b.c')
		expect(out('|ab cd', 'vwd')).toBe('|d')
	})

	it('the cursor never rests on the line break', () => {
		const r = run('|ab\ncd', 'vlll')
		expect(r.out).toBe('a|b\ncd')
	})

	it('Enter in VISUAL is j and the arrows are motions', () => {
		expect(out('a|b\ncd', 'v<Down>')).toBe('ab\nc|d')
	})

	it('a selection on an empty draft is empty and harmless', () => {
		expect(out('|', 'vd')).toBe('|')
		expect(vimSelection(run('|', 'v').state, '', 0)).toEqual([0, 0])
	})
})

describe('counts', () => {
	it('stop at 10000', () => {
		const text = `${'a'.repeat(20)}|`
		expect(out(text, '99999999h')).toBe(`|${'a'.repeat(20)}`)
	})

	it('a count before an operator and a count after it multiply', () => {
		expect(out('|a b c d e f', '2d2w')).toBe('|e f')
	})

	it('a key that is not a command is swallowed and clears the pending count', () => {
		expect(run('a|bc', '3z').unhandled).toBe(0)
		expect(out('a|bc', '3zx')).toBe('a|c')
		expect(out('a|bc', 'Zx')).toBe('a|c')
	})
})

describe('multi-line drafts and edges', () => {
	it('an empty draft takes every key without throwing', () => {
		for (const keys of [
			'x',
			'dd',
			'dw',
			'p',
			'J',
			'u',
			'w',
			'b',
			'e',
			'$',
			'0',
			'G',
			'yy',
			'D',
			'C<Esc>',
			'~',
			'rX',
			'.',
			'vd',
			'Vd',
		]) {
			expect(() => run('|', keys)).not.toThrow()
		}
		expect(out('|', 'ix<Esc>')).toBe('|x')
	})

	it('the cursor is clamped onto a character at the end of each line', () => {
		expect(out('abc\nde|', 'k$')).toBe('ab|c\nde')
		expect(out('ab|c\nde', 'x')).toBe('a|b\nde')
	})

	it('dd on the first of two lines leaves the second', () => {
		expect(out('|ab\ncd', 'dd')).toBe('|cd')
	})

	it('emoji and combined characters are one step', () => {
		const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
		const accented = String.fromCodePoint(0x65, 0x301)
		expect(out(`|${family}a`, 'x')).toBe('|a')
		expect(out(`|${family}a`, 'l')).toBe(`${family}|a`)
		expect(out(`${accented}|a`, 'h')).toBe(`|${accented}a`)
	})

	it('typing in INSERT and leaving remembers nothing about positions it did not see', () => {
		const r = run('ab|c', 'iX<Esc>')
		expect(r.out).toBe('ab|Xc')
	})

	it('d$, c$ and y$ on an empty line change nothing and leave the register alone', () => {
		expect(out('a\n|\nb', 'd$')).toBe('a\n|\nb')
		expect(out('a\n|\nb', 'c$')).toBe('a\n|\nb')
		const yanked = run('a\n|\nb', 'y$')
		expect(yanked.out).toBe('a\n|\nb')
		expect(yanked.state.register.text).toBe('')
		expect(out('a\n|\nb', 'y$p')).toBe('a\n|\nb')
	})

	it('a command that does nothing is not what . repeats', () => {
		expect(out('|a b c d', 'dwdk.')).toBe('|c d')
		expect(out('|a b c d', 'dwdfz.')).toBe('|c d')
		// A replace past the end of the line does nothing; the one before it is still repeated.
		expect(out('|abc', 'rxl5rq.')).toBe('x|xc')
	})

	it('a half-typed command is dropped when Enter is not taken', () => {
		const r = vimKey({ ...createVimState(), mode: 'NORMAL', pending: ['d'] }, 'abc', 0, {
			key: 'Enter',
		})
		expect(r.handled).toBe(false)
		expect(r.state.pending).toEqual([])
	})

	it('a marker is one unit for a yank', () => {
		const text = 'ab [Pasted text #1 +12 lines]cd'
		const chips = [{ start: 3, end: 29 }]
		let r = vimKeys(
			{ ...createVimState(), mode: 'NORMAL' },
			text,
			3,
			[{ key: 'y' }, { key: 'w' }],
			chips,
		)
		expect(r.state.register.text.startsWith('[Pasted text #1 +12 lines]')).toBe(true)
		r = vimKeys(r.state, text, 3, [{ key: 'l' }, { key: 'y' }, { key: 'l' }], chips)
		expect(r.state.register.text).toBe('[Pasted text #1 +12 lines]')
	})
})
