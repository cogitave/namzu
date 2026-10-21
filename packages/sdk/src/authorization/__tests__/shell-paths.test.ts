import { describe, expect, it } from 'vitest'

import { readShellLine, shellPathAccess } from '../shell-paths.js'

function uses(line: string) {
	const access = shellPathAccess(readShellLine(line, 'bash'))
	return access.uses.map((u) => `${u.access}:${u.via}:${u.path}${u.unresolved ? '?' : ''}`)
}

describe('the paths a shell line names', () => {
	it('reads the operands of the read commands', () => {
		expect(uses('cat /etc/passwd')).toEqual(['read:cat:/etc/passwd'])
		// The reference drops every flag before the first operand and keeps the
		// rest, so a flag's own value (`5`) is listed too; it is a relative name.
		expect(uses('head -n 5 a.txt b.txt')).toEqual([
			'read:head:5',
			'read:head:a.txt',
			'read:head:b.txt',
		])
		expect(uses('ls')).toEqual(['read:ls:.'])
		expect(uses('ls -la /var/log')).toEqual(['read:ls:/var/log'])
		expect(uses('wc -l -- -odd')).toEqual(['read:wc:-odd'])
		expect(uses('cd /tmp')).toEqual(['read:cd:/tmp'])
		expect(uses('cd')).toEqual(['read:cd:~'])
	})

	it('reads the files of grep, not its pattern', () => {
		expect(uses('grep -n foo src/a.ts')).toEqual(['read:grep:src/a.ts'])
		expect(uses('grep -r foo')).toEqual(['read:grep:.'])
		expect(uses('grep -e foo -e bar /etc/hosts')).toEqual(['read:grep:/etc/hosts'])
		expect(uses('rg foo ../other')).toEqual(['read:rg:../other'])
		expect(uses('rg foo')).toEqual(['read:rg:.'])
	})

	it('reads find starting points and the paths its tests name', () => {
		expect(uses('find / -name x')).toEqual(['read:find:/'])
		expect(uses('find -name x')).toEqual(['read:find:.'])
		expect(uses('find src -newer /etc/hosts')).toEqual(['read:find:src', 'read:find:/etc/hosts'])
	})

	it('treats the writing commands as writes', () => {
		expect(uses('touch a b')).toEqual(['write:touch:a', 'write:touch:b'])
		expect(uses('mkdir -p ~/x/y')).toEqual(['write:mkdir:~/x/y'])
		expect(uses('cp -r a.txt ~/.bashrc')).toEqual(['write:cp:a.txt', 'write:cp:~/.bashrc'])
		expect(uses('mv a b')).toEqual(['write:mv:a', 'write:mv:b'])
		expect(uses('rm -rf build')).toEqual(['write:rm:build'])
		expect(uses('tee out.log /dev/null')).toEqual(['write:tee:out.log'])
	})

	it('reads sed as a write only when it edits in place', () => {
		expect(uses("sed -n 'p' a.txt")).toEqual(['read:sed:a.txt'])
		expect(uses("sed -i 's/a/b/' a.txt")).toEqual(['write:sed:a.txt'])
		expect(uses("sed -i.bak 's/a/b/' a.txt")).toEqual(['write:sed:a.txt'])
		expect(uses("sed --in-place=.orig 's/a/b/' a.txt")).toEqual(['write:sed:a.txt'])
		expect(uses("sed -e 's/a/b/' -f script.sed a.txt")).toEqual([
			'read:sed:script.sed',
			'read:sed:a.txt',
		])
	})

	it('reads output redirections as writes and input redirections as reads', () => {
		expect(uses('echo x > ~/.profile')).toEqual(['write:redirect:~/.profile'])
		expect(uses('echo x >> out.log')).toEqual(['write:redirect:out.log'])
		expect(uses('echo x &> all.log')).toEqual(['write:redirect:all.log'])
		expect(uses('sort < /etc/passwd')).toEqual(['read:redirect:/etc/passwd'])
	})

	it('leaves descriptor duplication and the harmless devices alone', () => {
		expect(uses('make 2>&1')).toEqual([])
		expect(uses('make >&2')).toEqual([])
		expect(uses('make > /dev/null 2>&1')).toEqual([])
		expect(uses('cat /dev/stdin')).toEqual([])
	})

	it('unwraps the wrappers in front of a command', () => {
		expect(uses('sudo cat /etc/shadow')).toEqual(['read:cat:/etc/shadow'])
		expect(uses('env A=1 nice -n 5 cat /etc/shadow')).toEqual(['read:cat:/etc/shadow'])
		expect(uses('timeout 5 touch ~/.zshrc')).toEqual(['write:touch:~/.zshrc'])
	})

	it('finds a command in each part of a compound line and in a nested shell', () => {
		expect(uses('true && cat /etc/passwd; touch a')).toEqual([
			'read:cat:/etc/passwd',
			'write:touch:a',
		])
		expect(uses('bash -c "cat /etc/passwd"')).toEqual(['read:cat:/etc/passwd'])
		expect(uses('find . -exec cp {} ~/.bashrc ;')).toContain('write:cp:~/.bashrc')
	})

	it('marks a target decided at runtime', () => {
		expect(uses('touch "$OUT"')).toEqual(['write:touch:$OUT?'])
		expect(uses('echo x > "$LOG"')).toEqual(['write:redirect:$LOG?'])
		expect(uses('echo x > $(mktemp)')).toEqual(['write:redirect:$(mktemp)?'])
	})

	it('ignores commands outside the table', () => {
		expect(uses('node script.js /etc/passwd')).toEqual([])
		expect(uses('curl https://example.com -o /etc/x')).toEqual([])
	})

	it('tells the caller a cd ran', () => {
		expect(shellPathAccess(readShellLine('cd sub && touch a', 'bash')).changesDirectory).toBe(true)
		expect(shellPathAccess(readShellLine('touch a', 'bash')).changesDirectory).toBe(false)
	})

	it('reads the files git diff and git grep name', () => {
		expect(uses('git diff -- /etc/hosts')).toEqual(['read:git:/etc/hosts'])
		expect(uses('git status')).toEqual([])
	})

	it('stops reading flags at an unknown one, as the reference does for fold and its kin', () => {
		expect(uses('fold -w 5 a.txt')).toEqual(['read:fold:a.txt'])
		expect(uses('cut -d , -f 1 a.csv')).toEqual(['read:cut:a.csv'])
	})
})

describe('where a relative path starts after a cd', () => {
	const directories = (line: string) =>
		shellPathAccess(readShellLine(line, 'bash')).uses.map((u) => [
			u.path,
			u.directory === undefined
				? 'start'
				: 'relative' in u.directory
					? u.directory.relative
					: 'unknown',
		])

	it('follows a literal relative cd, chained, for the commands and redirections after it', () => {
		expect(directories('cd a && touch f > g')).toEqual([
			['a', 'start'],
			['f', 'a'],
			['g', 'a'],
		])
		expect(directories('cd a && cd b && touch f')).toEqual([
			['a', 'start'],
			['b', 'a'],
			['f', 'a/b'],
		])
		expect(directories('touch f && cd a')).toEqual([
			['f', 'start'],
			['a', 'start'],
		])
	})

	it('reads a cd it cannot follow as unknown, and stays unknown', () => {
		for (const line of [
			'cd "$X" && touch f',
			'cd /abs && touch f',
			'cd ~ && touch f',
			'cd - && touch f',
			'cd && touch f',
			'pushd a && touch f',
			'cd a b && touch f',
		]) {
			expect(directories(line).at(-1)?.[1], line).toBe('unknown')
		}
		expect(directories('cd "$X" && cd a && touch f').at(-1)?.[1]).toBe('unknown')
	})

	it('skips cd flags and treats a redirection it cannot tie to a command as unknown after a cd', () => {
		expect(directories('cd -P a && touch f').at(-1)).toEqual(['f', 'a'])
		expect(directories('cd a; { echo x; } > out').at(-1)).toEqual(['out', 'unknown'])
	})
})
